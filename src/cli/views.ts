/**
 * Terminal implementations of the adapters' views: they turn chat and graph
 * events into lines on a `Terminal` and phases on an `Activity`.
 */
import { pendingApprovalsOf } from "../graph/executor.js";
import type {
  ApprovalDecision,
  GraphRunEvent,
  PendingApproval,
  WorkflowDefinition,
  WorkflowRun,
} from "../graph/types.js";
import type { GenerateResult, ToolCallPart } from "../llm/types.js";
import type { ToolExecution } from "../tools/execute.js";
import type { Activity } from "./activity.js";
import type { ChatView } from "./chat.js";
import { formatDuration } from "./duration.js";
import {
  approvalBlock,
  nodeTable,
  oneLine,
  quote,
  recoveryBlock,
  runStatusLabel,
  toolResultLines,
  toolStartLine,
  truncate,
} from "./format.js";
import type { GraphRunView } from "./graph.js";
import { cancelState, ownership, type StoreHolder } from "./graph.js";
import type { RunView } from "./store.js";
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
  /** Loop node → how many body nodes each iteration adds. */
  private readonly loopSizes = new Map<string, number>();
  runId: string | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly activity: Activity,
  ) {}

  definition(definition: WorkflowDefinition): void {
    this.total = definition.graph.nodes.length;
    for (const node of definition.graph.nodes) {
      if (node.loop) this.loopSizes.set(node.id, node.loop.body.nodes.length);
    }
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
      case "node-waiting":
        this.finished.add(event.nodeId);
        this.terminal.note(
          style.yellow(`${symbols.waiting} ${event.nodeId} waiting for approval`) +
            style.dim(` (umio graph approve|reject ${this.runId ?? event.runId} ${event.nodeId})`),
        );
        break;
      case "run-paused":
        this.terminal.note(
          style.yellow(
            `${symbols.waiting} paused: nothing else can run until ${event.nodes.join(", ")} ${event.nodes.length === 1 ? "is" : "are"} decided`,
          ),
        );
        break;
      case "loop-iteration":
        this.total += this.loopSizes.get(event.nodeId) ?? 0;
        this.terminal.note(
          style.cyan(`${symbols.retry} ${event.nodeId} iteration ${event.iteration}`),
        );
        break;
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

/** A run's header, node table, approval block and recovery block. */
export function runReport(
  run: WorkflowRun,
  terminal: Terminal,
  now: number,
  options: { module?: string; owner?: string; decisions?: readonly ApprovalDecision[] } = {},
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
  const approvals = approvalBlock(run, style, {
    ...(options.module && { module: options.module }),
    ...(options.decisions && { decisions: options.decisions }),
  });
  if (approvals.length > 0) lines.push("", ...approvals);
  const recovery = recoveryBlock(run, style, options.module);
  if (recovery.length > 0) lines.push("", ...recovery);
  return lines;
}

export function snapshotReport(
  snapshot: RunView,
  terminal: Terminal,
  now: number,
  holder?: StoreHolder,
): string[] {
  return runReport(snapshot.record, terminal, now, {
    owner: ownership(snapshot, now, holder),
    decisions: snapshot.decisions,
  });
}

/** Lines for `umio graph approvals`: each waiting request with its context. */
export function approvalLines(
  approvals: readonly PendingApproval[],
  terminal: Terminal,
  verbose: boolean,
): string[] {
  const { style } = terminal;
  const width = terminal.width;
  const lines: string[] = [];
  for (const item of approvals) {
    const { request } = item;
    if (lines.length > 0) lines.push("");
    lines.push(
      `${style.bold(item.runId)} · ${item.workflowId} · ${style.bold(item.nodeId)} · ${request.title}`,
    );
    if (request.description) lines.push(`  ${request.description}`);
    lines.push(
      style.dim(
        `  requested ${new Date(request.requestedAt).toLocaleString()} · request ${request.requestId} · run ${item.runStatus} · on reject: ${request.onReject === "continue" ? "continue (the workflow routes it)" : "fail the run"}`,
      ),
    );
    const show = (label: string, value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const all = (text ?? "null").split("\n");
      const shown = verbose ? all : all.slice(0, 6);
      lines.push(style.dim(`  ${label}:`));
      for (const line of shown) lines.push(`    ${truncate(line, width - 4)}`);
      if (shown.length < all.length) {
        lines.push(
          style.dim(`    … ${all.length - shown.length} more lines (--verbose shows all)`),
        );
      }
    };
    show("input", item.input);
    for (const [nodeId, output] of Object.entries(item.context)) show(nodeId, output);
    if (item.decision) {
      lines.push(
        `  ${item.decision.approved ? style.green("approved") : style.red("rejected")}${item.decision.decidedBy ? ` by ${item.decision.decidedBy}` : ""} — recorded, not yet applied${item.runStatus === "paused" ? `; continue with: umio graph resume <module> ${quote(item.runId)}` : ""}`,
      );
    } else {
      const target = `${quote(item.runId)} ${quote(item.nodeId)}`;
      lines.push(
        style.dim(`  umio graph approve ${target} [--comment "…"]`),
        style.dim(`  umio graph reject ${target} [--comment "…"]`),
      );
    }
  }
  return lines;
}

/**
 * The outputs of completed top-level nodes that nothing depends on (the run's
 * results): an agent node's `text`, else the JSON. Loop body nodes are not
 * results; their loop node's output is.
 */
export function resultOutputs(
  run: WorkflowRun,
  graph: { edges: readonly { from: string }[]; nodes?: readonly { id: string }[] } | undefined,
): { nodeId: string; text: string }[] {
  const sources = new Set((graph?.edges ?? []).map((edge) => edge.from));
  const top = graph?.nodes ? new Set(graph.nodes.map((node) => node.id)) : undefined;
  return Object.values(run.nodes)
    .filter(
      (node) =>
        node.status === "completed" &&
        node.output !== undefined &&
        !sources.has(node.nodeId) &&
        (!top || top.has(node.nodeId)),
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
  snapshot: { record: WorkflowRun } & Partial<RunView>,
  now: number,
  holder?: StoreHolder,
) {
  const { record } = snapshot;
  const approvals = pendingApprovalsOf(record, snapshot.decisions ?? []);
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    definitionVersion: record.definitionVersion,
    status: record.status,
    ...(record.error && { error: record.error }),
    ...(snapshot.decisions !== undefined && {
      owner: ownership(snapshot as RunView, now, holder),
      cancelRequest: cancelState(snapshot as RunView),
      ...(snapshot.pendingCancelRequest && {
        cancelRequestedAt: new Date(snapshot.pendingCancelRequest.requestedAt).toISOString(),
      }),
    }),
    nodes: Object.values(record.nodes).map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      attempt: node.attempt,
      ...(node.uncertainReason && { uncertainReason: node.uncertainReason }),
      ...(node.loop && { iteration: node.loop.iteration, loopDecisions: node.loop.decisions }),
      ...(node.error && { error: node.error }),
      ...(node.status === "uncertain" && { idempotencyKey: `${record.runId}:${node.nodeId}` }),
    })),
    needsRecovery: Object.values(record.nodes)
      .filter((node) => node.status === "uncertain")
      .map((node) => node.nodeId),
    approvals: approvals.map((item) => ({
      nodeId: item.nodeId,
      requestId: item.request.requestId,
      title: item.request.title,
      ...(item.request.description !== undefined && { description: item.request.description }),
      requestedAt: new Date(item.request.requestedAt).toISOString(),
      ...(item.decision && { decision: item.decision }),
    })),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}
