/**
 * Pure formatting: values in, lines of text out, for a given width and style.
 * Nothing here writes to a stream.
 */
import type { NodeRun, WorkflowRun } from "../graph/types.js";
import type { ToolCallPart, Usage } from "../llm/types.js";
import type { ToolExecution } from "../tools/execute.js";
import { formatDuration } from "./duration.js";
import type { Style } from "./style.js";

/** Cuts `text` to `width` visible characters, marking the cut with "…". */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Collapses whitespace, so a value fits on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatCount(count: number): string {
  return count < 1_000 ? String(count) : `${(count / 1_000).toFixed(1)}k`;
}

/** `path=src/index.ts limit=20`: a tool input as short key=value pairs. */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return oneLine(typeof input === "string" ? input : (JSON.stringify(input) ?? ""));
  }
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${/\s/.test(text ?? "") ? JSON.stringify(oneLine(text ?? "")) : text}`;
    })
    .join(" ");
}

export function toolStartLine(call: ToolCallPart, style: Style, width: number): string {
  const head = `  ${style.symbols.tool} ${call.name} `;
  return style.cyan(head) + style.dim(truncate(summarizeInput(call.input), width - head.length));
}

/** The line for a finished tool call, plus a preview in verbose mode. */
export function toolResultLines(
  execution: ToolExecution,
  style: Style,
  width: number,
  verbose = false,
): string[] {
  const { call, result } = execution;
  const text = result.content;
  if (!execution.executed) {
    return [
      style.yellow(`  ${style.symbols.cancelled} ${call.name} not run: `) +
        style.dim(truncate(oneLine(text), width - call.name.length - 14)),
    ];
  }
  const time = formatDuration(execution.durationMs);
  if (result.isError) {
    const head = `  ${style.symbols.error} ${call.name} failed · ${time}: `;
    return [style.red(head) + truncate(oneLine(text), width - head.length)];
  }
  const lines = [
    style.green(`  ${style.symbols.ok} ${call.name}`) +
      style.dim(` · ${time} · ${formatBytes(Buffer.byteLength(text, "utf8"))}`),
  ];
  if (verbose) {
    const preview = text.split("\n").slice(0, 8);
    for (const line of preview) lines.push(style.dim(`    ${truncate(line, width - 4)}`));
    if (text.split("\n").length > preview.length) lines.push(style.dim("    …"));
  }
  return lines;
}

export function turnFooter(elapsedMs: number, usage: Usage | undefined, style: Style): string {
  const tokens = usage
    ? ` · in ${formatCount(usage.inputTokens)} out ${formatCount(usage.outputTokens)} tokens${usage.cacheReadTokens ? ` (${formatCount(usage.cacheReadTokens)} cached)` : ""}`
    : "";
  return style.dim(`${style.symbols.pending} ${formatDuration(elapsedMs)}${tokens}`);
}

/** A node's status as symbol + word, never color alone. */
export function nodeStatusLabel(node: NodeRun, style: Style, now: number): string {
  const { symbols } = style;
  switch (node.status) {
    case "completed":
      return style.green(`${symbols.ok} completed`);
    case "failed":
      return style.red(`${symbols.error} failed`);
    case "cancelled":
      return style.yellow(`${symbols.cancelled} cancelled`);
    case "skipped":
      return style.dim(`${symbols.cancelled} skipped`);
    case "uncertain":
      return style.yellow(`${symbols.uncertain} uncertain`);
    case "running":
      return style.cyan(`${symbols.running} running`);
    default:
      return node.retryAt !== undefined && node.retryAt > now
        ? style.cyan(`${symbols.retry} retry in ${formatDuration(node.retryAt - now)}`)
        : style.dim(`${symbols.pending} pending`);
  }
}

export function runStatusLabel(status: WorkflowRun["status"], style: Style): string {
  const { symbols } = style;
  switch (status) {
    case "completed":
      return style.green(`${symbols.ok} completed`);
    case "failed":
      return style.red(`${symbols.error} failed`);
    case "cancelled":
      return style.yellow(`${symbols.cancelled} cancelled`);
    case "needs-recovery":
      return style.yellow(`${symbols.uncertain} needs recovery`);
    default:
      return style.cyan(`${symbols.running} running`);
  }
}

/** One row per node: id, status, attempt, duration, and why it failed or is uncertain. */
export function nodeTable(record: WorkflowRun, style: Style, width: number, now: number): string[] {
  const nodes = Object.values(record.nodes);
  const idWidth = Math.min(24, Math.max(4, ...nodes.map((node) => node.nodeId.length)));
  return nodes.map((node) => {
    const id = truncate(node.nodeId, idWidth).padEnd(idWidth);
    const status = nodeStatusLabel(node, style, now);
    const attempt = node.attempt > 0 ? ` · attempt ${node.attempt}` : "";
    const end = node.finishedAt ?? (node.status === "running" ? now : undefined);
    const time =
      node.startedAt !== undefined && end !== undefined
        ? ` · ${formatDuration(end - node.startedAt)}`
        : "";
    const reason = node.uncertainReason
      ? ` (${node.uncertainReason})`
      : node.error && node.status !== "completed"
        ? ` — ${node.error.code}: ${oneLine(node.error.message)}`
        : "";
    const head = `  ${id}  `;
    const plainRest = `${attempt}${time}${reason}`;
    return head + status + style.dim(truncate(plainRest, Math.max(10, width - head.length - 14)));
  });
}

/**
 * For each uncertain node: what is known, that its effects may have happened,
 * and the explicit commands to resolve it. Never chooses for the user.
 */
export function recoveryBlock(
  record: WorkflowRun,
  style: Style,
  modulePath = "<module>",
): string[] {
  const uncertain = Object.values(record.nodes).filter((node) => node.status === "uncertain");
  if (uncertain.length === 0) return [];
  const lines = [
    style.yellow(
      `${style.symbols.warn} ${uncertain.length} node${uncertain.length === 1 ? " needs" : "s need"} manual recovery. umio never retries these automatically.`,
    ),
  ];
  for (const node of uncertain) {
    lines.push(
      `  ${style.bold(node.nodeId)} · ${node.uncertainReason ?? "uncertain"} · attempt ${node.attempt} · idempotency key ${record.runId}:${node.nodeId}`,
      `    ${explainUncertain(node)}`,
    );
    if (node.error) lines.push(style.dim(`    ${node.error.code}: ${oneLine(node.error.message)}`));
    if (record.status === "needs-recovery") {
      const base = `umio graph recover ${quote(modulePath)} ${quote(record.runId)} ${quote(node.nodeId)}`;
      lines.push(
        "    Check what it did, then choose one:",
        style.dim(`      ${base} --retry              # run it again (same idempotency key)`),
        style.dim(`      ${base} --complete '<json>'  # record the verified result`),
        style.dim(`      ${base} --fail --reason "…"  # fail the node and the run`),
      );
    }
  }
  if (record.status === "needs-recovery") {
    lines.push(
      style.dim(
        `  Then continue with: umio graph resume ${quote(modulePath)} ${quote(record.runId)}`,
      ),
    );
  }
  return lines;
}

function explainUncertain(node: NodeRun): string {
  switch (node.uncertainReason) {
    case "invalid-output":
      return "Its handler finished, so its side effects happened, but its output could not be recorded (too large or not JSON). Store the result and complete it with an ArtifactRef.";
    case "process-lost":
      return "The process running it stopped. Its handler may have run fully, partly or not at all; its side effects may have happened.";
    default:
      return "Its handler did not stop when asked. It may have run fully, partly or not at all; its side effects may have happened.";
  }
}

/** Quotes an argument for display in a copyable shell command, only when needed. */
export function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
