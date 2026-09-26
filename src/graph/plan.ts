/**
 * Pure scheduling over a run record: which nodes are ready, what a node's
 * success changes, and whether the run is finished. No I/O and no clock beyond
 * the `now` argument, so every rule can be tested exhaustively.
 *
 * Edge decisions are made exactly once, when the source node completes (or is
 * skipped), and recorded in `run.edges`. Readiness, skips and join selection
 * are derived from those recorded decisions only, never re-evaluated (I3).
 */
import type {
  EdgeSpec,
  JsonValue,
  NodeError,
  NodeId,
  NodeRun,
  NodeSpec,
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
    schemaVersion: 1,
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
 * Decides a completed node's outgoing edges. Predicates are pure and synchronous;
 * one that throws or returns a non-boolean fails the node (`predicate-error`).
 */
export function decideEdges(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  nodeId: NodeId,
  output: JsonValue,
): { ok: true; decisions: Record<string, boolean> } | { ok: false; error: NodeError } {
  const decisions: Record<string, boolean> = {};
  for (const edge of outgoingEdges(definition.graph, nodeId)) {
    if (edge.when === undefined) {
      decisions[edgeKey(edge.from, edge.to)] = true;
      continue;
    }
    let decision: unknown;
    try {
      decision = definition.predicates[edge.when]?.(output, run.input);
    } catch (error) {
      return { ok: false, error: predicateError(edge, error) };
    }
    if (typeof decision !== "boolean") {
      return {
        ok: false,
        error: predicateError(edge, `returned ${typeof decision}, expected boolean`),
      };
    }
    decisions[edgeKey(edge.from, edge.to)] = decision;
  }
  return { ok: true, decisions };
}

/** W1: the attempt is recorded before the handler is invoked. */
export function startAttempt(run: WorkflowRun, nodeId: NodeId, now: number): WorkflowRun {
  const node = requireNode(run, nodeId);
  const { retryAt: _, ...rest } = node;
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

/** W4: an attempt stopped because the run is failing or being cancelled. */
export function cancelAttempt(run: WorkflowRun, nodeId: NodeId, now: number): WorkflowRun {
  const node = requireNode(run, nodeId);
  return bump(withNode(run, { ...node, status: "cancelled", finishedAt: now }), now);
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

function predicateError(edge: EdgeSpec, reason: unknown): NodeError {
  const message = reason instanceof Error ? reason.message : String(reason);
  return {
    code: "predicate-error",
    message:
      `Predicate "${edge.when}" on edge ${edgeKey(edge.from, edge.to)} failed: ${message}`.slice(
        0,
        1_000,
      ),
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
