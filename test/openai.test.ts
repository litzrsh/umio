import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { LLMError, type Message, OpenAIProvider } from "../src/index.js";
import { toOpenAIMessages } from "../src/llm/providers/openai.js";

function fakeClient(response: unknown) {
  const create = vi.fn(async (_params: unknown, _options?: unknown) => response);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

function completion(message: Record<string, unknown>, finishReason: string) {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "llama3.2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", refusal: null, ...message },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
}

describe("OpenAIProvider", () => {
  it("sends max_completion_tokens to OpenAI and max_tokens to local servers", async () => {
    const response = completion({ content: "hi" }, "stop");
    const openai = fakeClient(response);
    const ollama = fakeClient(response);

    await new OpenAIProvider({ type: "openai" }, openai.client).generate({
      model: "gpt-5",
      messages: [],
      maxTokens: 100,
    });
    await new OpenAIProvider({ type: "ollama" }, ollama.client).generate({
      model: "llama3.2",
      messages: [],
      maxTokens: 100,
    });

    expect(openai.create.mock.calls[0]?.[0]).toMatchObject({ max_completion_tokens: 100 });
    expect(ollama.create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 100 });
    expect(ollama.create.mock.calls[0]?.[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("omits the token cap when none is configured", async () => {
    const { client, create } = fakeClient(completion({ content: "hi" }, "stop"));
    await new OpenAIProvider({ type: "ollama" }, client).generate({ model: "m", messages: [] });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
  });

  it("maps system prompt, tools and options", async () => {
    const { client, create } = fakeClient(completion({ content: "hi" }, "stop"));
    await new OpenAIProvider({ type: "ollama" }, client).generate({
      model: "llama3.2",
      system: "Be brief.",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      toolChoice: "auto",
      options: { temperature: 0.2 },
    });

    expect(create).toHaveBeenCalledWith(
      {
        temperature: 0.2,
        model: "llama3.2",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hello" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "t", description: "d", parameters: { type: "object" } },
          },
        ],
        tool_choice: "auto",
        stream: false,
      },
      { signal: undefined },
    );
  });

  it("parses tool calls, even when the server reports finish_reason stop", async () => {
    const { client } = fakeClient(
      completion(
        {
          content: null,
          tool_calls: [
            { id: "", type: "function", function: { name: "a", arguments: '{"x":1}' } },
            { id: "call_b", type: "function", function: { name: "b", arguments: "{bad json" } },
          ],
        },
        "stop",
      ),
    );
    const result = await new OpenAIProvider({ type: "ollama" }, client).generate({
      model: "m",
      messages: [],
    });

    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([
      { type: "tool-call", id: "call_0", name: "a", input: { x: 1 } },
      { type: "tool-call", id: "call_b", name: "b", input: "{bad json" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.message.providerData).toBeUndefined();
  });

  it("maps refusals", async () => {
    const { client } = fakeClient(completion({ content: null, refusal: "No." }, "stop"));
    const result = await new OpenAIProvider({ type: "openai" }, client).generate({
      model: "m",
      messages: [],
    });
    expect(result.finishReason).toBe("refusal");
    expect(result.text).toBe("No.");
  });

  it("reports an unreachable local server as a retryable LLMError", async () => {
    const { client, create } = fakeClient(null);
    create.mockRejectedValueOnce(new OpenAI.APIConnectionError({ message: "ECONNREFUSED" }));

    const error = await new OpenAIProvider({ type: "ollama" }, client)
      .generate({ model: "m", messages: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ provider: "ollama", retryable: true });
    expect((error as Error).message).toMatch(/Cannot connect to ollama/);
  });

  it("marks client errors as not retryable", async () => {
    const { client, create } = fakeClient(null);
    create.mockRejectedValueOnce(
      new OpenAI.BadRequestError(400, undefined, "bad model", new Headers()),
    );
    const error = await new OpenAIProvider({ type: "openai" }, client)
      .generate({ model: "m", messages: [] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, retryable: false });
  });
});

describe("OpenAIProvider streaming", () => {
  function streamingClient(chunks: unknown[]) {
    const create = vi.fn(async (_params: unknown, _options?: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    }));
    return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
  }

  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra = {}) => ({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "llama3.2",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });

  it("emits text deltas and rebuilds the full result", async () => {
    const { client, create } = streamingClient([
      chunk({ role: "assistant", content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      {
        ...chunk({}),
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);

    const events = [];
    for await (const event of new OpenAIProvider({ type: "ollama" }, client).stream({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events.slice(0, 2)).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
    ]);
    expect(events[2]).toMatchObject({
      type: "finish",
      result: {
        text: "Hello",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 2 },
        model: "llama3.2",
      },
    });
  });

  it("assembles tool calls split across chunks, and whole calls without an index", async () => {
    const { client } = streamingClient([
      chunk({
        tool_calls: [{ index: 0, id: "call_a", function: { name: "add", arguments: '{"a":' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
      chunk({ tool_calls: [{ id: "call_b", function: { name: "sub", arguments: '{"b":2}' } }] }),
      chunk({}, "tool_calls"),
    ]);

    const events = [];
    for await (const event of new OpenAIProvider({ type: "ollama" }, client).stream({
      model: "m",
      messages: [],
    })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        toolCall: { type: "tool-call", id: "call_a", name: "add", input: { a: 1 } },
      },
      {
        type: "tool-call",
        toolCall: { type: "tool-call", id: "call_b", name: "sub", input: { b: 2 } },
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", result: { finishReason: "tool-calls" } });
  });

  it("rejects with an abort error when the SDK ends the stream quietly on abort", async () => {
    const controller = new AbortController();
    // Like the SDK: once the signal aborts, iteration just stops.
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield chunk({ role: "assistant", content: "Par" });
        controller.abort();
      },
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const events: unknown[] = [];
    const iterate = async () => {
      for await (const event of new OpenAIProvider({ type: "ollama" }, client).stream({
        model: "m",
        messages: [],
        signal: controller.signal,
      })) {
        events.push(event);
      }
    };
    await expect(iterate()).rejects.toMatchObject({
      message: "Request aborted.",
      retryable: false,
    });
    expect(events).toEqual([{ type: "text-delta", text: "Par" }]); // no finish event
  });

  it("wraps errors thrown while streaming", async () => {
    const create = vi.fn(async () => {
      throw new OpenAI.APIConnectionError({ message: "ECONNREFUSED" });
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const iterate = async () => {
      for await (const _ of new OpenAIProvider({ type: "ollama" }, client).stream({
        model: "m",
        messages: [],
      })) {
        // drain
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(LLMError);
  });
});

describe("toOpenAIMessages system parts", () => {
  it("joins system parts and ignores cache flags", () => {
    expect(
      toOpenAIMessages(
        [
          { type: "text", text: "<docs>", cache: true },
          { type: "text", text: "Be brief." },
        ],
        [{ role: "user", content: [{ type: "text", text: "q", cache: true }] }],
      ),
    ).toEqual([
      { role: "system", content: "<docs>\n\nBe brief." },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ]);
  });
});

describe("toOpenAIMessages", () => {
  it("converts tool calls and results", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool-call", id: "c1", name: "get_weather", input: { city: "Seoul" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", content: "12C" },
          { type: "tool-result", toolCallId: "c2", content: "boom", isError: true },
        ],
      },
    ];

    expect(toOpenAIMessages(undefined, messages)).toEqual([
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Seoul"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "12C" },
      { role: "tool", tool_call_id: "c2", content: "Error: boom" },
    ]);
  });
});
