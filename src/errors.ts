export class UmioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The configuration file is missing, is not valid JSON, or fails validation. */
export class ConfigError extends UmioError {}

/** A provider request failed. `retryable` is true for rate limits, overload, 5xx and network errors. */
export class LLMError extends UmioError {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { provider: string; status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.provider = details.provider;
    this.status = details.status;
    this.retryable = details.retryable;
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // no HTTP response: connection error or timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
