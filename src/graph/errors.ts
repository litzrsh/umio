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

/** The run cannot be resumed or recovered in its current status (e.g. it is terminal). */
export class RunNotResumableError extends UmioError {
  constructor(
    readonly runId: string,
    readonly status: string,
    reason?: string,
  ) {
    super(reason ?? `Run "${runId}" is ${status} and cannot be resumed.`);
  }
}

/**
 * The definition given to `resume()` or `recoverNode()` is not the one the run
 * was started with: its graph ID, version or structure hash differs.
 */
export class DefinitionMismatchError extends UmioError {
  constructor(
    readonly runId: string,
    readonly field: "workflowId" | "definitionVersion" | "definitionHash",
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Run "${runId}" was started with ${field} "${expected}", but the definition has "${actual}".`,
    );
  }
}

/**
 * Another owner holds the run's lease. If that owner crashed, its lease
 * expires at most `leaseTtlMs` after its last renewal; try again then.
 */
export class LeaseUnavailableError extends UmioError {
  constructor(
    readonly runId: string,
    readonly leaseTtlMs: number,
  ) {
    super(
      `Run "${runId}" is owned by another executor. If it crashed, its lease expires within ${leaseTtlMs} ms.`,
    );
  }
}

/** A `recoverNode()` action cannot be applied: the node is not uncertain, or the given output is invalid. */
export class RecoveryNotApplicableError extends UmioError {
  constructor(
    readonly runId: string,
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
  }
}

/** Another `FileCheckpointStore` instance, in this or another live process, uses the directory. */
export class CheckpointStoreLockedError extends UmioError {
  constructor(
    readonly dir: string,
    readonly pid: number,
  ) {
    super(`Checkpoint directory ${dir} is in use by process ${pid}.`);
  }
}
