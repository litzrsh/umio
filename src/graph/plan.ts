/**
 * Pure scheduling over a run record: which nodes are ready, what a node's
 * success changes, and whether the run is finished. No I/O, no clocks beyond
 * the `now` argument, so every rule can be tested exhaustively.
 */

import type {
  JsonValue,
  NodeId,
  NodeRun,
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
 * Nodes that may start now, in declaration order: pending, past any `retryAt`,
 * and (for `join: "all"`) every incoming edge decided active with a completed source.
 */
export function readyNodes(graph: WorkflowGraph, run: WorkflowRun, now: number): NodeId[] {
  return graph.nodes
    .filter((node) => {
      const state = run.nodes[node.id];
      if (state?.status !== "pending") return false;
      if (state.retryAt !== undefined && state.retryAt > now) return false;
      return incomingEdges(graph, node.id).every(
        (edge) =>
          run.edges[edgeKey(edge.from, edge.to)] === true &&
          run.nodes[edge.from]?.status === "completed",
      );
    })
    .map((node) => node.id);
}

/** Outputs of completed predecessors whose edge to `nodeId` is active, keyed in node-ID order. */
export function predecessorOutputs(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
): Record<NodeId, JsonValue> {
  const outputs: Record<NodeId, JsonValue> = {};
  const sources = incomingEdges(graph, nodeId)
    .filter(
      (edge) =>
        run.edges[edgeKey(edge.from, edge.to)] === true &&
        run.nodes[edge.from]?.status === "completed",
    )
    .map((edge) => edge.from)
    .sort();
  for (const source of sources) outputs[source] = run.nodes[source]?.output ?? null;
  return outputs;
}

/** W1: the attempt is recorded before the handler is invoked. */
export function startAttempt(run: WorkflowRun, nodeId: NodeId, now: number): WorkflowRun {
  const node = requireNode(run, nodeId);
  const { retryAt: _, ...rest } = node;
  return withNode(
    run,
    { ...rest, status: "running", attempt: node.attempt + 1, startedAt: now },
    now,
  );
}

/**
 * W2: output, completion and the node's outgoing edge decisions, in one change.
 * P1 supports unconditional edges only, so every outgoing edge becomes active.
 */
export function completeNode(
  graph: WorkflowGraph,
  run: WorkflowRun,
  nodeId: NodeId,
  output: JsonValue,
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  const edges = { ...run.edges };
  for (const edge of graph.edges) {
    if (edge.from === nodeId) edges[edgeKey(edge.from, edge.to)] = true;
  }
  const next = withNode(run, { ...node, status: "completed", output, finishedAt: now }, now);
  return { ...next, edges };
}

/** W3 without retries: the node fails. */
export function failNode(
  run: WorkflowRun,
  nodeId: NodeId,
  error: { code: string; message: string; retryable: boolean },
  now: number,
): WorkflowRun {
  const node = requireNode(run, nodeId);
  return withNode(run, { ...node, status: "failed", error, finishedAt: now }, now);
}

/** W5: the run's terminal status. */
export function finishRun(
  run: WorkflowRun,
  status: "completed" | "failed",
  now: number,
  error?: WorkflowRun["error"],
): WorkflowRun {
  return { ...run, status, revision: run.revision + 1, updatedAt: now, ...(error && { error }) };
}

/** True when every node is completed or skipped. */
export function allNodesDone(run: WorkflowRun): boolean {
  return Object.values(run.nodes).every(
    (node) => node.status === "completed" || node.status === "skipped",
  );
}

function incomingEdges(graph: WorkflowGraph, nodeId: NodeId) {
  return graph.edges.filter((edge) => edge.to === nodeId);
}

function requireNode(run: WorkflowRun, nodeId: NodeId): NodeRun {
  const node = run.nodes[nodeId];
  if (!node) throw new Error(`Unknown node "${nodeId}" in run ${run.runId}.`);
  return node;
}

function withNode(run: WorkflowRun, node: NodeRun, now: number): WorkflowRun {
  return {
    ...run,
    nodes: { ...run.nodes, [node.nodeId]: node },
    revision: run.revision + 1,
    updatedAt: now,
  };
}
