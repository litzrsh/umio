import type { UmioConfig } from "../config/schema.js";
import { LLMError, UmioError } from "../errors.js";
import { MemoryCheckpointStore } from "./checkpoint/memory.js";
import type { CheckpointStore, Lease } from "./checkpoint/store.js";
import { CheckpointConflictError, GraphNodeError, LeaseLostError } from "./errors.js";
import { definitionHash } from "./identity.js";
import { checkOutput } from "./output.js";
import {
  allNodesDone,
  cancelAttempt,
  completeNode,
  createRun,
  decideEdges,
  failNode,
  finishRun,
  predecessorOutputs,
  readyNodes,
  startAttempt,
} from "./plan.js";
import { type RuntimeDependencies, withDefaults } from "./runtime.js";
import type {
  JsonValue,
  NodeContext,
  NodeError,
  NodeEvent,
  NodeId,
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
    let halt: Halt | undefined;

    const commit = async (next: WorkflowRun) => {
      if (fatal) throw fatal;
      const result = await this.store.compareAndSwap(next, record.revision, lease);
      if (result === "ok") {
        record = next;
        return;
      }
      throw result === "lease-lost"
        ? new LeaseLostError(runId)
        : new CheckpointConflictError(
            runId,
            `Run "${runId}" changed under a valid lease (expected revision ${record.revision}).`,
          );
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
          try {
            await this.store.releaseLease(lease);
          } catch {
            // The terminal status is written; an unreleased lease just expires.
          }
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
