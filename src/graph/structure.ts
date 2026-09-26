/**
 * The flat view of a definition that the scheduler works on. Loop bodies are
 * instantiated per started iteration under keys `<loopId>#<iteration>/<bodyId>`,
 * so every node execution has its own record, edge decisions and idempotency
 * key, and the DAG rules (readiness, joins, skips) apply unchanged inside an
 * iteration. Pure: derived from the definition and the run record only.
 */
import type {
  JsonValue,
  NodeId,
  NodeSpec,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowRun,
} from "./types.js";

export type NodeKind = "task" | "approval" | "loop";

export interface NodeInfo {
  readonly kind: NodeKind;
  /** Set for loop body nodes. */
  readonly loop?: {
    readonly id: NodeId;
    readonly iteration: number;
    readonly bodyId: NodeId;
    /** A body entry node: its inputs are the loop node's predecessors. */
    readonly entry: boolean;
    /** No outgoing body edges: its output is part of the iteration's output. */
    readonly exit: boolean;
  };
}

export interface ExpandedGraph {
  /** Top-level nodes (loop nodes included), each started iteration's body nodes right after their loop node. */
  readonly graph: WorkflowGraph;
  readonly info: ReadonlyMap<NodeId, NodeInfo>;
}

export function nodeKind(spec: NodeSpec): NodeKind {
  if (spec.loop !== undefined) return "loop";
  if (spec.approval !== undefined) return "approval";
  return "task";
}

/** The checkpoint identity of a loop body node in one iteration. */
export function iterationKey(loopId: NodeId, iteration: number, bodyId: NodeId): NodeId {
  return `${loopId}#${iteration}/${bodyId}`;
}

/** Whether runs of this definition need checkpoint schema version 2. */
export function usesSchemaV2(definition: WorkflowDefinition): boolean {
  return definition.graph.nodes.some((node) => nodeKind(node) !== "task");
}

export function expandGraph(graph: WorkflowGraph, run: WorkflowRun): ExpandedGraph {
  const info = new Map<NodeId, NodeInfo>();
  if (!graph.nodes.some((node) => node.loop)) {
    for (const node of graph.nodes) info.set(node.id, { kind: nodeKind(node) });
    return { graph, info };
  }
  const nodes: NodeSpec[] = [];
  const edges = [...graph.edges];
  for (const spec of graph.nodes) {
    nodes.push(spec);
    info.set(spec.id, { kind: nodeKind(spec) });
    const loop = spec.loop;
    if (!loop) continue;
    const exits = new Set(
      loop.body.nodes
        .map((node) => node.id)
        .filter((id) => !loop.body.edges.some((edge) => edge.from === id)),
    );
    const iterations = run.nodes[spec.id]?.loop?.iteration ?? 0;
    for (let iteration = 1; iteration <= iterations; iteration++) {
      const key = (id: NodeId) => iterationKey(spec.id, iteration, id);
      for (const body of loop.body.nodes) {
        nodes.push({ ...body, id: key(body.id) });
        info.set(key(body.id), {
          kind: nodeKind(body),
          loop: {
            id: spec.id,
            iteration,
            bodyId: body.id,
            entry: loop.body.entry.includes(body.id),
            exit: exits.has(body.id),
          },
        });
      }
      for (const edge of loop.body.edges) {
        edges.push({ ...edge, from: key(edge.from), to: key(edge.to) });
      }
    }
  }
  return { graph: { ...graph, nodes, edges }, info };
}

/** Keys of one iteration's body nodes. */
export function iterationNodes(spec: NodeSpec, iteration: number): NodeId[] {
  return (spec.loop?.body.nodes ?? []).map((node) => iterationKey(spec.id, iteration, node.id));
}

/**
 * `done` when every body node of the iteration completed or was skipped;
 * `open` while any is pending, running or waiting; `stopped` when one
 * failed, was cancelled or is uncertain (the run is halting or parking).
 */
export function iterationState(
  spec: NodeSpec,
  run: WorkflowRun,
  iteration: number,
): "done" | "open" | "stopped" {
  let open = false;
  for (const key of iterationNodes(spec, iteration)) {
    const status = run.nodes[key]?.status;
    if (status === "completed" || status === "skipped") continue;
    if (status === "failed" || status === "cancelled" || status === "uncertain") return "stopped";
    open = true;
  }
  return open ? "open" : "done";
}

/** An iteration's output: its completed exit nodes' outputs, by body node ID. */
export function iterationOutput(
  spec: NodeSpec,
  run: WorkflowRun,
  iteration: number,
): { [bodyId: string]: JsonValue } {
  const body = spec.loop?.body;
  const output: { [bodyId: string]: JsonValue } = {};
  if (!body) return output;
  for (const node of body.nodes) {
    if (body.edges.some((edge) => edge.from === node.id)) continue;
    const state = run.nodes[iterationKey(spec.id, iteration, node.id)];
    if (state?.status === "completed") output[node.id] = state.output ?? null;
  }
  return output;
}
