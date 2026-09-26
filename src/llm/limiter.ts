/**
 * A FIFO semaphore capping in-flight provider requests. Waiting costs nothing
 * on the server: a queued request has not been sent, so its HTTP timeouts have
 * not started. A waiter whose signal aborts leaves the queue without ever
 * taking a slot.
 */
export class RequestLimiter {
  private active = 0;
  private readonly waiters: {
    grant: () => void;
    cleanup: () => void;
  }[] = [];

  constructor(readonly max: number) {
    if (!(max >= 1)) throw new RangeError(`maxConcurrentRequests must be at least 1, got ${max}.`);
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a release function once a slot is free. The release function
   * is idempotent. Rejects with `onAbort()`'s error if `signal` aborts first.
   */
  acquire(signal: AbortSignal | undefined, onAbort: () => unknown): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(onAbort());
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          waiter.cleanup();
          this.active++;
          resolve(this.releaser());
        },
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.cleanup();
        reject(onAbort());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.grant();
    };
  }
}
