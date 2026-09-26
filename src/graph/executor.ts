import type { UmioConfig } from "../config/schema.js";
import { LLMError, UmioError } from "../errors.js";
import { MemoryCheckpointStore } from "./checkpoint/memory.js";
import type { CheckpointStore, Lease } from "./checkpoint/store.js";
import {
  CheckpointConflictError,
  DefinitionMismatchError,
  GraphNodeError,
  LeaseLostError,
  LeaseUnavailableError,
  RecoveryNotApplicableError,
  RunNotFoundError,
  RunNotResumableError,
} from "./errors.js";
import { definitionHash } from "./identity.js";
import { ObserverQueue } from "./observer.js";
import { checkOutput } from "./output.js";
import {
  abandonAttempt,
  allNodesDone,
  applyDecision,
  applyRecovery,
  approvalOutput,
  cancelAttempt,
  closeOpenNodes,
  completeNode,
  createRun,
  decideEdges,
  decisionCompletes,
  evaluatePredicate,
  failNode,
  finalizeCancel,
  finishRun,
  firstFailedNode,
  hasUncertain,
  inputNodes,
  newlySkipped,
  nextIteration,
  nextRetryAt,
  orphanedNodes,
  parkRun,
  pauseRun,
  predecessorOutputs,
  predicateError,
  readyNodes,
  recordLoopDecision,
  recoverOrphans,
  rejectOutput,
  requestApproval,
  retryNode,
  startAttempt,
  startLoop,
  waitingNodes,
} from "./plan.js";
import { retryDelay, shouldRetry } from "./retry.js";
import { type RuntimeDependencies, withDefaults } from "./runtime.js";
import {
  type ExpandedGraph,
  expandGraph,
  iterationOutput,
  iterationState,
  nodeKind,
} from "./structure.js";
import type {
  ApprovalAck,
  ApprovalDecision,
  CancelAck,
  GraphRunEvent,
  JsonValue,
  LoopOutput,
  NodeContext,
  NodeError,
  NodeEvent,
  NodeId,
  NodeRun,
  NodeSpec,
  PendingApproval,
  RecoveryAction,
  RunObserver,
  RunStatus,
  WorkflowDefinition,
  WorkflowRun,
} from "./types.js";
import { isJsonValue, validateDefinition } from "./validate.js";
import { emitWarnings, shortProviderTimeouts } from "./warnings.js";

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
export const DEFAULT_NODE_TIMEOUT_MS = 10_800_000; // 3 h
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;
export const DEFAULT_CANCEL_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_CANCEL_GRACE_MS = 10_000;
export const DEFAULT_OBSERVER_DRAIN_TIMEOUT_MS = 5_000;
const MAX_ERROR_MESSAGE = 1_000;
const MAX_DECISION_COMMENT = 2_000;

export interface WorkflowExecutorOptions {
  /**
   * Where run records, leases and cancel requests live. Default: a
   * `MemoryCheckpointStore` owned by this executor (runs end with the process).
   */
  store?: CheckpointStore;
  /**
   * Nodes running at once. Default 4; 1 is recommended for a single local model.
   * Note that it does not limit model calls made inside one node (parallel tool
   * calls); the provider's `maxConcurrentRequests` does.
   */
  maxConcurrency?: number;
  /** Largest checkpointed node output, in UTF-8 bytes of JSON. Default 256 KiB. */
  maxOutputBytes?: number;
  /**
   * Wall-clock limit per attempt, unless a node sets `timeoutMs`. Default 3 h;
   * `null` disables it. On expiry the attempt's signal aborts; see `cancelGraceMs`.
   */
  nodeTimeoutMs?: number | null;
  /**
   * How long a lease stays valid without renewal. Default 30 s: after a crash,
   * another executor can take over the run this long after the last renewal.
   */
  leaseTtlMs?: number;
  /** How often the lease is renewed, on its own timer. Default 10 s; must be below half of `leaseTtlMs`. */
  leaseRenewIntervalMs?: number;
  /** How often the store is polled for a cancel request. Default 2 s; must be below `leaseTtlMs`. */
  cancelPollIntervalMs?: number;
  /**
   * How long an attempt may take to stop after its signal aborts (timeout,
   * cancel or run failure) before it is abandoned and its node becomes
   * `uncertain`. Default 10 s; must be below `leaseTtlMs`.
   */
  cancelGraceMs?: number;
  /** How long a finished run waits for its observer to receive queued events. Default 5 s. */
  observerDrainTimeoutMs?: number;
}

export interface GraphRunOptions {
  readonly runId?: string;
  /** Overrides the executor's `maxConcurrency` for this run. */
  readonly maxConcurrency?: number;
  /** Aborting it cancels the run, like `cancel()`. */
  readonly signal?: AbortSignal;
  /** Receives run and node events, in order, without ever delaying the run. */
  readonly observer?: RunObserver;
  /** Called when the observer throws or rejects. Default: the error is dropped. */
  readonly onObserverError?: (error: unknown, event: GraphRunEvent) => void;
}

/** `invalidOutput`: the handler returned, but its output failed the checks. */
type Outcome =
  | { ok: true; output: JsonValue }
  | { ok: false; error: NodeError; invalidOutput?: true };

type Halt = { kind: "failed"; nodeId: NodeId; error: NodeError } | { kind: "cancelled" };

/** Why a running attempt was asked to stop. */
type StopReason = "timeout" | "failed" | "cancelled";

interface RunningAttempt {
  attempt: number;
  controller: AbortController;
  settled: Promise<{ nodeId: NodeId; attempt: number; outcome: Outcome }>;
  /** Timers to cancel when the attempt settles or is abandoned. */
  timers: (() => void)[];
  stop?: { reason: StopReason; error: NodeError };
  /** Set when the grace period after `stop` ran out. */
  abandoned?: boolean;
}

interface DriveOptions {
  maxConcurrency: number;
  queue: ObserverQueue;
  signal: AbortSignal | undefined;
}

/**
 * Runs workflow definitions: validation, definition identity, branching
 * (predicates), joins, skip propagation, bounded concurrency, retries with
 * backoff, node timeouts and cancellation, checkpointing every change to a
 * `CheckpointStore` so another executor can resume the run after a crash.
 *
 * Every change to the run record goes through `commit()`, a compare-and-swap
 * fenced by this executor's lease (I1). Results are applied one at a time by
 * the scheduling loop, never from inside handler or timer callbacks, so writes
 * are serialized even with concurrent nodes. The lease is renewed, the store
 * polled for cancel requests and node timeouts measured on timers of their
 * own, independent of handler activity, so a long silent model call never
 * looks like a dead executor.
 */
export class WorkflowExecutor {
  private readonly deps: RuntimeDependencies;
  private readonly store: CheckpointStore;
  /** Identifies this executor as a lease owner. */
  private readonly ownerId: string;
  private readonly maxConcurrency: number;
  private readonly maxOutputBytes: number;
  /** The node timeout applied when a node does not set `timeoutMs`. */
  readonly nodeTimeoutMs: number | null;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly cancelPollIntervalMs: number;
  private readonly cancelGraceMs: number;
  private readonly observerDrainTimeoutMs: number;
  /** Runs this executor is driving: run ID → notice a cancel request or a decision. */
  private readonly active = new Map<string, { cancel(): void; decide(): void }>();

  constructor(options: WorkflowExecutorOptions = {}, dependencies?: Partial<RuntimeDependencies>) {
    this.deps = withDefaults(dependencies);
    this.maxConcurrency = positiveInt(
      options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      "maxConcurrency",
    );
    this.maxOutputBytes = positiveInt(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    const nodeTimeoutMs =
      options.nodeTimeoutMs === undefined ? DEFAULT_NODE_TIMEOUT_MS : options.nodeTimeoutMs;
    this.nodeTimeoutMs =
      nodeTimeoutMs === null ? null : positiveInt(nodeTimeoutMs, "nodeTimeoutMs");
    this.leaseTtlMs = positiveInt(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "leaseTtlMs");
    this.leaseRenewIntervalMs = positiveInt(
      options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS,
      "leaseRenewIntervalMs",
    );
    this.cancelPollIntervalMs = positiveInt(
      options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS,
      "cancelPollIntervalMs",
    );
    this.cancelGraceMs = nonNegativeInt(
      options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      "cancelGraceMs",
    );
    this.observerDrainTimeoutMs = nonNegativeInt(
      options.observerDrainTimeoutMs ?? DEFAULT_OBSERVER_DRAIN_TIMEOUT_MS,
      "observerDrainTimeoutMs",
    );
    // Two renewals fit in one TTL; the poll and grace waits never outlive the lease (D12).
    below(this.leaseRenewIntervalMs * 2, this.leaseTtlMs, "leaseRenewIntervalMs × 2");
    below(this.cancelPollIntervalMs, this.leaseTtlMs, "cancelPollIntervalMs");
    below(this.cancelGraceMs, this.leaseTtlMs, "cancelGraceMs");
    this.store = options.store ?? new MemoryCheckpointStore({ now: this.deps.now });
    this.ownerId = this.deps.newId();
  }

  /**
   * Creates an executor from the config's `graph` section. Precedence, highest
   * first: `GraphRunOptions` → `options` here → the config file → built-in defaults.
   *
   * When the config has models and providers, a local provider whose request
   * timeout is below the node timeout produces a process warning (D12).
   */
  static fromConfig(
    config: Pick<UmioConfig, "graph"> & Partial<Pick<UmioConfig, "models" | "providers">>,
    options: WorkflowExecutorOptions = {},
    dependencies?: Partial<RuntimeDependencies>,
  ): WorkflowExecutor {
    // `checkpoint` selects the CLI's store; library callers pass `store`.
    const { checkpoint: _, ...graph } = config.graph ?? {};
    const executor = new WorkflowExecutor(
      { ...definedOnly(graph), ...definedOnly(options) },
      dependencies,
    );
    if (config.models && config.providers) {
      emitWarnings(
        shortProviderTimeouts(
          { models: config.models, providers: config.providers },
          executor.nodeTimeoutMs,
        ),
      );
    }
    return executor;
  }

  /**
   * Runs a definition until it is terminal (`completed`, `failed`,
   * `cancelled`) or parked (`needs-recovery`, after an abandoned attempt), and
   * resolves with the run record: a node failure is data, not an exception.
   * Rejects for invalid definitions, input or options, and when the executor
   * cannot continue safely (lease lost, checkpoint conflict, store errors).
   */
  async run(
    definition: WorkflowDefinition,
    input: JsonValue,
    options: GraphRunOptions = {},
  ): Promise<WorkflowRun> {
    validateDefinition(definition);
    this.checkStoreSupports(definition);
    if (!isJsonValue(input)) throw new UmioError("Run input must be a JSON value.");
    const maxConcurrency = positiveInt(
      options.maxConcurrency ?? this.maxConcurrency,
      "maxConcurrency",
    );

    const initial = createRun({
      definition,
      definitionHash: definitionHash(definition),
      runId: options.runId ?? this.deps.newId(),
      input,
      now: this.deps.now(),
    });
    const lease = await this.store.create(initial, this.ownerId, this.leaseTtlMs); // W0
    const queue = new ObserverQueue(options.observer, options.onObserverError);
    queue.push({ type: "run-start", runId: initial.runId, at: this.deps.now() });
    return this.drive(definition, initial, lease, {
      maxConcurrency,
      queue,
      signal: options.signal,
    });
  }

  /**
   * Cancels a run, wherever it is owned (plan D10):
   *
   * - `requested`: the request is recorded, and the live owner (this executor
   *   or another) stops the run within about `cancelPollIntervalMs`, plus up to
   *   `cancelGraceMs` for handlers that ignore their abort signal.
   * - `cancelled`: nobody owned the run (its owner crashed and its lease
   *   expired, or it was parked), so this call finalized it: nodes left running
   *   become `uncertain`, since their effects may have happened.
   * - `already-terminal` or `not-found`: nothing to do.
   */
  async cancel(runId: string): Promise<CancelAck> {
    try {
      const record = await this.store.load(runId);
      if (!record) return { runId, outcome: "not-found" };
      if (isTerminal(record.status)) {
        return { runId, outcome: "already-terminal", status: record.status };
      }
      await this.store.requestCancel(runId);
      const local = this.active.get(runId);
      if (local) {
        local.cancel();
        return { runId, outcome: "requested", status: record.status };
      }
      const lease = await this.store.acquireLease(runId, this.ownerId, this.leaseTtlMs);
      if (!lease) return { runId, outcome: "requested", status: record.status };
      try {
        const current = await this.store.load(runId);
        if (!current) return { runId, outcome: "not-found" };
        if (isTerminal(current.status)) {
          return { runId, outcome: "already-terminal", status: current.status };
        }
        await this.write(current, finalizeCancel(current, this.deps.now()), lease); // W7
        return { runId, outcome: "cancelled", status: "cancelled" };
      } finally {
        await this.release(lease);
      }
    } catch (error) {
      if (error instanceof RunNotFoundError) return { runId, outcome: "not-found" };
      throw error;
    }
  }

  /**
   * Continues a run another executor left unfinished, e.g. after a crash. Pass
   * the same definition (graph ID, version and structure) with fresh handlers.
   *
   * - A pending cancel request is honored first: the run ends `cancelled`,
   *   and attempts the previous owner left running become `uncertain` (W7).
   * - Otherwise those attempts become `uncertain`, or pending again for nodes
   *   with `recovery: "retry"` and attempts left (W6). A run with an uncertain
   *   node resolves as `needs-recovery` without starting anything; resolve
   *   each such node with `recoverNode()`, then call `resume()` again.
   * - A `paused` run continues once a decision is recorded for one of its
   *   waiting approvals (the decision is applied first); without one it
   *   resolves `paused` again without writing.
   * - Otherwise the run is scheduled as by `run()`; completed nodes never re-run.
   *
   * Rejects with `RunNotFoundError`, `RunNotResumableError` (terminal),
   * `DefinitionMismatchError` or `LeaseUnavailableError` (still owned; a
   * crashed owner's lease expires within `leaseTtlMs`).
   */
  async resume(
    definition: WorkflowDefinition,
    runId: string,
    options: Omit<GraphRunOptions, "runId"> = {},
  ): Promise<WorkflowRun> {
    validateDefinition(definition);
    this.checkStoreSupports(definition);
    const maxConcurrency = positiveInt(
      options.maxConcurrency ?? this.maxConcurrency,
      "maxConcurrency",
    );
    let { record, lease } = await this.takeOver(definition, runId, [
      "running",
      "paused",
      "needs-recovery",
    ]);
    const queue = new ObserverQueue(options.observer, options.onObserverError);
    queue.push({ type: "run-resume", runId, at: this.deps.now() });

    if (await this.store.isCancelRequested(runId)) {
      record = await this.write(record, finalizeCancel(record, this.deps.now()), lease); // W7
      await this.release(lease);
      queue.push({ type: "run-finish", runId, status: "cancelled", at: this.deps.now() });
      await queue.drain(this.observerDrainTimeoutMs, this.deps);
      return record;
    }
    if (orphanedNodes(record).length > 0) {
      record = await this.write(
        record,
        recoverOrphans(expandGraph(definition.graph, record).graph, record, this.deps.now()),
        lease,
      ); // W6
    }
    if (record.status === "paused" && !(await this.hasDecisionFor(record))) {
      // Still waiting for a person: nothing to do, nothing written.
      await this.release(lease);
      queue.push(pausedEvent(record, this.deps.now()));
      await queue.drain(this.observerDrainTimeoutMs, this.deps);
      return record;
    }
    if (record.status === "needs-recovery") {
      await this.release(lease);
      queue.push(needsRecoveryEvent(record, this.deps.now()));
      await queue.drain(this.observerDrainTimeoutMs, this.deps);
      return record;
    }
    return this.drive(definition, record, lease, {
      maxConcurrency,
      queue,
      signal: options.signal,
    });
  }

  /**
   * Resolves an `uncertain` node of a `needs-recovery` run, after you have
   * checked what its interrupted attempt actually did (its side effects are
   * keyed by `idempotencyKey`). A node whose handler returned an invalid
   * output (`uncertainReason: "invalid-output"`, e.g. over `maxOutputBytes`)
   * is resolved the same way, typically with `complete` and an `ArtifactRef`
   * to the result. It never starts attempts: call `resume()` afterwards to
   * continue the run.
   *
   * - `retry`: the node runs again on resume, even beyond its retry budget.
   * - `complete`: the node completes with `output` (checked like a handler's)
   *   and its edges are decided, as if its attempt had succeeded.
   * - `fail`: the node and the run fail.
   *
   * A pending cancel request wins: the run is cancelled instead (W7).
   */
  async recoverNode(
    definition: WorkflowDefinition,
    runId: string,
    nodeId: NodeId,
    action: RecoveryAction,
  ): Promise<WorkflowRun> {
    validateDefinition(definition);
    const { record, lease } = await this.takeOver(definition, runId, ["needs-recovery"]);
    try {
      if (await this.store.isCancelRequested(runId)) {
        return await this.write(record, finalizeCancel(record, this.deps.now()), lease); // W7
      }
      const decisions = this.recoveryDecisions(definition, record, nodeId, action);
      return await this.write(
        record,
        applyRecovery(
          expandGraph(definition.graph, record).graph,
          record,
          nodeId,
          action,
          decisions,
          this.deps.now(),
        ),
        lease,
      ); // W8
    } finally {
      // Released on every path, so a failed call never blocks the next one until
      // the lease expires. Nothing runs under it, and a write that may have
      // landed is re-read by the next owner. A release error never masks the
      // original one.
      await this.release(lease);
    }
  }

  /**
   * The run's approval requests awaiting a decision, with their context (the
   * outputs of the approval node's predecessors, from the record) and any
   * decision recorded but not yet applied. Rejects with `RunNotFoundError`.
   */
  async pendingApprovals(runId: string): Promise<PendingApproval[]> {
    const record = await this.store.load(runId);
    if (!record) throw new RunNotFoundError(runId);
    return pendingApprovalsOf(record, await this.decisionsFor(record, true));
  }

  /**
   * Records an approval for a waiting request, from any process: `target` is
   * the approval node's checkpoint ID (e.g. `review` or `refine#2/review`) or
   * the request ID. The first decision per request wins (`already-decided`
   * returns it). The live owner applies it within about
   * `cancelPollIntervalMs`; a `paused` run continues on `resume()`. The
   * decision is applied to the run at most once.
   */
  approve(
    runId: string,
    target: string,
    options: { decidedBy?: string; comment?: string } = {},
  ): Promise<ApprovalAck> {
    return this.decide(runId, target, true, options);
  }

  /** Records a rejection; see `approve()`. What it does depends on the node's `onReject`. */
  reject(
    runId: string,
    target: string,
    options: { decidedBy?: string; comment?: string } = {},
  ): Promise<ApprovalAck> {
    return this.decide(runId, target, false, options);
  }

  private async decide(
    runId: string,
    target: string,
    approved: boolean,
    options: { decidedBy?: string; comment?: string },
  ): Promise<ApprovalAck> {
    const recordDecision = this.store.recordDecision?.bind(this.store);
    if (!recordDecision) throw unsupportedStore();
    for (const [name, value] of Object.entries(options)) {
      if (value !== undefined && typeof value !== "string") {
        throw new UmioError(`${name} must be a string.`);
      }
    }
    try {
      const record = await this.store.load(runId);
      if (!record) return { runId, outcome: "not-found" };
      if (isTerminal(record.status)) {
        return { runId, outcome: "already-terminal", status: record.status };
      }
      const node = Object.values(record.nodes).find(
        (item) =>
          item.approval !== undefined &&
          (item.nodeId === target || item.approval.requestId === target),
      );
      if (!node?.approval) return { runId, outcome: "not-pending", status: record.status };
      if (node.status !== "waiting") {
        const applied = appliedDecision(node);
        return applied
          ? { runId, outcome: "already-decided", decision: applied, status: record.status }
          : { runId, outcome: "not-pending", status: record.status };
      }
      const decision: ApprovalDecision = {
        requestId: node.approval.requestId,
        nodeId: node.nodeId,
        approved,
        decidedAt: this.deps.now(),
        ...(options.decidedBy !== undefined && { decidedBy: options.decidedBy.slice(0, 200) }),
        ...(options.comment !== undefined && {
          comment: options.comment.slice(0, MAX_DECISION_COMMENT),
        }),
      };
      const result = await recordDecision(runId, decision);
      this.active.get(runId)?.decide();
      return { runId, outcome: result.outcome, decision: result.decision, status: record.status };
    } catch (error) {
      if (error instanceof RunNotFoundError) return { runId, outcome: "not-found" };
      throw error;
    }
  }

  /** Recorded decisions by request ID. A failed read counts as none unless `strict` (the poll retries). */
  private async decisionsFor(
    record: WorkflowRun,
    strict = false,
  ): Promise<Map<string, ApprovalDecision>> {
    const decisions = new Map<string, ApprovalDecision>();
    if (!this.store.loadDecisions || waitingNodes(record).length === 0) return decisions;
    try {
      for (const decision of await this.store.loadDecisions(record.runId)) {
        decisions.set(decision.requestId, decision);
      }
    } catch (error) {
      if (strict) throw error;
    }
    return decisions;
  }

  private async hasDecisionFor(record: WorkflowRun): Promise<boolean> {
    const decisions = await this.decisionsFor(record);
    return waitingNodes(record).some(
      (node) => node.approval && decisions.has(node.approval.requestId),
    );
  }

  /** Approval workflows need a store that keeps decisions. */
  private checkStoreSupports(definition: WorkflowDefinition): void {
    const approvals = definition.graph.nodes.some(
      (node) =>
        node.approval !== undefined || node.loop?.body.nodes.some((inner) => inner.approval),
    );
    if (approvals && (!this.store.recordDecision || !this.store.loadDecisions)) {
      throw unsupportedStore();
    }
  }

  /** Checks a recovery action against the run and, for `complete`, decides the node's edges. */
  private recoveryDecisions(
    definition: WorkflowDefinition,
    record: WorkflowRun,
    nodeId: NodeId,
    action: RecoveryAction,
  ): Record<string, boolean> {
    const { runId } = record;
    const node = record.nodes[nodeId];
    if (node?.status !== "uncertain") {
      throw new RecoveryNotApplicableError(
        runId,
        nodeId,
        node
          ? `Node "${nodeId}" of run "${runId}" is ${node.status}, not uncertain.`
          : `Run "${runId}" has no node "${nodeId}".`,
      );
    }
    const view = expandGraph(definition.graph, record);
    const spec = view.graph.nodes.find((item) => item.id === nodeId);
    if (action.type === "retry" && spec && nodeKind(spec) === "loop") {
      throw new RecoveryNotApplicableError(
        runId,
        nodeId,
        `Loop node "${nodeId}" cannot be retried: its iterations already ran. Complete it with a verified output, or fail it.`,
      );
    }
    if (action.type !== "complete") return {};
    const invalid = checkOutput(action.output, {
      maxOutputBytes: spec?.maxOutputBytes ?? this.maxOutputBytes,
      nodeId,
      idempotencyKey: `${runId}:${nodeId}`,
    });
    if (invalid) throw new RecoveryNotApplicableError(runId, nodeId, invalid.message);
    const decided = decideEdges(view.graph, definition.predicates, record, nodeId, action.output);
    if (!decided.ok) throw new RecoveryNotApplicableError(runId, nodeId, decided.error.message);
    return decided.decisions;
  }

  /**
   * Resume steps 1–4 (plan §5): load and check the run and its definition,
   * acquire the lease, and reload under it.
   */
  private async takeOver(
    definition: WorkflowDefinition,
    runId: string,
    statuses: readonly RunStatus[],
  ): Promise<{ record: WorkflowRun; lease: Lease }> {
    const check = (record: WorkflowRun | undefined): WorkflowRun => {
      if (!record) throw new RunNotFoundError(runId);
      checkIdentity(definition, record);
      if (!statuses.includes(record.status)) {
        throw new RunNotResumableError(
          runId,
          record.status,
          statuses.includes("running")
            ? undefined
            : `Run "${runId}" is ${record.status}; recoverNode needs a needs-recovery run (call resume() first).`,
        );
      }
      return record;
    };
    check(await this.store.load(runId));
    const lease = await this.store.acquireLease(runId, this.ownerId, this.leaseTtlMs);
    if (!lease) throw new LeaseUnavailableError(runId, this.leaseTtlMs);
    try {
      return { record: check(await this.store.load(runId)), lease };
    } catch (error) {
      await this.release(lease);
      throw error;
    }
  }

  /** A fenced compare-and-swap of `next` over `current`; returns `next` once written. */
  private async write(current: WorkflowRun, next: WorkflowRun, lease: Lease): Promise<WorkflowRun> {
    const result = await this.store.compareAndSwap(next, current.revision, lease);
    if (result === "ok") return next;
    throw result === "lease-lost"
      ? new LeaseLostError(current.runId)
      : new CheckpointConflictError(
          current.runId,
          `Run "${current.runId}" changed under a valid lease (expected revision ${current.revision}).`,
        );
  }

  private async release(lease: Lease): Promise<void> {
    try {
      await this.store.releaseLease(lease);
    } catch {
      // What had to be written is written; an unreleased lease just expires.
    }
  }

  /** Whether a cancel request is recorded; a failed read counts as no (the poll retries). */
  private async cancelPending(runId: string): Promise<boolean> {
    try {
      return await this.store.isCancelRequested(runId);
    } catch {
      return false;
    }
  }

  /**
   * Owns a run until it is terminal or parked: schedules nodes, applies their
   * results, retries, times out and abandons attempts, and keeps the lease.
   * Rejects with `LeaseLostError` or `CheckpointConflictError` (or a store
   * error) after aborting running attempts, stopping its timers and writing
   * nothing more (I6).
   *
   * Shutdown order (D6): the terminal or parking write, then timers stop and
   * the lease is released, then the observer queue drains, then it resolves.
   */
  private async drive(
    definition: WorkflowDefinition,
    initial: WorkflowRun,
    firstLease: Lease,
    { maxConcurrency, queue, signal }: DriveOptions,
  ): Promise<WorkflowRun> {
    const { runId } = initial;
    const now = () => this.deps.now();
    let record = initial;
    // The flat graph for the current record: loop iterations appear as they start.
    let view = expandGraph(definition.graph, record);
    let lease = firstLease;
    const running = new Map<NodeId, RunningAttempt>();
    // Set by timers and callbacks; acted on by the scheduling loop, which `wake` interrupts.
    let fatal: Error | undefined;
    let cancelRequested = false;
    // Decisions are read at the start, by the poll while a request waits, and after a local approve().
    let decisionsDue = true;
    let wake = deferred();
    let cancelRetryTimer = () => {};
    // A resumed run may already have a failed node (a crash before W5): finish it as failed.
    const failed = firstFailedNode(view.graph, initial);
    // (Asserted: closures assign it, which control-flow narrowing cannot see.)
    let halt = (failed ? { kind: "failed", ...failed } : undefined) as Halt | undefined;

    const commit = async (next: WorkflowRun) => {
      if (fatal) throw fatal;
      record = await this.write(record, next, lease);
      view = expandGraph(definition.graph, record);
    };
    const specOf = (nodeId: NodeId): NodeSpec | undefined =>
      view.graph.nodes.find((node) => node.id === nodeId);
    const finished = (nodeId: NodeId, status: NodeFinishStatus) =>
      queue.push({
        type: "node-finish",
        runId,
        nodeId,
        attempt: record.nodes[nodeId]?.attempt ?? 0,
        status,
        at: now(),
      });
    const reportSkips = (before: WorkflowRun) => {
      for (const skipped of newlySkipped(before, record)) finished(skipped, "skipped");
    };
    const loseLease = () => {
      fatal ??= new LeaseLostError(runId);
      wake.resolve();
    };
    const noticeCancel = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      queue.push({ type: "run-cancel-requested", runId, at: now() });
      wake.resolve();
    };
    const noticeDecision = () => {
      decisionsDue = true;
      wake.resolve();
    };
    const clearTimers = (entry: RunningAttempt) => {
      for (const stop of entry.timers.splice(0)) stop();
    };
    // Aborts an attempt's signal and gives it `cancelGraceMs` to settle before
    // it is abandoned. The first reason wins.
    const stopAttempt = (entry: RunningAttempt, reason: StopReason, error: NodeError) => {
      if (entry.stop) return;
      entry.stop = { reason, error };
      entry.controller.abort(
        reason === "timeout"
          ? new GraphNodeError(error.message, { code: error.code, retryable: error.retryable })
          : new UmioError(error.message),
      );
      entry.timers.push(
        this.deps.setTimer(this.cancelGraceMs, () => {
          entry.abandoned = true;
          wake.resolve();
        }),
      );
    };
    const startHalt = (next: Halt) => {
      // The first decision wins (I9). Running attempts are asked to stop;
      // results that still arrive are recorded, but nothing new starts.
      halt = next;
      const message =
        next.kind === "failed"
          ? `Run stopped: node "${next.nodeId}" failed.`
          : `Run "${runId}" cancelled.`;
      for (const entry of running.values()) {
        stopAttempt(entry, next.kind, { code: next.kind, message, retryable: false });
      }
    };
    const failWith = async (next: WorkflowRun, nodeId: NodeId, error: NodeError) => {
      await commit(failNode(next, nodeId, error, now()));
      finished(nodeId, "failed");
      if (!halt) startHalt({ kind: "failed", nodeId, error });
    };
    /** Starts an attempt's handler and timers and adds it to `running`. */
    const launch = (nodeId: NodeId, attempt: number): void => {
      const spec = specOf(nodeId);
      const startedAt = now();
      const entry: RunningAttempt = {
        attempt,
        controller: new AbortController(),
        timers: [],
        // Assigned below: the handler's callbacks need `entry` to exist first.
        settled: Promise.resolve() as never,
      };
      const timeoutMs = spec?.timeoutMs === undefined ? this.nodeTimeoutMs : spec.timeoutMs;
      if (timeoutMs !== null) {
        entry.timers.push(
          this.deps.setTimer(timeoutMs, () =>
            stopAttempt(entry, "timeout", timeoutError(nodeId, `timed out after ${timeoutMs} ms`)),
          ),
        );
      }
      // Inactivity: re-armed lazily for the remaining time, so frequent events cost nothing.
      let lastProgress = startedAt;
      const inactivityMs = spec?.inactivityTimeoutMs;
      if (inactivityMs !== undefined) {
        let cancel = () => {};
        const arm = (ms: number) => {
          cancel = this.deps.setTimer(ms, () => {
            const idle = now() - lastProgress;
            if (idle < inactivityMs) return arm(inactivityMs - idle);
            stopAttempt(
              entry,
              "timeout",
              timeoutError(nodeId, `made no progress for ${inactivityMs} ms`),
            );
          });
        };
        arm(inactivityMs);
        entry.timers.push(() => cancel());
      }
      running.set(nodeId, entry); // before the handler runs, so its first events count
      entry.settled = this.invoke(definition, view, record, nodeId, attempt, {
        signal: entry.controller.signal,
        ...(timeoutMs !== null && { deadline: startedAt + timeoutMs }),
        onEvent: (event) => {
          if (running.get(nodeId) !== entry) return; // abandoned or settled: no longer reported
          lastProgress = now();
          queue.push({ type: "node-event", runId, nodeId, attempt, event, at: lastProgress });
        },
      }).then((outcome) => ({ nodeId, attempt, outcome }));
    };

    /**
     * W10: applies recorded decisions to waiting approval nodes. Each applies
     * once: the node stops `waiting` in the same write. Returns whether any did.
     */
    const applyDecisions = async (): Promise<boolean> => {
      decisionsDue = false;
      if (waitingNodes(record).length === 0) return false;
      const decisions = await this.decisionsFor(record);
      let applied = false;
      for (const node of waitingNodes(record)) {
        const decision = node.approval && decisions.get(node.approval.requestId);
        if (!decision || halt) continue;
        const current = record.nodes[node.nodeId];
        if (current?.status !== "waiting") continue;
        let edges: Record<string, boolean> = {};
        if (decisionCompletes(current, decision)) {
          const output = approvalOutput(decision) as unknown as JsonValue;
          const decided = decideEdges(
            view.graph,
            definition.predicates,
            record,
            node.nodeId,
            output,
          );
          if (!decided.ok) {
            await failWith(
              { ...record, status: record.status === "paused" ? "running" : record.status },
              node.nodeId,
              decided.error,
            );
            applied = true;
            continue;
          }
          edges = decided.decisions;
        }
        const before = record;
        await commit(applyDecision(view.graph, record, node.nodeId, decision, edges, now()));
        applied = true;
        const after = record.nodes[node.nodeId];
        if (after?.status === "completed") {
          finished(node.nodeId, "completed");
          reportSkips(before);
        } else {
          finished(node.nodeId, "failed");
          if (!halt && after?.error)
            startHalt({ kind: "failed", nodeId: node.nodeId, error: after.error });
        }
      }
      return applied;
    };

    /**
     * W13: for each loop whose current iteration finished, evaluates `until`
     * once and records it together with the next iteration, or completes (or
     * fails) the loop node.
     */
    const advanceLoops = async (): Promise<void> => {
      for (const top of definition.graph.nodes) {
        const loop = top.loop;
        const state = record.nodes[top.id];
        if (!loop || state?.status !== "running" || !state.loop || halt) continue;
        const { iteration, decisions } = state.loop;
        if (decisions.length >= iteration || iterationState(top, record, iteration) !== "done") {
          continue;
        }
        const output = iterationOutput(top, record, iteration);
        const until = evaluatePredicate(definition.predicates[loop.until], output, record.input);
        if (!until.ok) {
          await failWith(
            record,
            top.id,
            predicateError(`Loop "${top.id}": until predicate "${loop.until}"`, until.reason),
          );
          continue;
        }
        if (!until.value && iteration < loop.maxIterations) {
          await commit(nextIteration(definition.graph, record, top.id, now()));
          queue.push({
            type: "loop-iteration",
            runId,
            nodeId: top.id,
            iteration: iteration + 1,
            at: now(),
          });
          continue;
        }
        const decided = recordLoopDecision(record, top.id, until.value);
        const exhausted = !until.value;
        if (exhausted && (loop.onExhausted ?? "fail") === "fail") {
          await failWith(decided, top.id, {
            code: "loop-exhausted",
            message: `Loop "${top.id}" ran ${loop.maxIterations} iterations without its until condition holding.`,
            retryable: false,
          });
          continue;
        }
        const result: LoopOutput = { iterations: iteration, exhausted, outputs: output };
        const invalid = checkOutput(result, {
          maxOutputBytes: top.maxOutputBytes ?? this.maxOutputBytes,
          nodeId: top.id,
          idempotencyKey: `${runId}:${top.id}`,
        });
        if (invalid) {
          // The iterations ran; keep them, and let recoverNode supply a smaller result (W2′).
          await commit(rejectOutput(decided, top.id, invalid, now()));
          finished(top.id, "uncertain");
          continue;
        }
        const edges = decideEdges(
          view.graph,
          definition.predicates,
          record,
          top.id,
          result as unknown as JsonValue,
        );
        if (!edges.ok) {
          await failWith(decided, top.id, edges.error);
          continue;
        }
        const before = record;
        await commit(
          completeNode(
            view.graph,
            decided,
            top.id,
            result as unknown as JsonValue,
            edges.decisions,
            now(),
          ),
        );
        finished(top.id, "completed");
        reportSkips(before);
      }
    };

    const stopTimers = [
      repeat(this.deps, this.leaseRenewIntervalMs, async () => {
        try {
          const renewed = await this.store.renewLease(lease, this.leaseTtlMs);
          if (renewed) lease = renewed;
          else loseLease();
        } catch {
          // A renewal that errors is retried on the next tick; the lease counts
          // as lost once it has expired by this executor's clock.
          if (this.deps.now() >= lease.expiresAt) loseLease();
        }
      }),
      repeat(this.deps, this.cancelPollIntervalMs, async () => {
        if (!cancelRequested && (await this.cancelPending(runId))) noticeCancel();
        // Decisions for waiting approvals travel on the same poll.
        if (waitingNodes(record).length > 0) noticeDecision();
      }),
    ];
    const stopAllTimers = () => {
      for (const stop of stopTimers) stop();
      cancelRetryTimer();
    };
    // A local abort is a cancel request; it is also recorded, so that it
    // survives a crash before the run is finalized (I8).
    const onAbort = () => {
      noticeCancel();
      this.store.requestCancel(runId).catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    this.active.set(runId, { cancel: noticeCancel, decide: noticeDecision });

    try {
      for (;;) {
        if (fatal) throw fatal;
        if (cancelRequested && !halt) startHalt({ kind: "cancelled" });

        // Attempts whose grace period ran out: their outcome is unknown (W4, D13).
        for (const [nodeId, entry] of [...running]) {
          if (!entry.abandoned) continue;
          running.delete(nodeId);
          clearTimers(entry);
          const spec = specOf(nodeId);
          await commit(
            abandonAttempt(
              view.graph,
              record,
              nodeId,
              abandonReason(entry.stop?.reason),
              retryDelay(spec?.retry, entry.attempt, this.deps.random),
              now(),
            ),
          );
          const node = record.nodes[nodeId];
          if (node?.status === "pending" && node.retryAt !== undefined) {
            queue.push({
              type: "node-retry",
              runId,
              nodeId,
              attempt: entry.attempt,
              retryAt: node.retryAt,
              at: now(),
            });
          } else {
            finished(nodeId, "uncertain");
          }
        }

        // No new attempts once the run is stopping or a node is uncertain (D13).
        if (!halt && !hasUncertain(record)) {
          if (decisionsDue) await applyDecisions();
          await advanceLoops();
          // Approval and loop nodes change the record without running code;
          // readiness is recomputed after each such change.
          for (let changed = true; changed && !halt && !cancelRequested; ) {
            changed = false;
            for (const nodeId of readyNodes(view.graph, record, now())) {
              if (halt || cancelRequested) break;
              const kind = view.info.get(nodeId)?.kind ?? "task";
              if (kind !== "task") {
                if (await this.cancelPending(runId)) {
                  noticeCancel();
                  break;
                }
                if (kind === "loop") {
                  await commit(startLoop(definition.graph, record, nodeId, now())); // W12
                  queue.push({ type: "loop-iteration", runId, nodeId, iteration: 1, at: now() });
                } else {
                  const requestId = this.deps.newId();
                  await commit(
                    requestApproval(
                      view.graph,
                      record,
                      nodeId,
                      { requestId, context: inputNodes(view, record, nodeId) },
                      now(),
                    ),
                  ); // W9
                  queue.push({ type: "node-waiting", runId, nodeId, requestId, at: now() });
                }
                changed = true;
                break;
              }
              if (running.size >= maxConcurrency) continue;
              // The control record is read before every start, not only by the poll (D10).
              if (await this.cancelPending(runId)) {
                noticeCancel();
                break;
              }
              await commit(startAttempt(record, nodeId, now())); // W1, before the handler
              const attempt = record.nodes[nodeId]?.attempt ?? 1;
              // A request that arrived while W1 was being written (locally, by
              // signal, or in the control record) wins: the handler never runs,
              // so the attempt is recorded as cancelled, not uncertain (W4).
              if (!cancelRequested && (await this.cancelPending(runId))) noticeCancel();
              if (cancelRequested) {
                await commit(cancelAttempt(record, nodeId, now()));
                finished(nodeId, "cancelled");
                break;
              }
              // Queued before the handler runs, so its own events follow this one.
              queue.push({ type: "node-start", runId, nodeId, attempt, at: now() });
              launch(nodeId, attempt);
            }
          }
          if (cancelRequested && !halt) continue;
        }

        if (running.size === 0) {
          if (halt) {
            const closed = closeOpenNodes(record, halt.kind, now());
            await commit(
              halt.kind === "failed"
                ? finishRun(closed.run, "failed", now(), {
                    code: halt.error.code,
                    message: halt.error.message,
                    nodeId: halt.nodeId,
                  })
                : finishRun(closed.run, "cancelled", now()),
            );
            for (const item of closed.closed) finished(item.nodeId, item.status);
          } else if (hasUncertain(record)) {
            await commit(parkRun(record, now())); // W5′
          } else if (allNodesDone(record)) {
            await commit(finishRun(record, "completed", now()));
          } else if (waitingNodes(record).length > 0 && nextRetryAt(record, now()) === undefined) {
            // Only a decision can move the run on. A last look, then pause (W11).
            if (await applyDecisions()) continue;
            await commit(pauseRun(record, now()));
          } else if (nextRetryAt(record, now()) === undefined) {
            throw new UmioError(`Run ${runId} stalled with unfinished nodes.`); // scheduler bug
          }
          if (record.status !== "running") {
            stopAllTimers();
            await this.release(lease);
            queue.push(
              record.status === "needs-recovery"
                ? needsRecoveryEvent(record, now())
                : record.status === "paused"
                  ? pausedEvent(record, now())
                  : {
                      type: "run-finish",
                      runId,
                      status: record.status as "completed" | "failed" | "cancelled",
                      at: now(),
                    },
            );
            await queue.drain(this.observerDrainTimeoutMs, this.deps);
            return record;
          }
        }

        // Wake up when the earliest scheduled retry falls due.
        cancelRetryTimer();
        cancelRetryTimer = () => {};
        const retryAt = !halt && !hasUncertain(record) ? nextRetryAt(record, now()) : undefined;
        if (retryAt !== undefined) {
          cancelRetryTimer = this.deps.setTimer(retryAt - now(), () => wake.resolve());
        }

        const settled = await Promise.race([
          ...[...running.values()].map((entry) => entry.settled),
          wake.promise.then(() => undefined),
        ]);
        if (!settled) {
          wake = deferred();
          continue;
        }
        const { nodeId, attempt } = settled;
        const entry = running.get(nodeId);
        if (entry?.attempt !== attempt) continue;
        running.delete(nodeId);
        clearTimers(entry);
        // Apply a result only while its attempt is current (I7).
        const state = record.nodes[nodeId];
        if (state?.status !== "running" || state.attempt !== attempt) continue;
        // After a timeout, whatever the attempt returns is discarded: it failed with `timeout`.
        const outcome: Outcome =
          entry.stop?.reason === "timeout"
            ? { ok: false, error: entry.stop.error }
            : settled.outcome;

        if (outcome.ok) {
          const decided = decideEdges(
            view.graph,
            definition.predicates,
            record,
            nodeId,
            outcome.output,
          );
          if (decided.ok) {
            const before = record;
            // W2: successors become ready only once this write succeeds (I2).
            await commit(
              completeNode(view.graph, record, nodeId, outcome.output, decided.decisions, now()),
            );
            finished(nodeId, "completed");
            reportSkips(before);
          } else {
            await commit(failNode(record, nodeId, decided.error, now()));
            finished(nodeId, "failed");
            if (!halt) startHalt({ kind: "failed", nodeId, error: decided.error });
          }
        } else if (outcome.invalidOutput) {
          // The handler returned, so its effects happened: park it for recoverNode (W2′).
          await commit(rejectOutput(record, nodeId, outcome.error, now()));
          finished(nodeId, "uncertain");
        } else if (halt) {
          // Stopped because the run was already failing or being cancelled (W4).
          await commit(cancelAttempt(record, nodeId, now()));
          finished(nodeId, "cancelled");
        } else {
          const policy = specOf(nodeId)?.retry;
          if (shouldRetry(policy, attempt, outcome.error)) {
            const at = now() + retryDelay(policy, attempt, this.deps.random);
            await commit(retryNode(record, nodeId, outcome.error, at, now())); // W3
            queue.push({ type: "node-retry", runId, nodeId, attempt, retryAt: at, at: now() });
          } else {
            await commit(failNode(record, nodeId, outcome.error, now())); // W3
            finished(nodeId, "failed");
            startHalt({ kind: "failed", nodeId, error: outcome.error });
          }
        }
      }
    } catch (error) {
      // Lease lost, conflict or store failure: stop everything and write nothing more.
      for (const entry of running.values()) {
        clearTimers(entry);
        entry.controller.abort(error);
      }
      stopAllTimers();
      await queue.drain(this.observerDrainTimeoutMs, this.deps);
      throw error;
    } finally {
      stopAllTimers();
      signal?.removeEventListener("abort", onAbort);
      this.active.delete(runId);
    }
  }

  private async invoke(
    definition: WorkflowDefinition,
    view: ExpandedGraph,
    record: WorkflowRun,
    nodeId: NodeId,
    attempt: number,
    options: { signal: AbortSignal; deadline?: number; onEvent(event: NodeEvent): void },
  ): Promise<Outcome> {
    const spec = view.graph.nodes.find((node) => node.id === nodeId);
    const handler = spec?.handler !== undefined ? definition.handlers[spec.handler] : undefined;
    if (!spec || !handler) {
      return {
        ok: false,
        error: {
          code: "handler-missing",
          message: `No handler for "${nodeId}".`,
          retryable: false,
        },
      };
    }
    const loop = view.info.get(nodeId)?.loop;
    const loopSpec = loop && definition.graph.nodes.find((node) => node.id === loop.id);
    const maxOutputBytes = spec.maxOutputBytes ?? this.maxOutputBytes;
    const context: NodeContext = {
      runId: record.runId,
      nodeId,
      attempt,
      input: record.input,
      // A loop body's entry nodes receive what the loop node itself received.
      predecessors: predecessorOutputs(view.graph, record, loop?.entry ? loop.id : nodeId),
      ...(loop &&
        loopSpec && {
          loop: {
            id: loop.id,
            iteration: loop.iteration,
            ...(loop.iteration > 1 && {
              previous: iterationOutput(loopSpec, record, loop.iteration - 1),
            }),
          },
        }),
      signal: options.signal,
      ...(options.deadline !== undefined && { deadline: options.deadline }),
      idempotencyKey: `${record.runId}:${nodeId}`,
      limits: { maxOutputBytes },
      emit: (event) => {
        try {
          options.onEvent(event);
        } catch {
          // Reporting progress never affects the attempt.
        }
      },
    };

    let output: unknown;
    try {
      output = await handler(context);
    } catch (error) {
      return { ok: false, error: toNodeError(error) };
    }
    const invalid = checkOutput(output, {
      maxOutputBytes,
      nodeId,
      idempotencyKey: context.idempotencyKey,
    });
    return invalid
      ? { ok: false, error: invalid, invalidOutput: true }
      : { ok: true, output: output as JsonValue };
  }
}

type NodeFinishStatus = Extract<GraphRunEvent, { type: "node-finish" }>["status"];

function timeoutError(nodeId: NodeId, what: string): NodeError {
  return { code: "timeout", message: `Node "${nodeId}" ${what}.`, retryable: true };
}

function abandonReason(reason: StopReason | undefined): AbandonReason {
  switch (reason) {
    case "timeout":
      return "abandoned-timeout";
    case "cancelled":
      return "abandoned-cancel";
    default:
      return "abandoned-failure";
  }
}

type AbandonReason = NonNullable<NodeRun["uncertainReason"]>;

function needsRecoveryEvent(record: WorkflowRun, at: number): GraphRunEvent {
  return {
    type: "run-needs-recovery",
    runId: record.runId,
    nodes: Object.values(record.nodes)
      .filter((node) => node.status === "uncertain")
      .map((node) => node.nodeId),
    at,
  };
}

function pausedEvent(record: WorkflowRun, at: number): GraphRunEvent {
  return {
    type: "run-paused",
    runId: record.runId,
    nodes: waitingNodes(record).map((node) => node.nodeId),
    at,
  };
}

function unsupportedStore(): UmioError {
  return new UmioError(
    "This checkpoint store cannot keep approval decisions (it lacks recordDecision/loadDecisions); use MemoryCheckpointStore, FileCheckpointStore or PostgresCheckpointStore.",
  );
}

/** The decision applied to an approval node, read back from its output. */
function appliedDecision(node: NodeRun): ApprovalDecision | undefined {
  const output = node.output as Record<string, JsonValue> | undefined;
  if (!node.approval || !output || typeof output.approved !== "boolean") return undefined;
  return {
    requestId: node.approval.requestId,
    nodeId: node.nodeId,
    approved: output.approved,
    decidedAt: typeof output.decidedAt === "number" ? output.decidedAt : (node.finishedAt ?? 0),
    ...(typeof output.decidedBy === "string" && { decidedBy: output.decidedBy }),
    ...(typeof output.comment === "string" && { comment: output.comment }),
  };
}

/**
 * The waiting approval requests of a run record, with their context resolved
 * from the record and any recorded decision not yet applied. Pure; used by
 * `pendingApprovals()` and by tools that read records directly (the CLI).
 */
export function pendingApprovalsOf(
  record: WorkflowRun,
  decisions: ReadonlyMap<string, ApprovalDecision> | readonly ApprovalDecision[] = [],
): PendingApproval[] {
  const byRequest =
    decisions instanceof Map
      ? decisions
      : new Map((decisions as readonly ApprovalDecision[]).map((item) => [item.requestId, item]));
  return waitingNodes(record).flatMap((node) => {
    const request = node.approval;
    if (!request) return [];
    const decision = byRequest.get(request.requestId);
    return [
      {
        runId: record.runId,
        workflowId: record.workflowId,
        runStatus: record.status,
        nodeId: node.nodeId,
        request,
        input: record.input,
        context: Object.fromEntries(
          request.context.map((id) => [id, record.nodes[id]?.output ?? null]),
        ),
        ...(decision && { decision }),
      },
    ];
  });
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function toNodeError(error: unknown): NodeError {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_MESSAGE,
  );
  if (error instanceof GraphNodeError) {
    return { code: error.code, message, retryable: error.retryable };
  }
  if (error instanceof LLMError) return { code: "llm-error", message, retryable: error.retryable };
  return { code: "handler-error", message, retryable: false };
}

/**
 * Runs `tick` every `ms`, re-arming only after the previous tick settled, so
 * ticks never overlap. `tick` must not throw. Returns a function that stops it.
 */
function repeat(deps: RuntimeDependencies, ms: number, tick: () => Promise<void>): () => void {
  let stopped = false;
  let cancel = () => {};
  const arm = () => {
    cancel = deps.setTimer(ms, () => {
      void tick().finally(() => {
        if (!stopped) arm();
      });
    });
  };
  arm();
  return () => {
    stopped = true;
    cancel();
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function checkIdentity(definition: WorkflowDefinition, run: WorkflowRun): void {
  const actual = {
    workflowId: definition.graph.id,
    definitionVersion: definition.graph.version,
    definitionHash: definitionHash(definition),
  };
  for (const field of ["workflowId", "definitionVersion", "definitionHash"] as const) {
    if (run[field] !== actual[field]) {
      throw new DefinitionMismatchError(run.runId, field, run[field], actual[field]);
    }
  }
}

function nonNegativeInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new UmioError(`${name} must be a non-negative integer, got ${value}.`);
  }
  return value;
}

function below(value: number, limit: number, name: string): void {
  if (value >= limit) {
    throw new UmioError(`${name} (${value}) must be below leaseTtlMs (${limit}).`);
  }
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new UmioError(`${name} must be a positive integer, got ${value}.`);
  }
  return value;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
