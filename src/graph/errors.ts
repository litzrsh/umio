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
