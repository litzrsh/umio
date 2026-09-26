import type { UmioConfig } from "../config/schema.js";
import { LLMError, UmioError } from "../errors.js";
import { GraphNodeError } from "./errors.js";
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
const MAX_ERROR_MESSAGE = 1_000;

export interface WorkflowExecutorOptions {
  /**
   * Nodes running at once. Default 4; 1 is recommended for a single local model.
   * Note that it does not limit model calls made inside one node (parallel tool
   * calls); the provider's `maxConcurrentRequests` does.
   */
  maxConcurrency?: number;
  /** Largest checkpointed node output, in UTF-8 bytes of JSON. Default 256 KiB. */
  maxOutputBytes?: number;
  /** Receives node events (`context.emit`). Errors thrown by it are ignored. */
  onNodeEvent?(nodeId: NodeId, attempt: number, event: NodeEvent): void;
}

export interface GraphRunOptions {
  readonly runId?: string;
  /** Overrides the executor's `maxConcurrency` for this run. */
  readonly maxConcurrency?: number;
}

type Outcome = { ok: true; output: JsonValue } | { ok: false; error: NodeError };

interface RunningAttempt {
  attempt: number;
  controller: AbortController;
  settled: Promise<{ nodeId: NodeId; attempt: number; outcome: Outcome }>;
}

/**
 * Runs workflow definitions: validation, definition identity, branching
 * (predicates), joins, skip propagation and bounded concurrency, with the run
 * record kept in memory. Checkpoint stores, retries, timeouts, cancellation and
 * resumption arrive in later phases (docs/work/umio-graph-workflow-plan.md).
 *
 * Every change to the run record goes through `commit()`, the single point
 * where later phases write through a fenced checkpoint store. Results are
 * applied one at a time by the scheduling loop, never from inside handler
 * callbacks, so record changes are serialized even with concurrent nodes.
 */
export class WorkflowExecutor {
  private readonly deps: RuntimeDependencies;
  private readonly maxConcurrency: number;
  private readonly maxOutputBytes: number;

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

    const { graph } = definition;
    let record = createRun({
      definition,
      definitionHash: definitionHash(definition),
      runId: options.runId ?? this.deps.newId(),
      input,
      now: this.deps.now(),
    });
    const commit = (next: WorkflowRun) => {
      record = next;
    };

    const running = new Map<NodeId, RunningAttempt>();
    let failure: { nodeId: NodeId; error: NodeError } | undefined;
    const startFailing = (nodeId: NodeId, error: NodeError) => {
      failure = { nodeId, error };
      // Stop the rest of the run: running attempts are asked to stop; results
      // that still arrive are recorded, but nothing new starts.
      for (const attempt of running.values()) attempt.controller.abort(failureReason(nodeId));
    };

    for (;;) {
      if (!failure) {
        for (const nodeId of readyNodes(graph, record, this.deps.now())) {
          if (running.size >= maxConcurrency) break;
          commit(startAttempt(record, nodeId, this.deps.now()));
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
        if (failure) {
          commit(
            finishRun(record, "failed", this.deps.now(), {
              code: failure.error.code,
              message: failure.error.message,
              nodeId: failure.nodeId,
            }),
          );
          return record;
        }
        if (allNodesDone(record)) {
          commit(finishRun(record, "completed", this.deps.now()));
          return record;
        }
        throw new UmioError(`Run ${record.runId} stalled with unfinished nodes.`); // scheduler bug
      }

      const { nodeId, attempt, outcome } = await Promise.race(
        [...running.values()].map((entry) => entry.settled),
      );
      running.delete(nodeId);
      // Apply a result only while its attempt is current (I7).
      const state = record.nodes[nodeId];
      if (state?.status !== "running" || state.attempt !== attempt) continue;

      if (outcome.ok) {
        const decided = decideEdges(definition, record, nodeId, outcome.output);
        if (decided.ok) {
          commit(
            completeNode(graph, record, nodeId, outcome.output, decided.decisions, this.deps.now()),
          );
        } else {
          commit(failNode(record, nodeId, decided.error, this.deps.now()));
          if (!failure) startFailing(nodeId, decided.error);
        }
      } else if (failure) {
        // Stopped because the run was already failing.
        commit(cancelAttempt(record, nodeId, this.deps.now()));
      } else {
        commit(failNode(record, nodeId, outcome.error, this.deps.now()));
        startFailing(nodeId, outcome.error);
      }
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

function failureReason(nodeId: NodeId): Error {
  return new UmioError(`Run stopped: node "${nodeId}" failed.`);
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
