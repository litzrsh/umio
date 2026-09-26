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
import { checkOutput } from "./output.js";
import {
  allNodesDone,
  applyRecovery,
  cancelAttempt,
  completeNode,
  createRun,
  decideEdges,
  failNode,
  finalizeCancel,
  finishRun,
  firstFailedNode,
  orphanedNodes,
  predecessorOutputs,
  readyNodes,
  recoverOrphans,
  startAttempt,
} from "./plan.js";
import { type RuntimeDependencies, withDefaults } from "./runtime.js";
import type {
  JsonValue,
  NodeContext,
  NodeError,
  NodeEvent,
  NodeId,
  RecoveryAction,
  RunStatus,
  WorkflowDefinition,
  WorkflowRun,
} from "./types.js";
import { isJsonValue, validateDefinition } from "./validate.js";

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;
export const DEFAULT_CANCEL_POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_MESSAGE = 1_000;

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
   * How long a lease stays valid without renewal. Default 30 s: after a crash,
   * another executor can take over the run this long after the last renewal.
   */
  leaseTtlMs?: number;
  /** How often the lease is renewed, on its own timer. Default 10 s; must be below `leaseTtlMs`. */
  leaseRenewIntervalMs?: number;
  /** How often the store is polled for a cancel request. Default 2 s. */
  cancelPollIntervalMs?: number;
  /** Receives node events (`context.emit`). Errors thrown by it are ignored. */
  onNodeEvent?(nodeId: NodeId, attempt: number, event: NodeEvent): void;
}

export interface GraphRunOptions {
  readonly runId?: string;
  /** Overrides the executor's `maxConcurrency` for this run. */
  readonly maxConcurrency?: number;
}

type Outcome = { ok: true; output: JsonValue } | { ok: false; error: NodeError };

type Halt = { kind: "failed"; nodeId: NodeId; error: NodeError } | { kind: "cancelled" };

interface RunningAttempt {
  attempt: number;
  controller: AbortController;
  settled: Promise<{ nodeId: NodeId; attempt: number; outcome: Outcome }>;
}

/**
 * Runs workflow definitions: validation, definition identity, branching
 * (predicates), joins, skip propagation and bounded concurrency, checkpointing
 * every change to a `CheckpointStore`. Retries, timeouts, the full cancel flow
 * and resumption arrive in later phases (docs/work/umio-graph-workflow-plan.md).
 *
 * Every change to the run record goes through `commit()`, a compare-and-swap
 * fenced by this executor's lease (I1). Results are applied one at a time by
 * the scheduling loop, never from inside handler callbacks, so writes are
 * serialized even with concurrent nodes. The lease is renewed and the store
 * polled for cancel requests on timers of their own, independent of handler
 * activity, so a long silent model call never looks like a dead executor.
 */
export class WorkflowExecutor {
  private readonly deps: RuntimeDependencies;
  private readonly store: CheckpointStore;
  /** Identifies this executor as a lease owner. */
  private readonly ownerId: string;
  private readonly maxConcurrency: number;
  private readonly maxOutputBytes: number;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly cancelPollIntervalMs: number;

  constructor(
    private readonly options: WorkflowExecutorOptions = {},
    dependencies?: Partial<RuntimeDependencies>,
  ) {
    this.deps = withDefaults(dependencies);
    this.maxConcurrency = positiveInt(
      options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      "maxConcurrency",
    );
    this.maxOutputBytes = positiveInt(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.leaseTtlMs = positiveInt(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "leaseTtlMs");
    this.leaseRenewIntervalMs = positiveInt(
      options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS,
      "leaseRenewIntervalMs",
    );
    if (this.leaseRenewIntervalMs >= this.leaseTtlMs) {
      throw new UmioError(
        `leaseRenewIntervalMs (${this.leaseRenewIntervalMs}) must be below leaseTtlMs (${this.leaseTtlMs}).`,
      );
    }
    this.cancelPollIntervalMs = positiveInt(
      options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS,
      "cancelPollIntervalMs",
    );
    this.store = options.store ?? new MemoryCheckpointStore({ now: this.deps.now });
    this.ownerId = this.deps.newId();
  }

  /**
   * Creates an executor from the config's `graph` section. Precedence, highest
   * first: `GraphRunOptions` → `options` here → the config file → built-in defaults.
   */
  static fromConfig(
    config: Pick<UmioConfig, "graph">,
    options: WorkflowExecutorOptions = {},
    dependencies?: Partial<RuntimeDependencies>,
  ): WorkflowExecutor {
    const fromFile = config.graph ?? {};
    return new WorkflowExecutor(
      {
        ...(fromFile.maxConcurrency !== undefined && { maxConcurrency: fromFile.maxConcurrency }),
        ...(fromFile.maxOutputBytes !== undefined && { maxOutputBytes: fromFile.maxOutputBytes }),
        ...definedOnly(options),
      },
      dependencies,
    );
  }

  /**
   * Runs a definition to a terminal status. Resolves with the run record whether
   * the run completed or failed (a node failure is data, not an exception);
   * rejects only for invalid definitions, input or options.
   */
  async run(
    definition: WorkflowDefinition,
    input: JsonValue,
    options: GraphRunOptions = {},
  ): Promise<WorkflowRun> {
    validateDefinition(definition);
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
    return this.drive(definition, initial, lease, maxConcurrency);
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
    const maxConcurrency = positiveInt(
      options.maxConcurrency ?? this.maxConcurrency,
      "maxConcurrency",
    );
    let { record, lease } = await this.takeOver(definition, runId, ["running", "needs-recovery"]);

    if (await this.store.isCancelRequested(runId)) {
      record = await this.write(record, finalizeCancel(record, this.deps.now()), lease); // W7
      await this.release(lease);
      return record;
    }
    if (orphanedNodes(record).length > 0) {
      record = await this.write(
        record,
        recoverOrphans(definition.graph, record, this.deps.now()),
        lease,
      ); // W6
    }
    if (record.status === "needs-recovery") {
      await this.release(lease);
      return record;
    }
    return this.drive(definition, record, lease, maxConcurrency);
  }

  /**
   * Resolves an `uncertain` node of a `needs-recovery` run, after you have
   * checked what its interrupted attempt actually did (its side effects are
   * keyed by `idempotencyKey`). It never starts attempts: call `resume()`
   * afterwards to continue the run.
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
    let { record, lease } = await this.takeOver(definition, runId, ["needs-recovery"]);
    try {
      if (await this.store.isCancelRequested(runId)) {
        record = await this.write(record, finalizeCancel(record, this.deps.now()), lease); // W7
        await this.release(lease);
        return record;
      }
      const decisions = this.recoveryDecisions(definition, record, nodeId, action);
      record = await this.write(
        record,
        applyRecovery(definition.graph, record, nodeId, action, decisions, this.deps.now()),
        lease,
      ); // W8
    } catch (error) {
      // An invalid action writes nothing; the lease can go back at once.
      if (error instanceof RecoveryNotApplicableError) await this.release(lease);
      throw error;
    }
    await this.release(lease);
    return record;
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
    if (action.type !== "complete") return {};
    const spec = definition.graph.nodes.find((item) => item.id === nodeId);
    const invalid = checkOutput(action.output, {
      maxOutputBytes: spec?.maxOutputBytes ?? this.maxOutputBytes,
      nodeId,
      idempotencyKey: `${runId}:${nodeId}`,
    });
    if (invalid) throw new RecoveryNotApplicableError(runId, nodeId, invalid.message);
    const decided = decideEdges(definition, record, nodeId, action.output);
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

  /**
   * Owns a run until it is terminal: schedules nodes, applies their results and
   * keeps the lease. Resolves with the terminal record. Rejects with
   * `LeaseLostError` or `CheckpointConflictError` (or a store error) after
   * aborting running attempts, stopping its timers and writing nothing more (I6).
   */
  private async drive(
    definition: WorkflowDefinition,
    initial: WorkflowRun,
    firstLease: Lease,
    maxConcurrency: number,
  ): Promise<WorkflowRun> {
    const { graph } = definition;
    const { runId } = initial;
    let record = initial;
    let lease = firstLease;
    const running = new Map<NodeId, RunningAttempt>();
    // Set by the timers; acted on by the scheduling loop, which `wake` interrupts.
    let fatal: Error | undefined;
    let cancelRequested = false;
    let wake = deferred();
    // A resumed run may already have a failed node (a crash before W5): finish it as failed.
    const failed = firstFailedNode(graph, initial);
    // (Asserted: closures assign it, which control-flow narrowing cannot see.)
    let halt = (failed ? { kind: "failed", ...failed } : undefined) as Halt | undefined;

    const commit = async (next: WorkflowRun) => {
      if (fatal) throw fatal;
      record = await this.write(record, next, lease);
    };
    const loseLease = () => {
      fatal ??= new LeaseLostError(runId);
      wake.resolve();
    };
    const stopRunning = (reason: unknown) => {
      for (const attempt of running.values()) attempt.controller.abort(reason);
    };
    const startHalt = (next: Halt) => {
      // The first decision wins (I9). Running attempts are asked to stop;
      // results that still arrive are recorded, but nothing new starts.
      halt = next;
      stopRunning(
        new UmioError(
          next.kind === "failed"
            ? `Run stopped: node "${next.nodeId}" failed.`
            : `Run "${runId}" cancelled.`,
        ),
      );
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
        try {
          if (!cancelRequested && (await this.store.isCancelRequested(runId))) {
            cancelRequested = true;
            wake.resolve();
          }
        } catch {
          // Polled again on the next tick.
        }
      }),
    ];
    const stopAllTimers = () => {
      for (const stop of stopTimers) stop();
    };

    try {
      for (;;) {
        if (fatal) throw fatal;
        if (cancelRequested && !halt) startHalt({ kind: "cancelled" });

        if (!halt) {
          for (const nodeId of readyNodes(graph, record, this.deps.now())) {
            if (running.size >= maxConcurrency) break;
            await commit(startAttempt(record, nodeId, this.deps.now())); // W1, before the handler
            const attempt = record.nodes[nodeId]?.attempt ?? 1;
            const controller = new AbortController();
            running.set(nodeId, {
              attempt,
              controller,
              settled: this.invoke(definition, record, nodeId, attempt, controller.signal).then(
                (outcome) => ({ nodeId, attempt, outcome }),
              ),
            });
          }
        }

        if (running.size === 0) {
          if (halt?.kind === "failed") {
            await commit(
              finishRun(record, "failed", this.deps.now(), {
                code: halt.error.code,
                message: halt.error.message,
                nodeId: halt.nodeId,
              }),
            );
          } else if (halt?.kind === "cancelled") {
            await commit(finishRun(record, "cancelled", this.deps.now()));
          } else if (allNodesDone(record)) {
            await commit(finishRun(record, "completed", this.deps.now()));
          } else {
            throw new UmioError(`Run ${runId} stalled with unfinished nodes.`); // scheduler bug
          }
          stopAllTimers();
          await this.release(lease);
          return record;
        }

        const settled = await Promise.race([
          ...[...running.values()].map((entry) => entry.settled),
          wake.promise.then(() => undefined),
        ]);
        if (!settled) {
          wake = deferred();
          continue;
        }
        const { nodeId, attempt, outcome } = settled;
        running.delete(nodeId);
        // Apply a result only while its attempt is current (I7).
        const state = record.nodes[nodeId];
        if (state?.status !== "running" || state.attempt !== attempt) continue;

        if (outcome.ok) {
          const decided = decideEdges(definition, record, nodeId, outcome.output);
          if (decided.ok) {
            // W2: successors become ready only once this write succeeds (I2).
            await commit(
              completeNode(
                graph,
                record,
                nodeId,
                outcome.output,
                decided.decisions,
                this.deps.now(),
              ),
            );
          } else {
            await commit(failNode(record, nodeId, decided.error, this.deps.now()));
            if (!halt) startHalt({ kind: "failed", nodeId, error: decided.error });
          }
        } else if (halt) {
          // Stopped because the run was already failing or being cancelled.
          await commit(cancelAttempt(record, nodeId, this.deps.now()));
        } else {
          await commit(failNode(record, nodeId, outcome.error, this.deps.now()));
          startHalt({ kind: "failed", nodeId, error: outcome.error });
        }
      }
    } catch (error) {
      // Lease lost, conflict or store failure: stop everything and write nothing more.
      stopRunning(error);
      throw error;
    } finally {
      stopAllTimers();
    }
  }

  private async invoke(
    definition: WorkflowDefinition,
    record: WorkflowRun,
    nodeId: NodeId,
    attempt: number,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const spec = definition.graph.nodes.find((node) => node.id === nodeId);
    const handler = spec && definition.handlers[spec.handler];
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
    const maxOutputBytes = spec.maxOutputBytes ?? this.maxOutputBytes;
    const context: NodeContext = {
      runId: record.runId,
      nodeId,
      attempt,
      input: record.input,
      predecessors: predecessorOutputs(definition.graph, record, nodeId),
      signal,
      idempotencyKey: `${record.runId}:${nodeId}`,
      limits: { maxOutputBytes },
      emit: (event) => {
        try {
          this.options.onNodeEvent?.(nodeId, attempt, event);
        } catch {
          // Observers never affect the run.
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
    return invalid ? { ok: false, error: invalid } : { ok: true, output: output as JsonValue };
  }
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
