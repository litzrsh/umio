import { CheckpointConflictError, RunNotFoundError } from "../errors.js";
import type { ApprovalDecision, WorkflowRun } from "../types.js";
import {
  assertCheckpointSchema,
  type CasResult,
  type CheckpointStore,
  type DecisionResult,
  type Lease,
} from "./store.js";

interface Entry {
  record: WorkflowRun;
  /** The latest token issued for the run. */
  token: number;
  /** The current lease, if held and not released (it may have expired). */
  lease?: { ownerId: string; token: number; expiresAt: number };
  cancelRequested: boolean;
  /** Approval decisions by request ID. */
  decisions: Map<string, ApprovalDecision>;
}

export interface MemoryCheckpointStoreOptions {
  /** The store's clock for lease expiry. Default `Date.now`. */
  now?(): number;
}

/**
 * The reference `CheckpointStore`, held in process memory: runs do not survive
 * a restart. Each method's checks and write happen in one synchronous step,
 * which JavaScript's run-to-completion makes atomic.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: MemoryCheckpointStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async create(run: WorkflowRun, ownerId: string, ttlMs: number): Promise<Lease> {
    assertCheckpointSchema(run);
    if (this.entries.has(run.runId)) {
      throw new CheckpointConflictError(run.runId, `Run "${run.runId}" already exists.`);
    }
    const expiresAt = this.now() + ttlMs;
    this.entries.set(run.runId, {
      record: structuredClone(run),
      token: 1,
      lease: { ownerId, token: 1, expiresAt },
      cancelRequested: false,
      decisions: new Map(),
    });
    return { runId: run.runId, ownerId, token: 1, expiresAt };
  }

  async load(runId: string): Promise<WorkflowRun | undefined> {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    assertCheckpointSchema(entry.record);
    return structuredClone(entry.record);
  }

  async compareAndSwap(
    run: WorkflowRun,
    expectedRevision: number,
    lease: Lease,
  ): Promise<CasResult> {
    const entry = this.require(run.runId);
    if (!this.isCurrent(entry, lease)) return "lease-lost";
    if (entry.record.revision !== expectedRevision) return "revision-conflict";
    assertCheckpointSchema(run);
    entry.record = structuredClone(run);
    return "ok";
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined> {
    const entry = this.require(runId);
    const now = this.now();
    if (entry.lease && entry.lease.expiresAt > now) return undefined;
    entry.token += 1;
    entry.lease = { ownerId, token: entry.token, expiresAt: now + ttlMs };
    return { runId, ...entry.lease };
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined> {
    const entry = this.entries.get(lease.runId);
    if (!entry || !this.isCurrent(entry, lease)) return undefined;
    entry.lease = { ownerId: lease.ownerId, token: lease.token, expiresAt: this.now() + ttlMs };
    return { runId: lease.runId, ...entry.lease };
  }

  async releaseLease(lease: Lease): Promise<void> {
    const entry = this.entries.get(lease.runId);
    if (entry?.lease?.token === lease.token && entry.lease.ownerId === lease.ownerId) {
      entry.lease = undefined;
    }
  }

  async requestCancel(runId: string): Promise<void> {
    this.require(runId).cancelRequested = true;
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    return this.entries.get(runId)?.cancelRequested ?? false;
  }

  async recordDecision(runId: string, decision: ApprovalDecision): Promise<DecisionResult> {
    const { decisions } = this.require(runId);
    const existing = decisions.get(decision.requestId);
    if (existing) return { outcome: "already-decided", decision: structuredClone(existing) };
    decisions.set(decision.requestId, structuredClone(decision));
    return { outcome: "recorded", decision: structuredClone(decision) };
  }

  async loadDecisions(runId: string): Promise<ApprovalDecision[]> {
    return structuredClone([...(this.entries.get(runId)?.decisions.values() ?? [])]);
  }

  async delete(runId: string): Promise<void> {
    this.entries.delete(runId);
  }

  private require(runId: string): Entry {
    const entry = this.entries.get(runId);
    if (!entry) throw new RunNotFoundError(runId);
    return entry;
  }

  /** The lease is the latest issued, still held by its owner, and unexpired. */
  private isCurrent(entry: Entry, lease: Lease): boolean {
    // A held lease always carries the latest token, so matching it checks both.
    return (
      entry.lease?.token === lease.token &&
      entry.lease.ownerId === lease.ownerId &&
      entry.lease.expiresAt > this.now()
    );
  }
}
