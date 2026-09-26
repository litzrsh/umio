import { UmioError } from "../errors.js";

/** The workflow definition is invalid. `issues` lists every problem found, not just the first. */
export class GraphValidationError extends UmioError {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid workflow definition:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

/**
 * Throw from a node handler to control how the failure is recorded:
 * `code` is persisted, and `retryable` decides whether the retry policy applies.
 */
export class GraphNodeError extends UmioError {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, details: { code: string; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.code = details.code;
    this.retryable = details.retryable ?? false;
  }
}

/** No run with this ID exists in the checkpoint store. */
export class RunNotFoundError extends UmioError {
  constructor(readonly runId: string) {
    super(`Run "${runId}" not found.`);
  }
}

/**
 * A checkpoint write was rejected although this executor held a valid lease
 * (the stored revision moved), or a run was created under an existing ID.
 * Either means the single-writer invariant was broken; the executor stops
 * without writing anything more.
 */
export class CheckpointConflictError extends UmioError {
  constructor(
    readonly runId: string,
    message: string,
  ) {
    super(message);
  }
}

/** A checkpoint record has a `schemaVersion` this version of umio cannot read. */
export class CheckpointSchemaError extends UmioError {
  constructor(
    readonly runId: string,
    readonly schemaVersion: unknown,
  ) {
    super(`Run "${runId}" has unsupported checkpoint schemaVersion ${String(schemaVersion)}.`);
  }
}

/**
 * This executor no longer holds the run's lease: a renewal was refused, the
 * lease expired, or a write was fenced off. Running attempts were aborted and
 * nothing more was written; the next lease holder recovers the run.
 */
export class LeaseLostError extends UmioError {
  constructor(readonly runId: string) {
    super(`Lost the lease on run "${runId}"; stopped without further writes.`);
  }
}
