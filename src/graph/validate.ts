import { GraphValidationError } from "./errors.js";
import type { JsonValue, NodeId, WorkflowDefinition } from "./types.js";

/** `from->to`: the key of an edge decision in `WorkflowRun.edges`. */
export function edgeKey(from: NodeId, to: NodeId): string {
  return `${from}->${to}`;
}

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

  const ids = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || !node.id) {
      issues.push("every node needs a non-empty string id");
      continue;
    }
    if (node.id.includes("->")) issues.push(`node "${node.id}": id must not contain "->"`);
    if (ids.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (!Object.hasOwn(definition.handlers, node.handler)) {
      issues.push(`node "${node.id}": no handler registered as "${node.handler}"`);
    }
    issues.push(...nodeOptionIssues(node));
  }

  const incoming = new Map<NodeId, number>();
  const outgoing = new Map<NodeId, NodeId[]>();
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    const label = `edge ${edgeKey(edge.from, edge.to)}`;
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

  if (graph.entry.length === 0) issues.push("graph.entry must list at least one node");
  const entries = new Set<NodeId>();
  for (const id of graph.entry) {
    if (!ids.has(id)) issues.push(`entry "${id}" is not a node`);
    if (entries.has(id)) issues.push(`entry "${id}" is listed twice`);
    entries.add(id);
    if (incoming.has(id)) issues.push(`entry "${id}" must not have incoming edges`);
  }

  for (const node of graph.nodes) {
    if (node.join !== undefined && (incoming.get(node.id) ?? 0) < 2) {
      issues.push(`node "${node.id}": join is only valid with 2 or more incoming edges`);
    }
  }

  const cycle = findCycle(
    graph.nodes.map((node) => node.id),
    outgoing,
  );
  if (cycle) issues.push(`cycle: ${cycle.join(" -> ")}`);

  const reachable = new Set<NodeId>();
  const stack = [...entries].filter((id) => ids.has(id));
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
  for (const id of ids) {
    if (!reachable.has(id)) issues.push(`node "${id}" is unreachable from the entry nodes`);
  }

  if (issues.length > 0) throw new GraphValidationError(issues);
}

function nodeOptionIssues(node: WorkflowDefinition["graph"]["nodes"][number]): string[] {
  const issues: string[] = [];
  const at = `node "${node.id}"`;
  const positiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
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
