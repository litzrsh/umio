import { LLMError, UmioError } from "../errors.js";
import { GraphNodeError, GraphUnsupportedError } from "./errors.js";
import { definitionHash } from "./identity.js";
import {
  allNodesDone,
  completeNode,
  createRun,
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

export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const MAX_ERROR_MESSAGE = 1_000;

export interface WorkflowExecutorOptions {
  /** P1 runs one node at a time; values above 1 arrive with DAG execution (P2). */
  maxConcurrency?: number;
  maxOutputBytes?: number;
  /** Receives node events (`context.emit`). Errors thrown by it are ignored. */
  onNodeEvent?(nodeId: NodeId, attempt: number, event: NodeEvent): void;
}

export interface GraphRunOptions {
  readonly runId?: string;
}

/**
 * Runs workflow definitions. Phase P1 of docs/work/umio-graph-workflow-plan.md:
 * validation, definition identity, and sequential execution of graphs with
 * unconditional edges and `join: "all"`, kept in memory. Checkpoint stores,
 * branching, concurrency, retries, timeouts, cancellation and resumption are
 * added in later phases; until then the executor stays internal.
 *
 * Every change to the run record goes through `commit()`, the single point
 * where later phases write through a fenced checkpoint store.
 */
export class WorkflowExecutor {
  private readonly deps: RuntimeDependencies;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly options: WorkflowExecutorOptions = {},
    dependencies?: Partial<RuntimeDependencies>,
  ) {
    this.deps = withDefaults(dependencies);
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if ((options.maxConcurrency ?? 1) !== 1) {
      throw new GraphUnsupportedError("maxConcurrency above 1 is not supported yet.");
    }
  }

  /**
   * Runs a definition to a terminal status. Resolves with the run record whether
   * the run completed or failed (a node failure is data, not an exception);
   * rejects only for invalid definitions or input.
   */
  async run(
    definition: WorkflowDefinition,
    input: JsonValue,
    options: GraphRunOptions = {},
  ): Promise<WorkflowRun> {
    validateDefinition(definition);
    assertSupported(definition);
    if (!isJsonValue(input)) throw new UmioError("Run input must be a JSON value.");

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

    for (;;) {
      const [nodeId] = readyNodes(graph, record, this.deps.now());
      if (nodeId === undefined) {
        // With unconditional edges and no retries, nothing ready means every node
        // completed (a failure returns below). Anything else is a scheduler bug.
        if (!allNodesDone(record)) {
          throw new UmioError(`Run ${record.runId} stalled with unfinished nodes.`);
        }
        commit(finishRun(record, "completed", this.deps.now()));
        return record;
      }

      commit(startAttempt(record, nodeId, this.deps.now()));
      const attempt = record.nodes[nodeId]?.attempt ?? 1;
      const outcome = await this.invoke(definition, record, nodeId, attempt);

      if (outcome.ok) {
        commit(completeNode(graph, record, nodeId, outcome.output, this.deps.now()));
        continue;
      }
      commit(failNode(record, nodeId, outcome.error, this.deps.now()));
      commit(
        finishRun(record, "failed", this.deps.now(), {
          code: outcome.error.code,
          message: outcome.error.message,
          nodeId,
        }),
      );
      return record;
    }
  }

  private async invoke(
    definition: WorkflowDefinition,
    record: WorkflowRun,
    nodeId: NodeId,
    attempt: number,
  ): Promise<{ ok: true; output: JsonValue } | { ok: false; error: NodeError }> {
    const spec = definition.graph.nodes.find((node) => node.id === nodeId);
    const handler = spec && definition.handlers[spec.handler];
    if (!spec || !handler) throw new UmioError(`No handler for node "${nodeId}".`); // validated earlier

    const context: NodeContext = {
      runId: record.runId,
      nodeId,
      attempt,
      input: record.input,
      predecessors: predecessorOutputs(definition.graph, record, nodeId),
      signal: new AbortController().signal,
      idempotencyKey: `${record.runId}:${nodeId}`,
      limits: { maxOutputBytes: spec.maxOutputBytes ?? this.maxOutputBytes },
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
    if (!isJsonValue(output)) {
      return {
        ok: false,
        error: {
          code: "output-not-json",
          message: `Node "${nodeId}" returned a value that is not JSON; its side effects, if any, may already have happened (idempotency key ${context.idempotencyKey}).`,
          retryable: false,
        },
      };
    }
    return { ok: true, output };
  }
}

/** Features validated as correct but not executable until later phases. */
function assertSupported(definition: WorkflowDefinition): void {
  const { graph } = definition;
  if (graph.edges.some((edge) => edge.when !== undefined)) {
    throw new GraphUnsupportedError("Conditional edges (`when`) are not supported yet.");
  }
  if (graph.nodes.some((node) => node.join === "any")) {
    throw new GraphUnsupportedError('`join: "any"` is not supported yet.');
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
