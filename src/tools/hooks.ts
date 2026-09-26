import type { ToolResultPart } from "../llm/types.js";
import type { ToolExecution, ToolHooks } from "./execute.js";

/**
 * Combines hook sets into one, so independent concerns (approval, logging,
 * output limits) stay separate. `beforeToolCall` hooks run in order until one
 * returns an override. `afterToolCall` hooks run in order, each seeing the
 * result as replaced by the ones before it.
 */
export function composeHooks(...hooks: ToolHooks[]): ToolHooks {
  return {
    async beforeToolCall(call, tool) {
      for (const hook of hooks) {
        const override = await hook.beforeToolCall?.(call, tool);
        if (override) return override;
      }
      return undefined;
    },
    async afterToolCall(execution) {
      let current: ToolExecution = execution;
      let replaced = false;
      for (const hook of hooks) {
        const result = await hook.afterToolCall?.(current);
        if (result) {
          current = { ...current, result };
          replaced = true;
        }
      }
      return replaced ? current.result : undefined;
    },
  };
}

export interface LimitToolOutputOptions {
  /** Longest result, in characters, sent to the model. */
  maxChars: number;
  /** Share of the kept characters taken from the end of the output. Defaults to 0.3. */
  tailRatio?: number;
}

/**
 * Condenses oversized tool results before they reach the model, keeping the
 * start and the end (where errors and summaries usually are). Tool output is
 * resent on every later step of a loop, so an oversized result costs tokens
 * many times over.
 */
export function limitToolOutput(options: LimitToolOutputOptions): ToolHooks {
  const { maxChars, tailRatio = 0.3 } = options;
  return {
    afterToolCall({ result }): ToolResultPart | undefined {
      const { content } = result;
      if (content.length <= maxChars) return undefined;
      const tail = Math.floor(maxChars * tailRatio);
      const head = maxChars - tail;
      const omitted = content.length - head - tail;
      return {
        ...result,
        content: `${content.slice(0, head)}\n… [${omitted} characters omitted] …\n${tail > 0 ? content.slice(-tail) : ""}`,
      };
    },
  };
}
