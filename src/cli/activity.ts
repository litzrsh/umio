/**
 * What the current operation is doing, for the status line and heartbeats.
 * Pure state with injected time: it only describes. It never ends, times out
 * or retries anything — silence from a model is shown, never treated as failure.
 */
import { formatDuration } from "./duration.js";

export type Phase =
  | { readonly kind: "model" }
  | { readonly kind: "tool"; readonly name: string }
  | {
      readonly kind: "graph";
      readonly running: readonly { readonly nodeId: string; readonly since: number }[];
      readonly done: number;
      readonly total: number;
    }
  | { readonly kind: "approval"; readonly name: string }
  | { readonly kind: "cancelling" };

/** After this long without output, the line says "still running" and when output last came. */
export const QUIET_AFTER_MS = 60_000;

export class Activity {
  readonly startedAt: number;
  private lastOutputAt: number | undefined;
  private phaseValue: Phase = { kind: "model" };
  private phaseSince: number;

  constructor(now: number, phase?: Phase) {
    this.startedAt = now;
    this.phaseSince = now;
    if (phase) this.phaseValue = phase;
  }

  get phase(): Phase {
    return this.phaseValue;
  }

  set(phase: Phase, now: number): void {
    if (this.phaseValue.kind === "cancelling" && phase.kind !== "cancelling") return;
    if (phase.kind !== this.phaseValue.kind) this.phaseSince = now;
    this.phaseValue = phase;
  }

  /** Records output (text, tool results, node events): proof of progress. */
  output(now: number): void {
    this.lastOutputAt = now;
  }

  /** One line of text, without spinner or styling. */
  describe(now: number): string {
    const elapsed = formatDuration(now - this.startedAt);
    const phase = this.phaseValue;
    switch (phase.kind) {
      case "cancelling":
        return `cancelling… · ${elapsed} · waiting for running work to stop`;
      case "approval":
        return `waiting for your answer: run ${phase.name}? [y]es [n]o [a]lways`;
      case "tool":
        return `running ${phase.name} · ${formatDuration(now - this.phaseSince)} · total ${elapsed}`;
      case "graph": {
        const nodes = phase.running
          .map((node) => `${node.nodeId} ${formatDuration(now - node.since)}`)
          .join(", ");
        return `${phase.running.length} running${nodes ? ` (${nodes})` : ""} · ${phase.done}/${phase.total} done · ${elapsed}${this.quietNote(now)}`;
      }
      default:
        if (this.lastOutputAt === undefined || this.lastOutputAt < this.phaseSince) {
          return now - this.phaseSince >= 30_000
            ? `waiting for model · ${elapsed} · no output yet — still running; long local prompts can take hours`
            : `waiting for model · ${elapsed}`;
        }
        return `receiving · ${elapsed}${this.quietNote(now)}`;
    }
  }

  private quietNote(now: number): string {
    if (this.lastOutputAt === undefined) return "";
    const quiet = now - this.lastOutputAt;
    return quiet >= QUIET_AFTER_MS
      ? ` · still running, last output ${formatDuration(quiet)} ago`
      : "";
  }
}
