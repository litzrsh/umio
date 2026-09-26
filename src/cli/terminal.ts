/**
 * Terminal output: text, notes and a live status line. The status line and
 * heartbeats are driven by their own UI timer, which only redraws; it knows
 * nothing about node timeouts, leases or requests and never affects them.
 */
import type { Activity } from "./activity.js";
import { truncate } from "./format.js";
import type { Style } from "./style.js";

export interface OutputStream {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface Timers {
  now(): number;
  /** Repeats `tick`; returns a function that stops it. Must not keep the process alive. */
  every(ms: number, tick: () => void): () => void;
}

export const nodeTimers: Timers = {
  now: () => Date.now(),
  every(ms, tick) {
    const handle = setInterval(tick, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  },
};

export interface TerminalOptions {
  readonly style: Style;
  readonly quiet: boolean;
  readonly heartbeatMs: number;
  readonly env: Record<string, string | undefined>;
  readonly timers?: Timers;
}

const CLEAR_LINE = "\r\x1b[2K";
const REDRAW_MS = 1_000;

export class Terminal {
  readonly style: Style;
  readonly timers: Timers;
  private readonly quiet: boolean;
  private readonly heartbeatMs: number;
  /** stdout and stderr are the same terminal, so they share one cursor. */
  private readonly shared: boolean;
  /** The status line can be drawn (a TTY that understands cursor control). */
  private readonly live: boolean;
  private atLineStart = true;
  private statusVisible = false;
  private activity: Activity | undefined;
  private frame = 0;
  private stopTicker: (() => void) | undefined;
  private readonly onResize = () => this.redraw();

  constructor(
    readonly stdout: OutputStream,
    readonly stderr: OutputStream,
    options: TerminalOptions,
  ) {
    this.style = options.style;
    this.quiet = options.quiet;
    this.heartbeatMs = options.heartbeatMs;
    this.timers = options.timers ?? nodeTimers;
    this.shared = Boolean(stdout.isTTY && stderr.isTTY);
    this.live = Boolean(stderr.isTTY) && options.env.TERM !== "dumb";
  }

  /** Usable width, at least 20 columns, re-read on every call (terminals resize). */
  get width(): number {
    // 0 means unknown (e.g. a pseudo-terminal without a size).
    const columns = this.stderr.columns || this.stdout.columns || 80;
    return Math.max(20, columns);
  }

  get interactive(): boolean {
    return this.shared;
  }

  /** Streamed model text, to stdout as it arrives. */
  text(chunk: string): void {
    if (!chunk) return;
    this.clearStatus();
    this.stdout.write(chunk);
    if (this.shared || !this.stderr.isTTY) this.atLineStart = chunk.endsWith("\n");
  }

  /** Ends a partial line of streamed text. */
  endText(): void {
    if (!this.atLineStart) this.text("\n");
  }

  /** A line of results on stdout. */
  line(text = ""): void {
    this.endText();
    this.text(`${text}\n`);
  }

  /** A diagnostic or activity line on stderr (the same screen in a terminal). */
  note(text: string): void {
    if (this.quiet) return;
    this.forceNote(text);
  }

  /** Errors are shown even in quiet mode. */
  forceNote(text: string): void {
    this.clearStatus();
    if (this.shared && !this.atLineStart) {
      this.stdout.write("\n");
      this.atLineStart = true;
    }
    this.stderr.write(`${text}\n`);
  }

  /** Starts showing `activity`: a status line in a terminal, heartbeats otherwise. */
  startActivity(activity: Activity): void {
    this.stopActivity();
    this.activity = activity;
    if (this.live) {
      this.stderr.on?.("resize", this.onResize);
      this.stopTicker = this.timers.every(REDRAW_MS, () => {
        this.frame += 1;
        this.redraw();
      });
      this.redraw();
    } else if (!this.quiet && this.heartbeatMs > 0) {
      this.stopTicker = this.timers.every(this.heartbeatMs, () => {
        const now = this.timers.now();
        this.stderr.write(`umio: still running · ${activity.describe(now)}\n`);
      });
    }
  }

  /** Redraws the status line now, e.g. after a phase change. */
  refresh(): void {
    this.redraw();
  }

  stopActivity(): void {
    this.stopTicker?.();
    this.stopTicker = undefined;
    this.stderr.off?.("resize", this.onResize);
    this.clearStatus();
    this.activity = undefined;
  }

  private redraw(): void {
    if (!this.live || !this.activity) return;
    // Never draw over a partial line of model text.
    if (this.shared && !this.atLineStart) return;
    const { spinner } = this.style.symbols;
    const text = `${spinner[this.frame % spinner.length]} ${this.activity.describe(this.timers.now())}`;
    this.stderr.write(CLEAR_LINE + this.style.dim(truncate(text, this.width - 1)));
    this.statusVisible = true;
  }

  private clearStatus(): void {
    if (!this.statusVisible) return;
    this.stderr.write(CLEAR_LINE);
    this.statusVisible = false;
  }
}
