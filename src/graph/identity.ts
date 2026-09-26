import { createHash } from "node:crypto";
import { stableStringify } from "../cache/response.js";
import type { WorkflowDefinition } from "./types.js";

/**
 * SHA-256 over the graph structure and the handler and predicate keys. Detects
 * definition changes made without a version bump. It cannot see function
 * bodies: changing a handler's code under the same key still needs a version bump.
 * Object key order does not matter; array order (node declaration order,
 * edges, entry) does, because it affects scheduling.
 */
export function definitionHash(definition: WorkflowDefinition): string {
  const { graph } = definition;
  const material = {
    id: graph.id,
    version: graph.version,
    nodes: graph.nodes,
    edges: graph.edges,
    entry: graph.entry,
    handlers: Object.keys(definition.handlers).sort(),
    predicates: Object.keys(definition.predicates).sort(),
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}
