/**
 * Retry decisions and backoff for failed attempts. Pure: randomness comes in
 * as an argument so tests can pin exact delays.
 */
import type { NodeError, RetryPolicy } from "./types.js";

export const DEFAULT_RETRY_MULTIPLIER = 2;

/** Whether a failed attempt may run again: the error is retryable and attempts remain. */
export function shouldRetry(
  policy: RetryPolicy | undefined,
  attempt: number,
  error: NodeError,
): boolean {
  return error.retryable && attempt < (policy?.maxAttempts ?? 1);
}

/**
 * The delay before the attempt after `attempt` (1-based), with full jitter:
 * a uniform value in [0, cap), where cap = initialDelayMs × multiplier^(attempt − 1),
 * limited to `maxDelayMs`. `random` is in [0, 1).
 */
export function retryDelay(
  policy: RetryPolicy | undefined,
  attempt: number,
  random: () => number,
): number {
  if (!policy) return 0;
  const multiplier = policy.multiplier ?? DEFAULT_RETRY_MULTIPLIER;
  const cap = Math.min(
    policy.maxDelayMs ?? Number.POSITIVE_INFINITY,
    policy.initialDelayMs * multiplier ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * cap);
}
