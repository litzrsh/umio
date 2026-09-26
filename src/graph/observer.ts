import type { RuntimeDependencies } from "./runtime.js";
import type { GraphRunEvent, RunObserver } from "./types.js";

/**
 * One run's event queue (plan D6). Events are delivered one at a time, in
 * order, after the scheduler has moved on: `push` never waits and never
 * throws. Observer errors go to `onError` (whose own errors are dropped).
 */
export class ObserverQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly observer: RunObserver | undefined,
    private readonly onError: ((error: unknown, event: GraphRunEvent) => void) | undefined,
  ) {}

  push(event: GraphRunEvent): void {
    const { observer } = this;
    if (!observer || this.closed) return;
    this.tail = this.tail.then(async () => {
      if (this.closed) return;
      try {
        await observer.emit(event);
      } catch (error) {
        try {
          this.onError?.(error, event);
        } catch {
          // Error handlers cannot affect the run either.
        }
      }
    });
  }

  /**
   * Waits at most `timeoutMs` for queued events to be delivered, then closes
   * the queue: undelivered and later events are dropped. Called only after the
   * run's status is persisted, so a timeout here never changes it.
   */
  async drain(timeoutMs: number, deps: RuntimeDependencies): Promise<void> {
    if (this.observer && !this.closed) {
      let cancel = () => {};
      const timeout = new Promise<void>((resolve) => {
        cancel = deps.setTimer(timeoutMs, resolve);
      });
      await Promise.race([this.tail, timeout]);
      cancel();
    }
    this.closed = true;
  }
}
