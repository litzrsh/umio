import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type GenerateRequest,
  type GenerateResult,
  type ModelClient,
  runToolLoop,
  type StreamEvent,
  type ToolCallPart,
  type ToolLoopEvent,
  tool,
} from "../src/index.js";

const add = tool({
  name: "add",
  description: "Adds two numbers.",
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => a + b,
});

function textResult(text: string): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
    model: "fake",
    raw: null,
  };
}

function toolResult(...toolCalls: ToolCallPart[]): GenerateResult {
  return {
    message: { role: "assistant", content: toolCalls },
    text: "",
    toolCalls,
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 4 },
    model: "fake",
    raw: null,
  };
}

const addCall = (id: string, a: number, b: number): ToolCallPart => ({
  type: "tool-call",
  id,
  name: "add",
  input: { a, b },
});

/** A model that returns the scripted results in order and records each request. */
function scriptedModel(...results: GenerateResult[]) {
  const requests: GenerateRequest[] = [];
  const next = (request: GenerateRequest) => {
    requests.push(request);
    const result = results.shift();
    if (!result) throw new Error("script exhausted");
    return result;
  };
  const model: ModelClient = {
    generate: async (request) => next(request),
    async *stream(request): AsyncGenerator<StreamEvent> {
      const result = next(request);
      for (const word of result.text.split(/(?= )/)) {
        if (word) yield { type: "text-delta", text: word };
      }
      for (const toolCall of result.toolCalls) yield { type: "tool-call", toolCall };
      yield { type: "finish", result };
    },
  };
  return { model, requests };
}

describe("runToolLoop", () => {
  it("executes tool calls and feeds the results back until the model stops", async () => {
    const { model, requests } = scriptedModel(
      toolResult(addCall("c1", 1, 2), addCall("c2", 3, 4)),
      textResult("3 and 7"),
    );

    const result = await runToolLoop(model, {
      system: "Use tools.",
      messages: [{ role: "user", content: "Add 1+2 and 3+4" }],
      tools: [add],
    });

    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("3 and 7");
    expect(result.steps).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 4 });
    expect(result.messages).toEqual([
      { role: "user", content: "Add 1+2 and 3+4" },
      { role: "assistant", content: [addCall("c1", 1, 2), addCall("c2", 3, 4)] },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", content: "3" },
          { type: "tool-result", toolCallId: "c2", content: "7" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "3 and 7" }] },
    ]);

    expect(requests[0]).toMatchObject({ system: "Use tools.", tools: [{ name: "add" }] });
    expect(requests[1]?.messages).toHaveLength(3);
  });

  it("does not mutate the caller's messages", async () => {
    const { model } = scriptedModel(toolResult(addCall("c1", 1, 1)), textResult("2"));
    const messages = [{ role: "user" as const, content: "1+1" }];
    await runToolLoop(model, { messages, tools: [add] });
    expect(messages).toHaveLength(1);
  });

  it("stops at maxSteps with every tool call answered", async () => {
    const { model } = scriptedModel(
      toolResult(addCall("c1", 1, 1)),
      toolResult(addCall("c2", 2, 2)),
    );

    const result = await runToolLoop(model, {
      messages: [{ role: "user", content: "keep adding" }],
      tools: [add],
      maxSteps: 2,
    });

    expect(result.stopReason).toBe("max-steps");
    expect(result.finishReason).toBe("tool-calls");
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c2", content: "4" }],
    });
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const { model, requests } = scriptedModel(
      toolResult({ type: "tool-call", id: "c1", name: "add", input: { a: "x" } }),
      textResult("sorry"),
    );
    await runToolLoop(model, { messages: [], tools: [add] });
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: [{ toolCallId: "c1", isError: true }],
    });
  });

  it("streams events in order", async () => {
    const { model } = scriptedModel(toolResult(addCall("c1", 2, 2)), textResult("It is 4"));
    const events: ToolLoopEvent[] = [];

    await runToolLoop(model, {
      messages: [{ role: "user", content: "2+2" }],
      tools: [add],
      stream: true,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.map((e) => e.type)).toEqual([
      "tool-call",
      "finish",
      "tool-result",
      "step-finish",
      "text-delta",
      "text-delta",
      "text-delta",
      "finish",
      "step-finish",
    ]);
    const text = events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
    expect(text).toBe("It is 4");
  });

  it("passes hooks through to tool execution", async () => {
    const { model } = scriptedModel(toolResult(addCall("c1", 1, 1)), textResult("ok"));
    const beforeToolCall = vi.fn(() => ({ content: "blocked", isError: true }));

    const result = await runToolLoop(model, {
      messages: [],
      tools: [add],
      hooks: { beforeToolCall },
    });

    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(result.steps[0]?.toolExecutions[0]).toMatchObject({
      executed: false,
      result: { content: "blocked" },
    });
  });

  it("rejects an invalid maxSteps", async () => {
    const { model } = scriptedModel();
    await expect(runToolLoop(model, { messages: [], tools: [], maxSteps: 0 })).rejects.toThrow(
      /maxSteps/,
    );
  });
});
