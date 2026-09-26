/**
 * Pure scheduling over a run record: which nodes are ready, what a node's
 * success changes, and whether the run is finished. No I/O and no clock beyond
 * the `now` argument, so every rule can be tested exhaustively.
 *
 * Edge decisions are made exactly once, when the source node completes (or is
 * skipped), and recorded in `run.edges`. Readiness, skips and join selection
 * are derived from those recorded decisions only, never re-evaluated (I3).
 */
import { type ExpandedGraph, iterationKey, usesSchemaV2 } from "./structure.js";
import type {
  ApprovalDecision,
  ApprovalOutput,
  ApprovalRequest,
  EdgePredicate,
  EdgeSpec,
  JsonValue,
  NodeError,
  NodeId,
  NodeRun,
  NodeSpec,
  RecoveryAction,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowRun,
} from "./types.js";
import { edgeKey } from "./validate.js";

export function createRun(options: {
  definition: WorkflowDefinition;
  definitionHash: string;
  runId: string;
  input: JsonValue;
  now: number;
}): WorkflowRun {
  const { graph } = options.definition;
  const nodes: Record<NodeId, NodeRun> = {};
  for (const node of graph.nodes)
    nodes[node.id] = { nodeId: node.id, status: "pending", attempt: 0 };
  return {
    // Version 1 keeps plain DAG runs readable by earlier umio versions.
    schemaVersion: usesSchemaV2(options.definition) ? 2 : 1,
    runId: options.runId,
    workflowId: graph.id,
    definitionVersion: graph.version,
    definitionHash: options.definitionHash,
    status: "running",
    input: options.input,
    nodes,
    edges: {},
    revision: 0,
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/**
 * Nodes that may start now, in declaration order. A node is ready when it is
 * pending, past any `retryAt`, and:
 * - it has no incoming edges (entry node), or
 * - `join: "any"`: a predecessor has been selected, or
 * - `join: "all"` (default): every incoming edge is decided and at least one is active.
 */
export function readyNodes(graph: WorkflowGraph, run: WorkflowRun, now: number): NodeId[] {
  return graph.nodes
    .filter((node) => {
      const state = run.nodes[node.id];
      if (state?.status !== "pending") return false;
      if (state.retryAt !== undefined && state.retryAt > now) return false;
      const incoming = incomingEdges(graph, node.id);
      if (incoming.length === 0) return true;
      if (node.join === "any") return state.selectedPredecessor !== undefined;
      const decisions = incoming.map((edge) => run.edges[edgeKey(edge.from, edge.to)]);
      return decisions.every((decision) => decision !== undefined) && decisions.includes(true);
    })
    .map((node) => node.id);
}

/**
 * The `predecessors` a node receives: for `join: "any"`, only the selected
 * predecessor; otherwise every completed source of an active edge, keyed in node-ID order.
 */
export function predecessorOutputs(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
): Record<NodeId, JsonValue> {
  const selected = run.nodes[nodeId]?.selectedPredecessor;
  const sources =
    selected !== undefined
      ? [selected]
      : incomingEdges(graph, nodeId)
          .filter(
            (edge) =>
              run.edges[edgeKey(edge.from, edge.to)] === true &&
              run.nodes[edge.from]?.status === "completed",
          )
          .map((edge) => edge.from)
          .sort();
  const outputs: Record<NodeId, JsonValue> = {};
  for (const source of sources) outputs[source] = run.nodes[source]?.output ?? null;
  return outputs;
}

/**
 * Decides a completed node's outgoing edges in `graph` (the expanded graph,
 * for loop body nodes). Predicates are pure and synchronous; one that throws
 * or returns a non-boolean fails the node (`predicate-error`).
 */
export function decideEdges(
  graph: WorkflowGraph,
  predicates: WorkflowDefinition["predicates"],
  run: WorkflowRun,
  nodeId: NodeId,
  output: JsonValue,
): { ok: true; decisions: Record<string, boolean> } | { ok: false; error: NodeError } {
  const decisions: Record<string, boolean> = {};
  for (const edge of outgoingEdges(graph, nodeId)) {
    if (edge.when === undefined) {
      decisions[edgeKey(edge.from, edge.to)] = true;
      continue;
    }
    const decided = evaluatePredicate(predicates[edge.when], output, run.input);
    if (!decided.ok) {
      return {
        ok: false,
        error: predicateError(
          `Predicate "${edge.when}" on edge ${edgeKey(edge.from, edge.to)}`,
          decided.reason,
        ),
      };
    }
    decisions[edgeKey(edge.from, edge.to)] = decided.value;
  }
  return { ok: true, decisions };
}

/** Calls a predicate; a throw or a non-boolean result is a failure. */
export function evaluatePredicate(
  predicate: EdgePredicate | undefined,
  output: JsonValue,
  input: JsonValue,
): { ok: true; value: boolean } | { ok: false; reason: unknown } {
  let value: unknown;
  try {
    value = predicate?.(output, input);
  } catch (error) {
    return { ok: false, reason: error };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, reason: `returned ${typeof value}, expected boolean` };
}

/** W1: the attempt is recorded before the handler is invoked. */
export function startAttempt(run: WorkflowRun, nodeId: NodeId, now: number): WorkflowRun {
  const node = requireNode(run, nodeId);
  const { retryAt: _, error: __, ...rest } = node;
  return bump(
    withNode(run, { ...rest, status: "running", attempt: node.attempt + 1, startedAt: now }),
    now,
  );
}

/**
 * W2, as one change: the node's output and completion, its edge decisions,
 * `selectedPredecessor` for `join: "any"` targets reached through an active
 * edge, and every resulting skip, transitively.
 */
export function completeNode(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  output: JsonValue,
  decisions: Record<string, boolean>,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  let next = withNode(run, { ...node, status: "completed", output, finishedAt: now });
  next = { ...next, edges: { ...next.edges, ...decisions } };
  for (const edge of outgoingEdges(graph, nodeId)) {
    if (decisions[edgeKey(edge.from, edge.to)] !== true) continue;
    const target = requireNode(next, edge.to);
    const spec = requireSpec(graph, edge.to);
    if (
      spec.join === "any" &&
      target.status === "pending" &&
      target.selectedPredecessor === undefined
    ) {
      next = withNode(next, { ...target, selectedPredecessor: nodeId });
    }
  }
  return bump(propagateSkips(graph, next, now), now);
}

/** W3 (no retry): the node fails. */
export function failNode(
  run: WorkflowRun,
  nodeId: NodeId,
  error: NodeError,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  return bump(withNode(run, { ...node, status: "failed", error, finishedAt: now }), now);
}

/** W3 (retry): the node waits for `retryAt`, keeping the error that caused the retry. */
export function retryNode(
  run: WorkflowRun,
  nodeId: NodeId,
  error: NodeError,
  retryAt: number,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  return bump(withNode(run, { ...pendingAgain(node, retryAt), error }), now);
}

/**
 * W4 (abandoned): an attempt that did not stop within the grace period after
 * a timeout, cancel or run failure. Its outcome is unknown, so the node becomes
 * `uncertain`; with `recovery: "retry"` and attempts left it waits for
 * `now + retryDelayMs` instead. The run is parked later (W5′), once nothing runs.
 */
export function abandonAttempt(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  reason: NonNullable<NodeRun["uncertainReason"]>,
  retryDelayMs: number,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  const spec = requireSpec(graph, nodeId);
  return bump(
    withNode(
      run,
      spec.recovery === "retry" && node.attempt < (spec.retry?.maxAttempts ?? 1)
        ? pendingAgain(node, now + retryDelayMs)
        : { ...node, status: "uncertain", uncertainReason: reason, finishedAt: now },
    ),
    now,
  );
}

/**
 * W2′ (invalid output): the handler returned, so its side effects happened, but
 * its output cannot be checkpointed. The node becomes `uncertain` rather than
 * `failed`, so `recoverNode()` can supply a valid output (e.g. an `ArtifactRef`)
 * after checking the effect. It is never retried automatically, whatever its
 * `recovery` policy; the run parks (W5′) once nothing runs.
 */
export function rejectOutput(
  run: WorkflowRun,
  nodeId: NodeId,
  error: NodeError,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  return bump(
    withNode(run, {
      ...node,
      status: "uncertain",
      uncertainReason: "invalid-output",
      error,
      finishedAt: now,
    }),
    now,
  );
}

/** W4: an attempt stopped because the run is failing or being cancelled. */
export function cancelAttempt(run: WorkflowRun, nodeId: NodeId, now: number): WorkflowRun {
  const node = requireNode(run, nodeId);
  return bump(withNode(run, { ...node, status: "cancelled", finishedAt: now }), now);
}

/** W5′: the run waits for `recoverNode()`; no attempt starts while a node is uncertain. */
export function parkRun(run: WorkflowRun, now: number): WorkflowRun {
  return bump({ ...run, status: "needs-recovery" }, now);
}

/** W5: the run's terminal status. */
export function finishRun(
  run: WorkflowRun,
  status: "completed" | "failed" | "cancelled",
  now: number,
  error?: WorkflowRun["error"],
): WorkflowRun {
  return bump({ ...run, status, ...(error && { error }) }, now);
}

/**
 * Task nodes recorded as `running`: when a run is taken over, their previous
 * owner is gone. A running loop node (it has `loop` state) is not an attempt
 * and is never orphaned; its body nodes are checked individually.
 */
export function orphanedNodes(run: WorkflowRun): NodeId[] {
  return Object.values(run.nodes)
    .filter((node) => node.status === "running" && node.loop === undefined)
    .map((node) => node.nodeId);
}

/**
 * W6, the first write under a new lease: every orphaned attempt's outcome is
 * unknown. A node with `recovery: "retry"` and attempts left becomes pending
 * again; any other becomes `uncertain` (`process-lost`). If any node is
 * uncertain, the run parks as `needs-recovery` in the same write.
 */
export function recoverOrphans(graph: WorkflowGraph, run: WorkflowRun, now: number): WorkflowRun {
  let next = run;
  for (const nodeId of orphanedNodes(run)) {
    const node = requireNode(next, nodeId);
    const spec = requireSpec(graph, nodeId);
    const maxAttempts = spec.retry?.maxAttempts ?? 1;
    next = withNode(
      next,
      spec.recovery === "retry" && node.attempt < maxAttempts
        ? pendingAgain(node, now)
        : { ...node, status: "uncertain", uncertainReason: "process-lost", finishedAt: now },
    );
  }
  return bump(parkIfUncertain(next), now);
}

/**
 * W7: a cancel request found by a new owner. Orphaned attempts become
 * `uncertain` (their effects may have happened), waiting approvals and open
 * loops `cancelled`, and the run is cancelled. Nodes that were already
 * uncertain stay so. Needs only the record, not the definition.
 */
export function finalizeCancel(run: WorkflowRun, now: number): WorkflowRun {
  let next = run;
  for (const nodeId of orphanedNodes(run)) {
    const node = requireNode(next, nodeId);
    next = withNode(next, {
      ...node,
      status: "uncertain",
      uncertainReason: "process-lost",
      finishedAt: now,
    });
  }
  next = closeOpenNodes(next, "cancelled", now).run;
  return bump({ ...next, status: "cancelled" }, now);
}

/**
 * Before a terminal write: approval nodes still waiting become `cancelled`
 * (their requests can no longer be decided), and running loop nodes end too:
 * `failed` (`loop-body-failed`) when a node of the current iteration failed,
 * `cancelled` otherwise. Returns the changed nodes for events; no revision bump.
 */
export function closeOpenNodes(
  run: WorkflowRun,
  ending: "failed" | "cancelled",
  now: number,
): { run: WorkflowRun; closed: { nodeId: NodeId; status: "failed" | "cancelled" }[] } {
  let next = run;
  const closed: { nodeId: NodeId; status: "failed" | "cancelled" }[] = [];
  for (const node of Object.values(run.nodes)) {
    if (node.status === "waiting") {
      next = withNode(next, { ...node, status: "cancelled", finishedAt: now });
      closed.push({ nodeId: node.nodeId, status: "cancelled" });
    } else if (node.status === "running" && node.loop) {
      const prefix = iterationKey(node.nodeId, node.loop.iteration, "");
      const failed =
        ending === "failed"
          ? Object.values(run.nodes).find(
              (item) => item.nodeId.startsWith(prefix) && item.status === "failed",
            )
          : undefined;
      next = withNode(
        next,
        failed
          ? {
              ...node,
              status: "failed",
              error: {
                code: "loop-body-failed",
                message: `Node "${failed.nodeId}" failed in iteration ${node.loop.iteration}.`,
                retryable: false,
              },
              finishedAt: now,
            }
          : { ...node, status: "cancelled", finishedAt: now },
      );
      closed.push({ nodeId: node.nodeId, status: failed ? "failed" : "cancelled" });
    }
  }
  return { run: next, closed };
}

/** Approval nodes waiting for a decision. */
export function waitingNodes(run: WorkflowRun): NodeRun[] {
  return Object.values(run.nodes).filter((node) => node.status === "waiting");
}

/**
 * The nodes whose outputs a node receives as `predecessors` (and an approval
 * node shows as context): its own, or for a loop body entry node, the loop
 * node's.
 */
export function inputNodes(expanded: ExpandedGraph, run: WorkflowRun, nodeId: NodeId): NodeId[] {
  const loop = expanded.info.get(nodeId)?.loop;
  const source = loop?.entry ? loop.id : nodeId;
  return Object.keys(predecessorOutputs(expanded.graph, run, source));
}

/** W9: an approval node's request is recorded; the node waits for a decision. */
export function requestApproval(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  request: { requestId: string; context: readonly NodeId[] },
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  const spec = requireSpec(graph, nodeId);
  const approval: ApprovalRequest = {
    requestId: request.requestId,
    requestedAt: now,
    title: spec.approval?.title ?? nodeId,
    ...(spec.approval?.description !== undefined && { description: spec.approval.description }),
    context: [...request.context],
    onReject: spec.approval?.onReject ?? "fail",
  };
  return bump(withNode(run, { ...node, status: "waiting", startedAt: now, approval }), now);
}

/** An approval node's output for a decision. */
export function approvalOutput(decision: ApprovalDecision): ApprovalOutput {
  return {
    approved: decision.approved,
    requestId: decision.requestId,
    decidedAt: decision.decidedAt,
    ...(decision.decidedBy !== undefined && { decidedBy: decision.decidedBy }),
    ...(decision.comment !== undefined && { comment: decision.comment }),
  };
}

/** Whether a decision completes its approval node (approved, or rejected with `onReject: "continue"`). */
export function decisionCompletes(node: NodeRun, decision: ApprovalDecision): boolean {
  return decision.approved || node.approval?.onReject === "continue";
}

/**
 * W10: applies a decision to its waiting node, once: the caller checked that
 * the node is `waiting` with this `requestId`, and for a completing decision
 * decided the edges (as for W2). A rejection with `onReject: "fail"` fails the
 * node with `approval-rejected`. A `paused` run is `running` again.
 */
export function applyDecision(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  decision: ApprovalDecision,
  decisions: Record<string, boolean>,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  const output = approvalOutput(decision) as unknown as JsonValue;
  const base: WorkflowRun = { ...run, status: run.status === "paused" ? "running" : run.status };
  if (decisionCompletes(node, decision)) {
    return completeNode(graph, base, nodeId, output, decisions, now);
  }
  const by = decision.decidedBy ? ` by ${decision.decidedBy}` : "";
  const why = decision.comment ? `: ${decision.comment}` : ".";
  const error: NodeError = {
    code: "approval-rejected",
    message: `Approval "${node.approval?.title ?? nodeId}" was rejected${by}${why}`.slice(0, 1_000),
    retryable: false,
  };
  return failNode(withNode(base, { ...node, output }), nodeId, error, now);
}

/** W11: nothing can progress until a decision; the run waits without an owner. */
export function pauseRun(run: WorkflowRun, now: number): WorkflowRun {
  return bump({ ...run, status: "paused" }, now);
}

/** W12: a loop node starts its first iteration: its body nodes are created pending. */
export function startLoop(
  graph: WorkflowGraph,
  run: WorkflowRun,
  loopId: NodeId,
  now: number,
): WorkflowRun {
  const node = requireNode(run, loopId);
  const next = withNode(run, {
    ...node,
    status: "running",
    startedAt: now,
    loop: { iteration: 1, decisions: [] },
  });
  return bump(withIteration(requireSpec(graph, loopId), next, 1), now);
}

/**
 * W13 (continue): records `until` = false for the finished iteration and
 * creates the next iteration's body nodes, in one write, so an iteration is
 * never skipped or repeated.
 */
export function nextIteration(
  graph: WorkflowGraph,
  run: WorkflowRun,
  loopId: NodeId,
  now: number,
): WorkflowRun {
  const node = requireNode(run, loopId);
  const state = node.loop ?? { iteration: 0, decisions: [] };
  const iteration = state.iteration + 1;
  const next = withNode(run, {
    ...node,
    loop: { iteration, decisions: [...state.decisions, false] },
  });
  return bump(withIteration(requireSpec(graph, loopId), next, iteration), now);
}

/**
 * Records the finished iteration's `until` result on the loop node, before it
 * completes or fails (W13, stop). No revision bump: the completing write does it.
 */
export function recordLoopDecision(run: WorkflowRun, loopId: NodeId, until: boolean): WorkflowRun {
  const node = requireNode(run, loopId);
  const state = node.loop ?? { iteration: 0, decisions: [] };
  return withNode(run, { ...node, loop: { ...state, decisions: [...state.decisions, until] } });
}

function withIteration(spec: NodeSpec, run: WorkflowRun, iteration: number): WorkflowRun {
  let next = run;
  for (const body of spec.loop?.body.nodes ?? []) {
    const nodeId = iterationKey(spec.id, iteration, body.id);
    next = withNode(next, { nodeId, status: "pending", attempt: 0 });
  }
  return next;
}

/**
 * W8: applies a recovery action to an uncertain node and records it. For
 * `complete`, the caller has checked the output and decided the edges, as for
 * W2. The run returns to `running` once no node is uncertain, unless it failed.
 */
export function applyRecovery(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  action: RecoveryAction,
  decisions: Record<string, boolean>,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  const recoveries = [...(node.recoveries ?? []), { action: action.type, at: now }];
  let next: WorkflowRun;
  switch (action.type) {
    case "retry":
      next = withNode(run, { ...pendingAgain(node, now), recoveries });
      break;
    case "complete": {
      const { uncertainReason: _, error: __, ...rest } = node;
      // completeNode records the W2 contents and bumps the revision itself.
      next = completeNode(
        graph,
        withNode(run, { ...rest, recoveries }),
        nodeId,
        action.output,
        decisions,
        now,
      );
      break;
    }
    case "fail": {
      const error: NodeError = {
        code: "recovery-failed",
        message: (action.message ?? "Marked as failed by recoverNode.").slice(0, 1_000),
        retryable: false,
      };
      const { uncertainReason: _, ...rest } = node;
      next = withNode(run, { ...rest, status: "failed", error, recoveries, finishedAt: now });
      next = {
        ...next,
        status: "failed",
        error: { code: error.code, message: error.message, nodeId },
      };
      break;
    }
  }
  if (next.status === "needs-recovery" && !hasUncertain(next))
    next = { ...next, status: "running" };
  return action.type === "complete" ? next : bump(next, now);
}

/** The first failed node in declaration order, if any. */
export function firstFailedNode(
  graph: WorkflowGraph,
  run: WorkflowRun,
): { nodeId: NodeId; error: NodeError } | undefined {
  for (const spec of graph.nodes) {
    const node = run.nodes[spec.id];
    if (node?.status === "failed") {
      return {
        nodeId: spec.id,
        error: node.error ?? { code: "failed", message: "Node failed.", retryable: false },
      };
    }
  }
  return undefined;
}

/** The earliest `retryAt` still in the future among pending nodes, if any. */
export function nextRetryAt(run: WorkflowRun, now: number): number | undefined {
  let next: number | undefined;
  for (const node of Object.values(run.nodes)) {
    if (node.status === "pending" && node.retryAt !== undefined && node.retryAt > now) {
      next = next === undefined ? node.retryAt : Math.min(next, node.retryAt);
    }
  }
  return next;
}

/** Nodes that became `skipped` between two versions of a record. */
export function newlySkipped(before: WorkflowRun, after: WorkflowRun): NodeId[] {
  return Object.values(after.nodes)
    .filter((node) => node.status === "skipped" && before.nodes[node.nodeId]?.status !== "skipped")
    .map((node) => node.nodeId);
}

/** True when every node is completed or skipped. */
export function allNodesDone(run: WorkflowRun): boolean {
  return Object.values(run.nodes).every(
    (node) => node.status === "completed" || node.status === "skipped",
  );
}

/**
 * Skips every pending node whose incoming edges are all decided and inactive,
 * and decides that node's outgoing edges inactive, until nothing changes.
 */
function propagateSkips(graph: WorkflowGraph, run: WorkflowRun, now: number): WorkflowRun {
  let next = run;
  for (let changed = true; changed; ) {
    changed = false;
    for (const spec of graph.nodes) {
      const node = next.nodes[spec.id];
      if (node?.status !== "pending") continue;
      const incoming = incomingEdges(graph, spec.id);
      if (incoming.length === 0) continue;
      const decisions = incoming.map((edge) => next.edges[edgeKey(edge.from, edge.to)]);
      if (!decisions.every((decision) => decision === false)) continue;
      const edges = { ...next.edges };
      for (const edge of outgoingEdges(graph, spec.id)) edges[edgeKey(edge.from, edge.to)] = false;
      next = { ...withNode(next, { ...node, status: "skipped", finishedAt: now }), edges };
      changed = true;
    }
  }
  return next;
}

/** A node made ready to start again at `retryAt`; its attempt count and recoveries are kept. */
function pendingAgain(node: NodeRun, retryAt: number): NodeRun {
  return {
    nodeId: node.nodeId,
    status: "pending",
    attempt: node.attempt,
    retryAt,
    ...(node.selectedPredecessor !== undefined && {
      selectedPredecessor: node.selectedPredecessor,
    }),
    ...(node.recoveries && { recoveries: node.recoveries }),
  };
}

export function hasUncertain(run: WorkflowRun): boolean {
  return Object.values(run.nodes).some((node) => node.status === "uncertain");
}

function parkIfUncertain(run: WorkflowRun): WorkflowRun {
  return hasUncertain(run) ? { ...run, status: "needs-recovery" } : run;
}

export function predicateError(what: string, reason: unknown): NodeError {
  const message = reason instanceof Error ? reason.message : String(reason);
  return {
    code: "predicate-error",
    message: `${what} failed: ${message}`.slice(0, 1_000),
    retryable: false,
  };
}

function incomingEdges(graph: WorkflowGraph, nodeId: NodeId): EdgeSpec[] {
  return graph.edges.filter((edge) => edge.to === nodeId);
}

function outgoingEdges(graph: WorkflowGraph, nodeId: NodeId): EdgeSpec[] {
  return graph.edges.filter((edge) => edge.from === nodeId);
}

function requireNode(run: WorkflowRun, nodeId: NodeId): NodeRun {
  const node = run.nodes[nodeId];
  if (!node) throw new Error(`Unknown node "${nodeId}" in run ${run.runId}.`);
  return node;
}

function requireSpec(graph: WorkflowGraph, nodeId: NodeId): NodeSpec {
  const spec = graph.nodes.find((node) => node.id === nodeId);
  if (!spec) throw new Error(`Unknown node "${nodeId}".`);
  return spec;
}

function withNode(run: WorkflowRun, node: NodeRun): WorkflowRun {
  return { ...run, nodes: { ...run.nodes, [node.nodeId]: node } };
}

/** One revision per recorded change. */
function bump(run: WorkflowRun, now: number): WorkflowRun {
  return { ...run, revision: run.revision + 1, updatedAt: now };
}
