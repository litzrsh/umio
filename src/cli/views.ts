/**
 * Terminal implementations of the adapters' views: they turn chat and graph
 * events into lines on a `Terminal` and phases on an `Activity`.
 */
import type { StoredRunSnapshot } from "../graph/checkpoint/file.js";
import type { GraphRunEvent, WorkflowDefinition, WorkflowRun } from "../graph/types.js";
import type { GenerateResult, ToolCallPart } from "../llm/types.js";
import type { ToolExecution } from "../tools/execute.js";
import type { Activity } from "./activity.js";
import type { ChatView } from "./chat.js";
import { formatDuration } from "./duration.js";
import {
  nodeTable,
  oneLine,
  recoveryBlock,
  runStatusLabel,
  toolResultLines,
  toolStartLine,
  truncate,
} from "./format.js";
import type { GraphRunView } from "./graph.js";
import { ownership, type StoreHolder } from "./graph.js";
import type { Terminal } from "./terminal.js";

export class TerminalChatView implements ChatView {
  constructor(
    private readonly terminal: Terminal,
    private readonly activity: Activity,
    private readonly options: { verbose: boolean; showTools: boolean },
  ) {}

  waiting(): void {
    this.activity.set({ kind: "model" }, this.terminal.timers.now());
    this.terminal.refresh();
  }

  text(delta: string): void {
    this.activity.output(this.terminal.timers.now());
    this.terminal.text(delta);
  }

  modelFinished(_result: GenerateResult): void {
    this.terminal.endText();
  }

  toolStarted(call: ToolCallPart): void {
    this.activity.set({ kind: "tool", name: call.name }, this.terminal.timers.now());
    if (this.options.showTools) {
      this.terminal.note(toolStartLine(call, this.terminal.style, this.terminal.width));
    }
    this.terminal.refresh();
  }

  toolFinished(execution: ToolExecution): void {
    this.activity.output(this.terminal.timers.now());
    if (!this.options.showTools) return;
    for (const line of toolResultLines(
      execution,
      this.terminal.style,
      this.terminal.width,
      this.options.verbose,
    )) {
      this.terminal.note(line);
    }
  }
}

/** Prints graph events as lines and keeps the status line's phase current. */
export class TerminalGraphView implements GraphRunView {
  private readonly running = new Map<string, number>();
  private readonly finished = new Set<string>();
  private total = 0;
  runId: string | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly activity: Activity,
  ) {}

  definition(definition: WorkflowDefinition): void {
    this.total = definition.graph.nodes.length;
  }

  event(event: GraphRunEvent): void {
    const { style } = this.terminal;
    const { symbols } = style;
    const at = event.at;
    switch (event.type) {
      case "run-start":
      case "run-resume":
        this.runId = event.runId;
        this.terminal.note(
          style.bold(`${event.type === "run-start" ? "Run" : "Resuming"} ${event.runId}`),
        );
        break;
      case "node-start":
        this.running.set(event.nodeId, at);
        this.terminal.note(
          style.cyan(`${symbols.running} ${event.nodeId} started`) +
            style.dim(` (attempt ${event.attempt})`),
        );
        break;
      case "node-event":
        this.activity.output(at);
        if (event.event.type === "agent-event" && event.event.event.type === "tool-result") {
          const [line] = toolResultLines(
            event.event.event.execution,
            style,
            this.terminal.width - 2,
          );
          if (line) this.terminal.note(`${style.dim(`[${event.nodeId}]`)}${line}`);
        }
        break;
      case "node-retry":
        this.running.delete(event.nodeId);
        this.terminal.note(
          style.yellow(`${symbols.retry} ${event.nodeId} will retry`) +
            style.dim(
              ` in ${formatDuration(Math.max(0, event.retryAt - at))} (attempt ${event.attempt} failed)`,
            ),
        );
        break;
      case "node-finish": {
        const started = this.running.get(event.nodeId);
        this.running.delete(event.nodeId);
        this.finished.add(event.nodeId);
        const time = started !== undefined ? ` · ${formatDuration(at - started)}` : "";
        const label =
          event.status === "completed"
            ? style.green(`${symbols.ok} ${event.nodeId} completed`)
            : event.status === "failed"
              ? style.red(`${symbols.error} ${event.nodeId} failed`)
              : event.status === "uncertain"
                ? style.yellow(
                    `${symbols.uncertain} ${event.nodeId} uncertain — may have had side effects`,
                  )
                : style.dim(`${symbols.cancelled} ${event.nodeId} ${event.status}`);
        this.terminal.note(label + style.dim(time));
        break;
      }
      case "run-cancel-requested":
        this.activity.set({ kind: "cancelling" }, at);
        this.terminal.note(
          style.yellow(`${symbols.cancelled} cancel requested — stopping running nodes`),
        );
        break;
      default:
        break;
    }
    this.activity.set(
      {
        kind: "graph",
        running: [...this.running].map(([nodeId, since]) => ({ nodeId, since })),
        done: this.finished.size,
        total: this.total,
      },
      this.terminal.timers.now(),
    );
    this.terminal.refresh();
  }
}

/** A run's header, node table and recovery block. */
export function runReport(
  run: WorkflowRun,
  terminal: Terminal,
  now: number,
  options: { module?: string; owner?: string } = {},
): string[] {
  const { style } = terminal;
  const lines = [
    `${style.bold(run.runId)} · ${run.workflowId}@${run.definitionVersion} · ${runStatusLabel(run.status, style)}`,
  ];
  if (options.owner) lines.push(style.dim(`  ${options.owner}`));
  if (run.error) {
    lines.push(
      style.red(
        `  ${truncate(`${run.error.nodeId ? `${run.error.nodeId}: ` : ""}${run.error.code}: ${oneLine(run.error.message)}`, terminal.width - 2)}`,
      ),
    );
  }
  lines.push(...nodeTable(run, style, terminal.width, now));
  const recovery = recoveryBlock(run, style, options.module);
  if (recovery.length > 0) lines.push("", ...recovery);
  return lines;
}

export function snapshotReport(
  snapshot: StoredRunSnapshot,
  terminal: Terminal,
  now: number,
  holder?: StoreHolder,
): string[] {
  return runReport(snapshot.record, terminal, now, { owner: ownership(snapshot, now, holder) });
}

/**
 * The outputs of completed nodes that nothing depends on (the run's results):
 * an agent node's `text`, else the JSON.
 */
export function resultOutputs(
  run: WorkflowRun,
  edges: readonly { from: string }[] | undefined,
): { nodeId: string; text: string }[] {
  const sources = new Set((edges ?? []).map((edge) => edge.from));
  return Object.values(run.nodes)
    .filter(
      (node) =>
        node.status === "completed" && node.output !== undefined && !sources.has(node.nodeId),
    )
    .map((node) => {
      const output = node.output;
      const text =
        output &&
        typeof output === "object" &&
        !Array.isArray(output) &&
        typeof output.text === "string"
          ? output.text
          : JSON.stringify(output, null, 2);
      return { nodeId: node.nodeId, text };
    });
}

/** A JSON-friendly view of a run for --json. */
export function runJson(
  snapshot: { record: WorkflowRun } & Partial<StoredRunSnapshot>,
  now: number,
  holder?: StoreHolder,
) {
  const { record } = snapshot;
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    definitionVersion: record.definitionVersion,
    status: record.status,
    ...(record.error && { error: record.error }),
    ...(snapshot.lease !== undefined || snapshot.cancelRequested !== undefined
      ? { owner: ownership(snapshot as StoredRunSnapshot, now, holder) }
      : {}),
    nodes: Object.values(record.nodes).map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      attempt: node.attempt,
      ...(node.uncertainReason && { uncertainReason: node.uncertainReason }),
      ...(node.error && { error: node.error }),
      ...(node.status === "uncertain" && { idempotencyKey: `${record.runId}:${node.nodeId}` }),
    })),
    needsRecovery: Object.values(record.nodes)
      .filter((node) => node.status === "uncertain")
      .map((node) => node.nodeId),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}
