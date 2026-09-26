import type { ToolCallPart, ToolResultPart } from "../llm/types.js";
import { formatToolOutput, type Tool, type ToolContext } from "./tool.js";
import type { Toolset } from "./toolset.js";

/** The outcome of one tool call. */
export interface ToolExecution {
  call: ToolCallPart;
  /** What is sent back to the model. */
  result: ToolResultPart;
  /** The error behind an `isError` result, when one was thrown or validation failed. */
  error?: unknown;
  /** False when `beforeToolCall` supplied the result instead. */
  executed: boolean;
  durationMs: number;
}

export interface ToolCallOverride {
  content: string;
  isError?: boolean;
}

/** Interception points around tool execution: approval gates, logging, result redaction, ... */
export interface ToolHooks {
  /**
   * Runs before each call; `tool` is undefined for unknown names. Return an
   * override to skip execution and send that result instead (e.g. "user declined").
   */
  beforeToolCall?(
    call: ToolCallPart,
    tool: Tool | undefined,
  ): ToolCallOverride | undefined | Promise<ToolCallOverride | undefined>;
  /** Runs after each call, including failures. Return a result to replace the one sent to the model. */
  afterToolCall?(
    execution: ToolExecution,
  ): ToolResultPart | undefined | Promise<ToolResultPart | undefined>;
}

/** Per-loop data forwarded into every tool's `ToolContext`. */
export type ToolExecutionContext = Omit<ToolContext, "toolCallId">;

/**
 * Validates and runs one tool call. Failures (unknown tool, invalid input, a
 * throwing tool) become `isError` results so the model can correct itself;
 * only an abort via `signal` or an error thrown by a hook propagates.
 */
export async function executeToolCall(
  call: ToolCallPart,
  tools: Toolset,
  context: ToolExecutionContext,
  hooks: ToolHooks = {},
): Promise<ToolExecution> {
  const started = performance.now();
  const tool = tools.get(call.name);

  let execution: ToolExecution;
  const override = await hooks.beforeToolCall?.(call, tool);
  if (override) {
    execution = {
      call,
      result: toolResult(call, override.content, override.isError),
      executed: false,
      durationMs: 0,
    };
  } else {
    execution = { ...(await run(call, tool, tools, context)), durationMs: 0 };
  }
  execution.durationMs = performance.now() - started;

  const replacement = await hooks.afterToolCall?.(execution);
  return replacement ? { ...execution, result: replacement } : execution;
}

/** Runs all calls from one assistant turn concurrently, preserving their order in the result. */
export function executeToolCalls(
  calls: ToolCallPart[],
  tools: Toolset,
  context: ToolExecutionContext,
  hooks?: ToolHooks,
  onExecuted?: (execution: ToolExecution) => void | Promise<void>,
): Promise<ToolExecution[]> {
  return Promise.all(
    calls.map(async (call) => {
      const execution = await executeToolCall(call, tools, context, hooks);
      await onExecuted?.(execution);
      return execution;
    }),
  );
}

async function run(
  call: ToolCallPart,
  tool: Tool | undefined,
  tools: Toolset,
  context: ToolExecutionContext,
): Promise<Omit<ToolExecution, "durationMs">> {
  if (!tool) {
    const message = `Unknown tool "${call.name}". Available tools: ${tools.names.join(", ") || "(none)"}.`;
    return {
      call,
      result: toolResult(call, message, true),
      error: new Error(message),
      executed: false,
    };
  }

  const parsed = tool.parseInput(call.input);
  if (!parsed.success) {
    const message = `Invalid input for tool "${call.name}":\n${parsed.error}`;
    return {
      call,
      result: toolResult(call, message, true),
      error: new Error(message),
      executed: false,
    };
  }

  try {
    const output = await tool.execute(parsed.data, { ...context, toolCallId: call.id });
    const content = tool.toModelOutput ? tool.toModelOutput(output) : formatToolOutput(output);
    return { call, result: toolResult(call, content), executed: true };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      call,
      result: toolResult(call, `Tool "${call.name}" failed: ${message}`, true),
      error,
      executed: true,
    };
  }
}

function toolResult(call: ToolCallPart, content: string, isError?: boolean): ToolResultPart {
  return { type: "tool-result", toolCallId: call.id, content, ...(isError && { isError: true }) };
}
