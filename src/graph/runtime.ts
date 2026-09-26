import { randomUUID } from "node:crypto";

/**
 * Time, randomness and IDs used by the executor. Injected through the executor
 * constructor so tests can simulate hours of execution with a fake clock.
 * Internal: not re-exported from the package entry point.
 */
export interface RuntimeDependencies {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason if it aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** In [0, 1); used for backoff jitter. */
  random(): number;
  /** Unique IDs for runs and executor owners. */
  newId(): string;
  /** Calls `callback` after `ms`; returns a function that cancels it. */
  setTimer(ms: number, callback: () => void): () => void;
}

export const realDependencies: RuntimeDependencies = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  random: () => Math.random(),
  newId: () => randomUUID(),
  setTimer: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export function withDefaults(overrides: Partial<RuntimeDependencies> = {}): RuntimeDependencies {
  return { ...realDependencies, ...overrides };
}
