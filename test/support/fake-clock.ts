/**
 * A fake `RuntimeDependencies` for simulating hours of execution without
 * waiting. Time moves only through `advance(ms)`, which fires due timers in
 * time order (ties in creation order) and lets the promise chains they start
 * settle before the next one fires.
 */
interface Timer {
  at: number;
  seq: number;
  callback: () => void;
}

export class FakeClock {
  private time: number;
  private timers: Timer[] = [];
  private seq = 0;
  private ids = 0;
  /** Returned by `random()`; set it to control backoff jitter. */
  randomValue = 0.5;

  constructor(start = 0) {
    this.time = start;
  }

  // Arrow properties, so the instance can be spread or passed as dependencies.
  now = (): number => this.time;

  random = (): number => this.randomValue;

  newId = (): string => `id-${++this.ids}`;

  setTimer = (ms: number, callback: () => void): (() => void) => {
    const timer = { at: this.time + ms, seq: this.seq++, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((item) => item !== timer);
    };
  };

  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        cancel();
        reject(signal.reason);
      };
      const cancel = this.setTimer(ms, () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /** Moves time forward by `ms`, firing every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      const due = this.timers
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = end;
    await settle();
  }

  /** Advances in steps of `step` ms, e.g. to observe state between them. */
  async advanceBy(total: number, step: number, each?: () => void): Promise<void> {
    for (let elapsed = 0; elapsed < total; elapsed += step) {
      await this.advance(Math.min(step, total - elapsed));
      each?.();
    }
  }

  /** Timers not yet fired. */
  pendingTimers(): number {
    return this.timers.length;
  }
}

/** Lets pending promise chains run; they only use microtasks, never real timers. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) await new Promise((resolve) => setImmediate(resolve));
}
