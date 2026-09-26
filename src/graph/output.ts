import type { JsonValue, NodeError, WorkflowRun } from "./types.js";
import { isJsonValue } from "./validate.js";

/**
 * A reference to a large artifact stored outside the checkpoint. umio defines
 * the shape only; it never reads, fetches, validates or deletes the target.
 *
 * - Creating: the handler writes the artifact with its own storage client,
 *   under a key derived from `context.idempotencyKey` (so a repeated attempt
 *   overwrites instead of duplicating), and returns the reference.
 * - Resolving: a downstream handler finds the reference in `predecessors`,
 *   reads it with its own client and verifies `sha256` and `bytes`.
 * - Retention: the application's. Deleting a run's checkpoint does not delete
 *   its artifacts; never delete artifacts of a run that is not terminal.
 */
export interface ArtifactRef {
  readonly $artifact: {
    /** A location the application can resolve: file://, s3://, kv:<key>, … */
    readonly uri: string;
    /** Hex SHA-256 of the stored bytes. */
    readonly sha256: string;
    /** Size of the stored bytes. */
    readonly bytes: number;
    readonly mediaType?: string;
  };
}

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (value === null || typeof value !== "object" || !("$artifact" in value)) return false;
  const ref = (value as { $artifact: unknown }).$artifact;
  if (ref === null || typeof ref !== "object") return false;
  const { uri, sha256, bytes, mediaType } = ref as Record<string, unknown>;
  return (
    typeof uri === "string" &&
    uri.length > 0 &&
    typeof sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(sha256) &&
    Number.isInteger(bytes) &&
    (bytes as number) >= 0 &&
    (mediaType === undefined || typeof mediaType === "string")
  );
}

/** Every `ArtifactRef` in a run's node outputs, e.g. for retention cleanup after the run ends. */
export function collectArtifactRefs(run: WorkflowRun): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const visit = (value: JsonValue | undefined) => {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (isArtifactRef(value)) {
      refs.push(value);
      return;
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item);
  };
  for (const node of Object.values(run.nodes)) visit(node.output);
  return refs;
}

/**
 * Validates a handler's return value before it is checkpointed. Failures are
 * non-retryable: re-running the handler would repeat any side effect it
 * performed, so the message says the effect may already have happened.
 */
export function checkOutput(
  output: unknown,
  limits: { maxOutputBytes: number; nodeId: string; idempotencyKey: string },
): NodeError | undefined {
  const effect = `its side effects, if any, may already have happened (idempotency key ${limits.idempotencyKey})`;
  if (!isJsonValue(output)) {
    return {
      code: "output-not-json",
      message: `Node "${limits.nodeId}" returned a value that is not JSON; ${effect}.`,
      retryable: false,
    };
  }
  const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (bytes > limits.maxOutputBytes) {
    return {
      code: "output-too-large",
      message: `Node "${limits.nodeId}" returned ${bytes} bytes, over the ${limits.maxOutputBytes}-byte limit; return an ArtifactRef for large results. ${effect[0]?.toUpperCase()}${effect.slice(1)}.`,
      retryable: false,
    };
  }
  return undefined;
}
