/**
 * Graph workflow contracts (docs/work/umio-graph-workflow-plan.md §3).
 * Definitions and run records are JSON-serializable; handlers, predicates and
 * everything they capture are process-bound and supplied again on every run.
 */
import type { Adr } from "../adr/store.js";
import type { ToolLoopEvent } from "../tools/loop.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NodeId = string;

/** May gain members in later schema versions; handle unknown values with a default branch. */
export type RunStatus = "running" | "needs-recovery" | "completed" | "failed" | "cancelled";

/** Persisted node statuses. "ready" is derived by the scheduler and never stored. */
export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled"
  | "uncertain";

export interface WorkflowGraph {
  readonly id: string;
  /** Pins each run to its definition; bump it whenever node behavior changes. */
  readonly version: string;
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly entry: readonly NodeId[];
}

export interface NodeSpec {
  readonly id: NodeId;
  /** Key in `WorkflowDefinition.handlers`. */
  readonly handler: string;
  /** Default `{ maxAttempts: 1 }`. */
  readonly retry?: RetryPolicy;
  /** Wall-clock limit per attempt. Default: the executor's node timeout (3 h); `null` disables it. */
  readonly timeoutMs?: number | null;
  /** Limit on time without progress events. Disabled by default. */
  readonly inactivityTimeoutMs?: number;
  /** How multiple incoming edges combine. Default "all". Only valid with 2+ incoming edges. */
  readonly join?: "all" | "any";
  /** Largest checkpointed output. Default: the executor's limit (256 KiB). */
  readonly maxOutputBytes?: number;
  /** What happens to an attempt whose outcome is unknown. Default "manual". */
  readonly recovery?: "manual" | "retry";
}

export interface EdgeSpec {
  readonly from: NodeId;
  readonly to: NodeId;
  /** Key in `WorkflowDefinition.predicates`; the edge is active only if it returns true. Absent: always active. */
  readonly when?: string;
}

export interface RetryPolicy {
  /** Includes the first attempt. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
}

export interface NodeContext {
  readonly runId: string;
  readonly nodeId: NodeId;
  /** 1-based. */
  readonly attempt: number;
  /** The run input. */
  readonly input: JsonValue;
  /** Outputs of completed, active predecessors, keyed in node-ID order. */
  readonly predecessors: Readonly<Record<NodeId, JsonValue>>;
  /** Aborted on cancellation, timeout, run failure or lease loss. */
  readonly signal: AbortSignal;
  readonly deadline?: number;
  /** `${runId}:${nodeId}`, identical across attempts. Use it to deduplicate side effects. */
  readonly idempotencyKey: string;
  readonly limits: { readonly maxOutputBytes: number };
  /** Reports progress to observers. Never throws or blocks. */
  emit(event: NodeEvent): void;
}

export type NodeHandler = (context: NodeContext) => Promise<JsonValue>;

/** Pure and synchronous. Evaluated once per completed source node; the decision is recorded. */
export type EdgePredicate = (output: JsonValue, runInput: JsonValue) => boolean;

export interface WorkflowDefinition {
  readonly graph: WorkflowGraph;
  readonly handlers: Readonly<Record<string, NodeHandler>>;
  readonly predicates: Readonly<Record<string, EdgePredicate>>;
}

export type NodeEvent =
  | { type: "agent-event"; agent: string; event: ToolLoopEvent }
  | { type: "adr-proposed"; agent: string; adr: Adr }
  | { type: "custom"; name: string; data?: JsonValue };

/** What `recoverNode()` does with an uncertain node. */
export type RecoveryAction =
  /** Run the node again (after `resume()`), even beyond its retry budget. Reuses the idempotency key. */
  | { type: "retry" }
  /** Record the node as completed with this output, e.g. after checking its side effect happened. */
  | { type: "complete"; output: JsonValue }
  /** Record the node, and so the run, as failed. */
  | { type: "fail"; message?: string };

export interface NodeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface NodeRun {
  readonly nodeId: NodeId;
  readonly status: NodeStatus;
  /** Attempts started so far. */
  readonly attempt: number;
  readonly retryAt?: number;
  readonly selectedPredecessor?: NodeId;
  readonly output?: JsonValue;
  readonly error?: NodeError;
  readonly uncertainReason?:
    | "process-lost"
    | "abandoned-timeout"
    | "abandoned-cancel"
    | "abandoned-failure";
  readonly recoveries?: readonly { action: "retry" | "complete" | "fail"; at: number }[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface WorkflowRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflowId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly status: RunStatus;
  readonly input: JsonValue;
  readonly nodes: Readonly<Record<NodeId, NodeRun>>;
  /** "from->to" → whether the edge was activated. Decided once, when its source completes. */
  readonly edges: Readonly<Record<string, boolean>>;
  readonly revision: number;
  readonly error?: { readonly code: string; readonly message: string; readonly nodeId?: NodeId };
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What `cancel()` achieved. */
export interface CancelAck {
  readonly runId: string;
  /**
   * - `cancelled`: this call finalized the run (its owner was gone).
   * - `requested`: the request is recorded; the live owner will stop the run.
   * - `already-terminal`: the run had already completed, failed or been cancelled.
   * - `not-found`: no such run.
   */
  readonly outcome: "cancelled" | "requested" | "already-terminal" | "not-found";
  /** The run's status as this call last saw it. */
  readonly status?: RunStatus;
}

/** Progress of a run, delivered in order to a `RunObserver`. */
export type GraphRunEvent =
  | { readonly type: "run-start" | "run-resume"; readonly runId: string; readonly at: number }
  | {
      readonly type: "run-finish";
      readonly runId: string;
      readonly status: "completed" | "failed" | "cancelled";
      readonly at: number;
    }
  | {
      readonly type: "run-needs-recovery";
      readonly runId: string;
      readonly nodes: readonly NodeId[];
      readonly at: number;
    }
  | { readonly type: "run-cancel-requested"; readonly runId: string; readonly at: number }
  | {
      readonly type: "node-start";
      readonly runId: string;
      readonly nodeId: NodeId;
      readonly attempt: number;
      readonly at: number;
    }
  | {
      readonly type: "node-event";
      readonly runId: string;
      readonly nodeId: NodeId;
      readonly attempt: number;
      readonly event: NodeEvent;
      readonly at: number;
    }
  | {
      readonly type: "node-retry";
      readonly runId: string;
      readonly nodeId: NodeId;
      /** The attempt that failed or was abandoned. */
      readonly attempt: number;
      readonly retryAt: number;
      readonly at: number;
    }
  | {
      readonly type: "node-finish";
      readonly runId: string;
      readonly nodeId: NodeId;
      /** 0 for a skipped node that never started. */
      readonly attempt: number;
      readonly status: "completed" | "failed" | "skipped" | "cancelled" | "uncertain";
      readonly at: number;
    };

/**
 * Receives run events. Delivery is queued: the scheduler never waits for it,
 * and errors or hangs here never change the run (see `observerDrainTimeoutMs`).
 */
export interface RunObserver {
  emit(event: GraphRunEvent): void | Promise<void>;
}
