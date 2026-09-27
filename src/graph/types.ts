/**
 * Graph workflow contracts.
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

/**
 * May gain members in later schema versions; handle unknown values with a
 * default branch. `paused` (schema version 2) means the run waits for an
 * approval decision and has no owner.
 */
export type RunStatus =
  | "running"
  | "paused"
  | "needs-recovery"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Persisted node statuses. "ready" is derived by the scheduler and never
 * stored. `waiting` (schema version 2): an approval node whose request awaits
 * a decision.
 */
export type NodeStatus =
  | "pending"
  | "running"
  | "waiting"
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

/**
 * A node is one of three kinds, decided by which field it sets:
 * - **task** (`handler`): runs a handler, with retries and timeouts;
 * - **approval** (`approval`): pauses for a person's decision, runs no code;
 * - **loop** (`loop`): runs a body subgraph repeatedly until a condition holds.
 *
 * `retry`, `timeoutMs`, `inactivityTimeoutMs` and `recovery` apply to task
 * nodes only.
 */
export interface NodeSpec {
  readonly id: NodeId;
  /** Key in `WorkflowDefinition.handlers`. Required for task nodes, absent otherwise. */
  readonly handler?: string;
  /** Makes this an approval node (schema version 2). */
  readonly approval?: ApprovalSpec;
  /** Makes this a loop node (schema version 2). */
  readonly loop?: LoopSpec;
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

/**
 * An explicit human approval point. When the node becomes ready the executor
 * records a request (the node is `waiting`), keeps running any other work, and
 * pauses the run (status `paused`, no owner) once nothing else can progress. A
 * decision is recorded with `WorkflowExecutor.approve()`/`reject()` from any
 * process and applied at most once by whoever owns the run next.
 */
export interface ApprovalSpec {
  /** One line shown to the approver. */
  readonly title: string;
  /** What is being approved and what happens next. */
  readonly description?: string;
  /**
   * What a rejection does.
   * - `"fail"` (default): the node fails with `approval-rejected`, and so the run.
   * - `"continue"`: the node completes with `approved: false`; its outgoing
   *   edges, which must all have a `when` predicate, decide what runs next.
   */
  readonly onReject?: "fail" | "continue";
}

/** The output of an approval node once a decision was applied. */
export interface ApprovalOutput {
  readonly approved: boolean;
  readonly requestId: string;
  readonly decidedAt: number;
  readonly decidedBy?: string;
  readonly comment?: string;
}

/**
 * A bounded loop: `body` is a small DAG that runs once per iteration. After
 * each iteration the `until` predicate receives the iteration's output (the
 * outputs of the body's exit nodes, keyed by body node ID); `true` ends the
 * loop. The loop never runs more than `maxIterations` iterations.
 *
 * Body nodes are checkpointed per iteration as `<loopId>#<iteration>/<bodyId>`,
 * which is also their `nodeId` and idempotency-key suffix. Loops cannot nest,
 * and body edges stay inside the body.
 */
export interface LoopSpec {
  readonly body: {
    readonly nodes: readonly NodeSpec[];
    readonly edges: readonly EdgeSpec[];
    readonly entry: readonly NodeId[];
  };
  /** Key in `WorkflowDefinition.predicates`: `(iterationOutput, runInput) => boolean`; `true` stops. */
  readonly until: string;
  /** Required upper bound, 1–10 000. */
  readonly maxIterations: number;
  /** When `until` is still false after `maxIterations`: `"fail"` (default, `loop-exhausted`) or `"complete"`. */
  readonly onExhausted?: "fail" | "complete";
}

/** The output of a loop node. */
export interface LoopOutput {
  readonly iterations: number;
  /** True when the loop stopped at `maxIterations` without `until` holding (`onExhausted: "complete"`). */
  readonly exhausted: boolean;
  /** The last iteration's output: its completed exit nodes' outputs by body node ID. */
  readonly outputs: { readonly [bodyId: string]: JsonValue };
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
  /** The node's checkpoint identity: its ID, or `<loopId>#<iteration>/<bodyId>` inside a loop. */
  readonly nodeId: NodeId;
  /** 1-based. */
  readonly attempt: number;
  /** The run input. */
  readonly input: JsonValue;
  /**
   * Outputs of completed, active predecessors, keyed in node-ID order. For a
   * loop body's entry nodes: the loop node's own predecessors.
   */
  readonly predecessors: Readonly<Record<NodeId, JsonValue>>;
  /** Set inside a loop body. */
  readonly loop?: {
    readonly id: NodeId;
    /** 1-based. */
    readonly iteration: number;
    /** The previous iteration's output (see `LoopSpec`); absent in the first. */
    readonly previous?: JsonValue;
  };
  /** Aborted on cancellation, timeout, run failure or lease loss. */
  readonly signal: AbortSignal;
  readonly deadline?: number;
  /**
   * `${runId}:${nodeId}`, identical across attempts (and distinct per loop
   * iteration, since `nodeId` is). Use it to deduplicate side effects.
   */
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

/** A recorded approval request, kept on the approval node's record. */
export interface ApprovalRequest {
  /** Random per request: a decision names it, so it can never apply to another request. */
  readonly requestId: string;
  readonly requestedAt: number;
  readonly title: string;
  readonly description?: string;
  /** Nodes whose outputs are the request's context (the approval node's predecessors). */
  readonly context: readonly NodeId[];
  readonly onReject: "fail" | "continue";
}

/**
 * A person's decision on an approval request. Stored by the checkpoint store
 * (first decision per request wins), then applied to the run by its owner.
 */
export interface ApprovalDecision {
  readonly requestId: string;
  /** The approval node's checkpoint identity, for display. */
  readonly nodeId: NodeId;
  readonly approved: boolean;
  readonly decidedAt: number;
  readonly decidedBy?: string;
  /** Up to 2 000 characters. */
  readonly comment?: string;
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
    | "abandoned-failure"
    /**
     * The handler returned, but its output failed the checks (not JSON, or over
     * `maxOutputBytes`). Its side effects happened; `error` says why the output
     * was rejected. Never retried automatically: resolve it with `recoverNode()`.
     */
    | "invalid-output";
  readonly recoveries?: readonly { action: "retry" | "complete" | "fail"; at: number }[];
  /** Approval nodes: the request, once made. */
  readonly approval?: ApprovalRequest;
  /**
   * Loop nodes: the current iteration (1-based) and the recorded `until`
   * result of each finished iteration, decided once.
   */
  readonly loop?: { readonly iteration: number; readonly decisions: readonly boolean[] };
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface WorkflowRun {
  /**
   * 1 for runs whose definition has only task nodes (readable by earlier umio
   * versions); 2 when it has approval or loop nodes.
   */
  readonly schemaVersion: 1 | 2;
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

/** A request awaiting a decision, with the context an approver needs. */
export interface PendingApproval {
  readonly runId: string;
  readonly workflowId: string;
  readonly runStatus: RunStatus;
  readonly nodeId: NodeId;
  readonly request: ApprovalRequest;
  /** The run input. */
  readonly input: JsonValue;
  /** Outputs of the nodes in `request.context`, read from the run record. */
  readonly context: Readonly<Record<NodeId, JsonValue>>;
  /** A decision already recorded but not yet applied by the run's owner. */
  readonly decision?: ApprovalDecision;
}

/** What `approve()`/`reject()` achieved. */
export interface ApprovalAck {
  readonly runId: string;
  /**
   * - `recorded`: this decision is stored. The live owner applies it within
   *   about `cancelPollIntervalMs`; a `paused` run continues on `resume()`.
   * - `already-decided`: a decision was recorded (or applied) first; `decision` is that one.
   * - `not-pending`: the run has no waiting request matching the target.
   * - `already-terminal` / `not-found`: nothing to decide.
   */
  readonly outcome:
    | "recorded"
    | "already-decided"
    | "not-pending"
    | "already-terminal"
    | "not-found";
  readonly decision?: ApprovalDecision;
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
  | {
      readonly type: "run-paused";
      readonly runId: string;
      /** Approval nodes waiting for a decision. */
      readonly nodes: readonly NodeId[];
      readonly at: number;
    }
  | { readonly type: "run-cancel-requested"; readonly runId: string; readonly at: number }
  | {
      readonly type: "node-waiting";
      readonly runId: string;
      readonly nodeId: NodeId;
      readonly requestId: string;
      readonly at: number;
    }
  | {
      readonly type: "loop-iteration";
      readonly runId: string;
      /** The loop node. */
      readonly nodeId: NodeId;
      /** The iteration that starts. */
      readonly iteration: number;
      readonly at: number;
    }
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
