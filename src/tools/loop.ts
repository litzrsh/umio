import { UmioError } from "../errors.js";
import type {
  FinishReason,
  GenerateRequest,
  GenerateResult,
  Message,
  ModelClient,
  StreamEvent,
  Usage,
} from "../llm/types.js";
import {
  executeToolCalls,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolHooks,
} from "./execute.js";
import { composeHooks, limitToolOutput } from "./hooks.js";
import type { Tool } from "./tool.js";
import { Toolset } from "./toolset.js";

export const DEFAULT_MAX_STEPS = 10;

export interface ToolLoopStep {
  result: GenerateResult;
  toolExecutions: ToolExecution[];
}

export type ToolLoopEvent =
  | StreamEvent
  | { type: "tool-result"; execution: ToolExecution }
  | { type: "step-finish"; step: ToolLoopStep; stepIndex: number };

export interface ToolLoopOptions extends Omit<GenerateRequest, "tools"> {
  tools: Toolset | Iterable<Tool>;
  /** Maximum number of model calls. Defaults to the model harness's `maxSteps`, else 10. */
  maxSteps?: number;
  /** Stream model output. Text deltas are delivered to `onEvent`. */
  stream?: boolean;
  /** Receives stream events (when streaming), tool results and step boundaries, in order. */
  onEvent?(event: ToolLoopEvent): void | Promise<void>;
  hooks?: ToolHooks;
  /** Forwarded into every tool's context (agent name, shared workflow state). */
  toolContext?: Pick<ToolExecutionContext, "agent" | "state">;
}

export interface ToolLoopResult {
  /** Text of the final model response. */
  text: string;
  finishReason: FinishReason;
  /** "max-steps" when the loop stopped while the model still wanted to call tools. */
  stopReason: "done" | "max-steps";
  /** The input messages plus every message the loop added; valid for continuing the conversation. */
  messages: Message[];
  steps: ToolLoopStep[];
  /** Token usage summed over all steps. */
  usage: Usage;
  /** The final model result. */
  result: GenerateResult;
}

/**
 * Calls the model, runs the tools it asks for, feeds the results back, and
 * repeats until the model stops calling tools or `maxSteps` is reached. Tool
 * calls are always answered, even on the last step, so `messages` never ends
 * with an unanswered call.
 */
export async function runToolLoop(
  model: ModelClient,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    tools,
    maxSteps: requestedMaxSteps,
    stream = false,
    onEvent,
    hooks: requestedHooks,
    toolContext,
    ...request
  } = options;
  // The model's harness supplies defaults; explicit options win.
  const defaults = model.loopDefaults?.(request.model);
  const maxSteps = requestedMaxSteps ?? defaults?.maxSteps ?? DEFAULT_MAX_STEPS;
  const hooks = defaults?.maxToolOutputChars
    ? composeHooks(requestedHooks ?? {}, limitToolOutput({ maxChars: defaults.maxToolOutputChars }))
    : requestedHooks;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new UmioError(`maxSteps must be a positive integer, got ${maxSteps}.`);
  }
  const toolset = tools instanceof Toolset ? tools : new Toolset(tools);
  const messages = [...request.messages];
  const steps: ToolLoopStep[] = [];

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const stepRequest: GenerateRequest = {
      ...request,
      messages: [...messages],
      tools: toolset.definitions(),
    };
    const result = stream
      ? await consumeStream(model.stream(stepRequest), onEvent)
      : await model.generate(stepRequest);
    messages.push(result.message);

    const step: ToolLoopStep = { result, toolExecutions: [] };
    steps.push(step);
    const wantsTools = result.finishReason === "tool-calls" && result.toolCalls.length > 0;

    if (wantsTools) {
      step.toolExecutions = await executeToolCalls(
        result.toolCalls,
        toolset,
        {
          ...toolContext,
          messages: [...messages],
          ...(request.signal && { signal: request.signal }),
        },
        hooks,
        (execution) => onEvent?.({ type: "tool-result", execution }),
      );
      messages.push({ role: "tool", content: step.toolExecutions.map((e) => e.result) });
    }
    await onEvent?.({ type: "step-finish", step, stepIndex });

    if (!wantsTools) return finish(result, "done", messages, steps);
  }

  const last = steps.at(-1);
  if (!last) throw new UmioError("Tool loop ran no steps."); // unreachable: maxSteps >= 1
  return finish(last.result, "max-steps", messages, steps);
}

async function consumeStream(
  events: AsyncIterable<StreamEvent>,
  onEvent: ToolLoopOptions["onEvent"],
): Promise<GenerateResult> {
  let result: GenerateResult | undefined;
  for await (const event of events) {
    await onEvent?.(event);
    if (event.type === "finish") result = event.result;
  }
  if (!result) throw new UmioError("Model stream ended without a finish event.");
  return result;
}

function finish(
  result: GenerateResult,
  stopReason: ToolLoopResult["stopReason"],
  messages: Message[],
  steps: ToolLoopStep[],
): ToolLoopResult {
  return {
    text: result.text,
    finishReason: result.finishReason,
    stopReason,
    messages,
    steps,
    usage: sumUsage(steps.map((step) => step.result.usage)),
    result,
  };
}

/** Adds up token usage, including cache counters when any step reports them. */
export function sumUsage(usages: Usage[]): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  for (const usage of usages) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== undefined) {
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    if (usage.cacheWriteTokens !== undefined) {
      total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    }
  }
  return total;
}
