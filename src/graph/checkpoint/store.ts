import { CheckpointSchemaError } from "../errors.js";
import type { ApprovalDecision, WorkflowRun } from "../types.js";

/**
 * The right to write a run record. `token` is a fencing token: every
 * acquisition issues a higher one, and a write is accepted only with the
 * latest token while it is unexpired by the store's clock.
 */
export interface Lease {
  readonly runId: string;
  readonly ownerId: string;
  readonly token: number;
  /** When the lease expires, by the store's clock. */
  readonly expiresAt: number;
}

export type CasResult = "ok" | "revision-conflict" | "lease-lost";

/** What `recordDecision` did: the first decision per request wins, and is returned either way. */
export interface DecisionResult {
  readonly outcome: "recorded" | "already-decided";
  readonly decision: ApprovalDecision;
}

/**
 * Durable storage for run records, leases and cancel requests. Implementations
 * must pass the shared contract suite (`test/checkpoint-contract.ts`).
 *
 * Every run-record write is a fenced compare-and-swap, checked atomically with
 * the write, in this order:
 * 1. the lease's token is the latest issued for the run, its owner matches and
 *    it has not been released, and it is unexpired by the store's clock;
 *    otherwise `"lease-lost"`;
 * 2. the stored revision equals `expectedRevision`; otherwise `"revision-conflict"`.
 *
 * Cancel requests and approval decisions live in separate control records
 * that anyone may write without a lease; only the lease holder turns them into
 * run-record changes. Records are copied in and out: callers never share
 * objects with the store.
 *
 * `recordDecision` and `loadDecisions` are optional so stores written before
 * approvals existed keep working for workflows without approval nodes; the
 * executor rejects approval workflows on a store without them.
 */
export interface CheckpointStore {
  /** Stores a new run and issues its first lease. Rejects if the run ID exists (`CheckpointConflictError`). */
  create(run: WorkflowRun, ownerId: string, ttlMs: number): Promise<Lease>;
  /** Rejects with `CheckpointSchemaError` for an unknown `schemaVersion`. */
  load(runId: string): Promise<WorkflowRun | undefined>;
  /** Rejects with `RunNotFoundError` if the run does not exist. */
  compareAndSwap(run: WorkflowRun, expectedRevision: number, lease: Lease): Promise<CasResult>;
  /**
   * Issues a lease with a higher token, or `undefined` while another unexpired
   * lease is held. Rejects with `RunNotFoundError` if the run does not exist.
   */
  acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined>;
  /** Extends a current, unexpired lease (same token); `undefined` if it is no longer current. */
  renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined>;
  /** Releases the lease if it is still current; otherwise does nothing. */
  releaseLease(lease: Lease): Promise<void>;
  /** Records a cancel request for the lease holder to act on. Rejects with `RunNotFoundError`. */
  requestCancel(runId: string): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
  /** Removes the run, its lease state and its control records. Never touches artifacts. */
  delete(runId: string): Promise<void>;
  /**
   * Stores a decision for `decision.requestId` unless one exists: atomic
   * insert-if-absent, so concurrent approvers cannot both win. Needs no lease.
   * Rejects with `RunNotFoundError` if the run does not exist.
   */
  recordDecision?(runId: string, decision: ApprovalDecision): Promise<DecisionResult>;
  /** Every decision recorded for the run (applied or not), in any order. */
  loadDecisions?(runId: string): Promise<ApprovalDecision[]>;
}

/** The newest checkpoint schema this version writes (see `WorkflowRun.schemaVersion`). */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** Every checkpoint schema this version reads. */
export const SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/** Throws `CheckpointSchemaError` unless the record has a supported `schemaVersion`. For store adapters. */
export function assertCheckpointSchema(run: WorkflowRun): void {
  if (!SUPPORTED_CHECKPOINT_SCHEMA_VERSIONS.includes(run.schemaVersion)) {
    throw new CheckpointSchemaError(run.runId, run.schemaVersion);
  }
}
