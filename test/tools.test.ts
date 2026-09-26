import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  executeToolCall,
  formatToolOutput,
  type Tool,
  type ToolCallPart,
  Toolset,
  tool,
  UmioError,
} from "../src/index.js";

const weather = tool({
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City name"),
    unit: z.enum(["c", "f"]).default("c"),
  }),
  annotations: { readOnly: true, openWorld: true },
  execute: async ({ city, unit }) => ({ city, temperature: unit === "c" ? 18 : 64 }),
});

const call = (name: string, input: unknown, id = "call_1"): ToolCallPart => ({
  type: "tool-call",
  id,
  name,
  input,
});

describe("tool", () => {
  it("derives a JSON Schema from the Zod parameters", () => {
    expect(weather.inputSchema).toEqual({
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: { type: "string", enum: ["c", "f"], default: "c" },
      },
      required: ["city"],
    });
    expect(weather.annotations).toEqual({ readOnly: true, openWorld: true });
  });

  it("validates input and applies defaults", () => {
    expect(weather.parseInput({ city: "Seoul" })).toEqual({
      success: true,
      data: { city: "Seoul", unit: "c" },
    });
    const invalid = weather.parseInput({ city: 1 });
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error).toMatch(/city/);
  });

  it("rejects non-object parameters and invalid names", () => {
    const execute = () => "";
    expect(() => tool({ name: "t", description: "", parameters: z.string(), execute })).toThrow(
      /z\.object/,
    );
    expect(() =>
      tool({ name: "bad name", description: "", parameters: z.object({}), execute }),
    ).toThrow(UmioError);
  });
});

describe("Toolset", () => {
  const echo = tool({
    name: "echo",
    description: "Echo.",
    parameters: z.object({ text: z.string() }),
    execute: ({ text }) => text,
  });

  it("rejects duplicate names", () => {
    expect(() => new Toolset([echo, echo])).toThrow(/Duplicate tool name "echo"/);
  });

  it("derives restricted views with pick and omit", () => {
    const tools = new Toolset([weather, echo]);
    expect(tools.pick(["echo"]).names).toEqual(["echo"]);
    expect(tools.omit(["echo"]).names).toEqual(["get_weather"]);
    expect(() => tools.pick(["nope"])).toThrow(/Unknown tool "nope"/);
    expect(tools.size).toBe(2);
  });

  it("exposes model-facing definitions", () => {
    expect(new Toolset([echo]).definitions()).toEqual([
      {
        name: "echo",
        description: "Echo.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });
});

describe("executeToolCall", () => {
  const tools = new Toolset([weather]);
  const context = { messages: [] };

  it("runs the tool with validated input and formats the output", async () => {
    const execution = await executeToolCall(call("get_weather", { city: "Seoul" }), tools, context);
    expect(execution.result).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      content: '{"city":"Seoul","temperature":18}',
    });
    expect(execution.executed).toBe(true);
    expect(execution.error).toBeUndefined();
  });

  it("passes the call ID, signal and history to the tool", async () => {
    const execute = vi.fn(() => "ok");
    const spy = tool({ name: "spy", description: "", parameters: z.object({}), execute });
    const signal = new AbortController().signal;
    await executeToolCall(call("spy", {}, "c9"), new Toolset([spy]), { messages: [], signal });
    expect(execute).toHaveBeenCalledWith({}, { toolCallId: "c9", messages: [], signal });
  });

  it("turns unknown tools, invalid input and thrown errors into error results", async () => {
    const failing = tool({
      name: "fail",
      description: "",
      parameters: z.object({}),
      execute: () => {
        throw new Error("disk full");
      },
    });
    const set = new Toolset([weather, failing]);

    const unknown = await executeToolCall(call("nope", {}), set, context);
    expect(unknown.result).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Unknown tool "nope".*get_weather/),
    });
    expect(unknown.executed).toBe(false);

    const invalid = await executeToolCall(call("get_weather", { city: 3 }), set, context);
    expect(invalid.result).toMatchObject({
      isError: true,
      content: expect.stringMatching(/Invalid input/),
    });
    expect(invalid.executed).toBe(false);

    const thrown = await executeToolCall(call("fail", {}), set, context);
    expect(thrown.result).toMatchObject({
      isError: true,
      content: 'Tool "fail" failed: disk full',
    });
    expect(thrown.error).toBeInstanceOf(Error);
  });

  it("rethrows when the request was aborted", async () => {
    const controller = new AbortController();
    const slow = tool({
      name: "slow",
      description: "",
      parameters: z.object({}),
      execute: () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    await expect(
      executeToolCall(call("slow", {}), new Toolset([slow]), {
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  it("lets beforeToolCall skip execution and afterToolCall replace the result", async () => {
    const execute = vi.fn(() => "ran");
    const guarded: Tool = tool({
      name: "delete_all",
      description: "",
      parameters: z.object({}),
      annotations: { destructive: true },
      execute,
    });
    const set = new Toolset([guarded]);

    const denied = await executeToolCall(call("delete_all", {}), set, context, {
      beforeToolCall: (_call, t) =>
        t?.annotations?.destructive ? { content: "User declined.", isError: true } : undefined,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(denied).toMatchObject({
      executed: false,
      result: { content: "User declined.", isError: true },
    });

    const redacted = await executeToolCall(call("delete_all", {}), set, context, {
      afterToolCall: ({ result }) => ({ ...result, content: "[redacted]" }),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(redacted.result.content).toBe("[redacted]");
  });

  it("uses a custom toModelOutput", async () => {
    const t = tool({
      name: "count",
      description: "",
      parameters: z.object({}),
      execute: () => [1, 2, 3],
      toModelOutput: (items) => `${items.length} items`,
    });
    const execution = await executeToolCall(call("count", {}), new Toolset([t]), context);
    expect(execution.result.content).toBe("3 items");
  });
});

describe("formatToolOutput", () => {
  it("formats common values", () => {
    expect(formatToolOutput("text")).toBe("text");
    expect(formatToolOutput(undefined)).toBe("(no output)");
    expect(formatToolOutput({ a: 1 })).toBe('{"a":1}');
    expect(formatToolOutput(10n)).toBe("10");
  });
});
