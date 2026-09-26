import { GraphValidationError } from "./errors.js";
import type { JsonValue, NodeId, NodeSpec, WorkflowDefinition, WorkflowGraph } from "./types.js";

/** `from->to`: the key of an edge decision in `WorkflowRun.edges`. */
export function edgeKey(from: NodeId, to: NodeId): string {
  return `${from}->${to}`;
}

/** Upper bound for `LoopSpec.maxIterations`: keeps the run record bounded. */
export const MAX_LOOP_ITERATIONS = 10_000;

/**
 * Checks a definition before any run starts. Collects every issue and throws
 * one `GraphValidationError` listing them all.
 */
export function validateDefinition(definition: WorkflowDefinition): void {
  const issues: string[] = [];
  const { graph } = definition;

  if (!isJsonValue(graph as unknown)) {
    issues.push(
      "graph must contain only JSON values (no functions, undefined, NaN or class instances)",
    );
  }
  if (typeof graph.id !== "string" || !graph.id) issues.push("graph.id must be a non-empty string");
  if (typeof graph.version !== "string" || !graph.version) {
    issues.push("graph.version must be a non-empty string");
  }

  const topIds = new Set(graph.nodes.map((node) => node.id));
  checkGraph(definition, graph, "", issues);

  for (const node of graph.nodes) {
    const loop = node.loop;
    if (!loop || typeof loop !== "object") continue;
    const at = `loop "${node.id}"`;
    if (typeof node.id === "string" && node.id.includes("#")) {
      issues.push(`${at}: a loop node id must not contain "#"`);
    }
    for (const other of topIds) {
      if (other.startsWith(`${node.id}#`)) {
        issues.push(`node "${other}": id clashes with the iteration keys of ${at}`);
      }
    }
    if (typeof loop.until !== "string" || !Object.hasOwn(definition.predicates, loop.until)) {
      issues.push(
        `${at}: until must name a registered predicate (got ${JSON.stringify(loop.until)})`,
      );
    }
    if (
      !Number.isInteger(loop.maxIterations) ||
      loop.maxIterations < 1 ||
      loop.maxIterations > MAX_LOOP_ITERATIONS
    ) {
      issues.push(
        `${at}: maxIterations is required and must be an integer from 1 to ${MAX_LOOP_ITERATIONS}`,
      );
    }
    if (
      loop.onExhausted !== undefined &&
      loop.onExhausted !== "fail" &&
      loop.onExhausted !== "complete"
    ) {
      issues.push(`${at}: onExhausted must be "fail" or "complete"`);
    }
    const body = loop.body;
    if (
      !body ||
      !Array.isArray(body.nodes) ||
      !Array.isArray(body.edges) ||
      !Array.isArray(body.entry)
    ) {
      issues.push(`${at}: body must have nodes, edges and entry arrays`);
      continue;
    }
    for (const inner of body.nodes) {
      if (typeof inner.id !== "string") continue;
      if (inner.id.includes("#"))
        issues.push(`${at}: body node "${inner.id}": id must not contain "#"`);
      if (topIds.has(inner.id)) {
        issues.push(`${at}: body node "${inner.id}" has the same id as a top-level node`);
      }
      if (inner.loop !== undefined)
        issues.push(`${at}: body node "${inner.id}": loops cannot be nested`);
    }
    checkGraph(definition, body, `${at} body: `, issues);
  }

  if (issues.length > 0) throw new GraphValidationError(issues);
}

/** The DAG rules, for the top-level graph or a loop body (`prefix` labels the latter). */
function checkGraph(
  definition: WorkflowDefinition,
  graph: Pick<WorkflowGraph, "nodes" | "edges" | "entry">,
  prefix: string,
  issues: string[],
): void {
  const ids = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || !node.id) {
      issues.push(`${prefix}every node needs a non-empty string id`);
      continue;
    }
    if (node.id.includes("->")) issues.push(`${prefix}node "${node.id}": id must not contain "->"`);
    if (ids.has(node.id)) issues.push(`${prefix}duplicate node id "${node.id}"`);
    ids.add(node.id);
    issues.push(...nodeOptionIssues(node, definition).map((issue) => prefix + issue));
  }

  const incoming = new Map<NodeId, number>();
  const outgoing = new Map<NodeId, NodeId[]>();
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    const label = `${prefix}edge ${edgeKey(edge.from, edge.to)}`;
    if (!ids.has(edge.from)) issues.push(`${label}: unknown source node "${edge.from}"`);
    if (!ids.has(edge.to)) issues.push(`${label}: unknown target node "${edge.to}"`);
    if (seenEdges.has(edgeKey(edge.from, edge.to))) issues.push(`${label}: duplicate edge`);
    seenEdges.add(edgeKey(edge.from, edge.to));
    if (edge.when !== undefined && !Object.hasOwn(definition.predicates, edge.when)) {
      issues.push(`${label}: no predicate registered as "${edge.when}"`);
    }
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  if (graph.entry.length === 0) issues.push(`${prefix}entry must list at least one node`);
  const entries = new Set<NodeId>();
  for (const id of graph.entry) {
    if (!ids.has(id)) issues.push(`${prefix}entry "${id}" is not a node`);
    if (entries.has(id)) issues.push(`${prefix}entry "${id}" is listed twice`);
    entries.add(id);
    if (incoming.has(id)) issues.push(`${prefix}entry "${id}" must not have incoming edges`);
  }

  for (const node of graph.nodes) {
    if (node.join !== undefined && (incoming.get(node.id) ?? 0) < 2) {
      issues.push(`${prefix}node "${node.id}": join is only valid with 2 or more incoming edges`);
    }
    if (node.approval?.onReject === "continue") {
      const unconditional = graph.edges.filter(
        (edge) => edge.from === node.id && edge.when === undefined,
      );
      for (const edge of unconditional) {
        issues.push(
          `${prefix}edge ${edgeKey(edge.from, edge.to)}: an approval with onReject "continue" needs a when predicate on every outgoing edge, so a rejection cannot pass through by default`,
        );
      }
    }
  }

  const cycle = findCycle(
    graph.nodes.map((node) => node.id),
    outgoing,
  );
  if (cycle) {
    issues.push(
      `${prefix}cycle: ${cycle.join(" -> ")} (graphs must be acyclic; repeat work with an explicit loop node)`,
    );
  }

  const reachable = new Set<NodeId>();
  const stack = [...entries].filter((id) => ids.has(id));
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
  for (const id of ids) {
    if (!reachable.has(id))
      issues.push(`${prefix}node "${id}" is unreachable from the entry nodes`);
  }
}

function nodeOptionIssues(node: NodeSpec, definition: WorkflowDefinition): string[] {
  const issues: string[] = [];
  const at = `node "${node.id}"`;
  const positiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
  const kinds = [node.handler !== undefined, node.approval !== undefined, node.loop !== undefined];
  const count = kinds.filter(Boolean).length;
  if (count !== 1) {
    issues.push(
      count === 0
        ? `${at}: set one of handler (task), approval or loop`
        : `${at}: set only one of handler, approval and loop`,
    );
  }
  if (node.handler !== undefined && !Object.hasOwn(definition.handlers, node.handler)) {
    issues.push(`${at}: no handler registered as "${node.handler}"`);
  }
  if (node.handler === undefined) {
    const taskOnly = (["retry", "timeoutMs", "inactivityTimeoutMs", "recovery"] as const).filter(
      (key) => node[key] !== undefined,
    );
    for (const key of taskOnly) issues.push(`${at}: ${key} applies to task nodes only`);
  }
  if (node.approval !== undefined) {
    const { title, description, onReject } = node.approval ?? {};
    if (typeof title !== "string" || !title.trim()) {
      issues.push(`${at}: approval.title must be a non-empty string`);
    }
    if (description !== undefined && typeof description !== "string") {
      issues.push(`${at}: approval.description must be a string`);
    }
    if (onReject !== undefined && onReject !== "fail" && onReject !== "continue") {
      issues.push(`${at}: approval.onReject must be "fail" or "continue"`);
    }
  }
  if (node.join !== undefined && node.join !== "all" && node.join !== "any") {
    issues.push(`${at}: join must be "all" or "any"`);
  }
  if (node.recovery !== undefined && node.recovery !== "manual" && node.recovery !== "retry") {
    issues.push(`${at}: recovery must be "manual" or "retry"`);
  }
  if (node.timeoutMs !== undefined && node.timeoutMs !== null && !positiveInt(node.timeoutMs)) {
    issues.push(`${at}: timeoutMs must be a positive integer or null`);
  }
  if (node.inactivityTimeoutMs !== undefined && !positiveInt(node.inactivityTimeoutMs)) {
    issues.push(`${at}: inactivityTimeoutMs must be a positive integer`);
  }
  if (node.maxOutputBytes !== undefined && !positiveInt(node.maxOutputBytes)) {
    issues.push(`${at}: maxOutputBytes must be a positive integer`);
  }
  if (node.retry !== undefined) {
    const { maxAttempts, initialDelayMs, maxDelayMs, multiplier } = node.retry;
    if (!positiveInt(maxAttempts))
      issues.push(`${at}: retry.maxAttempts must be a positive integer`);
    if (!(Number.isFinite(initialDelayMs) && initialDelayMs >= 0)) {
      issues.push(`${at}: retry.initialDelayMs must be a non-negative number`);
    }
    if (
      maxDelayMs !== undefined &&
      !(Number.isFinite(maxDelayMs) && maxDelayMs >= initialDelayMs)
    ) {
      issues.push(`${at}: retry.maxDelayMs must be at least initialDelayMs`);
    }
    if (multiplier !== undefined && !(Number.isFinite(multiplier) && multiplier >= 1)) {
      issues.push(`${at}: retry.multiplier must be at least 1`);
    }
  }
  return issues;
}

/** Returns one cycle as a node path (first node repeated at the end), or undefined. */
function findCycle(ids: NodeId[], outgoing: Map<NodeId, NodeId[]>): NodeId[] | undefined {
  const state = new Map<NodeId, "visiting" | "done">();
  const path: NodeId[] = [];
  const visit = (id: NodeId): NodeId[] | undefined => {
    const current = state.get(id);
    if (current === "done") return undefined;
    if (current === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of ids) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/** True for plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects. */
export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false; // cycle
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  const ok = items.every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return ok;
}
