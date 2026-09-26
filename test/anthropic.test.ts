import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, LLMError, type Message } from "../src/index.js";
import { toAnthropicMessages } from "../src/llm/providers/anthropic.js";

function fakeClient(response: unknown, events: unknown[] = []) {
  const finalMessage = vi.fn(async () => response);
  const messageStream = () => ({
    finalMessage,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  });
  const stream = vi.fn(messageStream);
  const betaStream = vi.fn(messageStream);
  const client = {
    messages: { stream },
    beta: { messages: { stream: betaStream } },
  } as unknown as Anthropic;
  return { client, stream, betaStream, finalMessage };
}

const toolUseResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Seoul" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 34,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: null,
  },
};

describe("AnthropicProvider", () => {
  it("maps the request to Messages API params", async () => {
    const { client, stream } = fakeClient(toolUseResponse);
    const provider = new AnthropicProvider({ type: "anthropic" }, client);

    await provider.generate({
      model: "claude-opus-5",
      system: "Be brief.",
      messages: [{ role: "user", content: "Weather in Seoul?" }],
      tools: [
        {
          name: "get_weather",
          description: "Current weather for a city.",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      toolChoice: "auto",
      options: { output_config: { effort: "low" } },
    });

    expect(stream).toHaveBeenCalledWith(
      {
        output_config: { effort: "low" },
        model: "claude-opus-5",
        max_tokens: 16000,
        system: "Be brief.",
        messages: [{ role: "user", content: "Weather in Seoul?" }],
        tools: [
          {
            name: "get_weather",
            description: "Current weather for a city.",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        tool_choice: { type: "auto" },
      },
      { signal: undefined },
    );
  });

  it("normalizes the response and keeps native content for replay", async () => {
    const { client } = fakeClient(toolUseResponse);
    const provider = new AnthropicProvider({ type: "anthropic" }, client);

    const result = await provider.generate({ model: "claude-opus-5", messages: [] });

    expect(result.text).toBe("Checking.");
    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([
      { type: "tool-call", id: "toolu_1", name: "get_weather", input: { city: "Seoul" } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34, cacheReadTokens: 5 });
    expect(result.message.providerData).toEqual({
      providerType: "anthropic",
      content: toolUseResponse.content,
    });
  });

  it("uses the beta endpoint when the model options carry betas", async () => {
    const { client, stream, betaStream } = fakeClient(toolUseResponse);
    const provider = new AnthropicProvider({ type: "anthropic" }, client);

    await provider.generate({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      options: { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
    });

    expect(stream).not.toHaveBeenCalled();
    expect(betaStream).toHaveBeenCalledOnce();
  });

  it("streams text deltas, then tool calls, then the final result", async () => {
    const { client } = fakeClient(toolUseResponse, [
      { type: "message_start", message: {} },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Check" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ing." } },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      { type: "message_stop" },
    ]);
    const provider = new AnthropicProvider({ type: "anthropic" }, client);

    const events = [];
    for await (const event of provider.stream({ model: "claude-opus-5", messages: [] })) {
      events.push(event);
    }

    expect(events.slice(0, 3)).toEqual([
      { type: "text-delta", text: "Check" },
      { type: "text-delta", text: "ing." },
      {
        type: "tool-call",
        toolCall: {
          type: "tool-call",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "Seoul" },
        },
      },
    ]);
    expect(events[3]).toMatchObject({ type: "finish", result: { finishReason: "tool-calls" } });
    expect(events).toHaveLength(4);
  });

  it("maps refusals", async () => {
    const { client } = fakeClient({ ...toolUseResponse, content: [], stop_reason: "refusal" });
    const provider = new AnthropicProvider({ type: "anthropic" }, client);
    const result = await provider.generate({ model: "claude-opus-5", messages: [] });
    expect(result.finishReason).toBe("refusal");
  });

  it("wraps SDK errors with retryability", async () => {
    const { client, finalMessage } = fakeClient(null);
    finalMessage.mockRejectedValueOnce(
      new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()),
    );
    const provider = new AnthropicProvider({ type: "anthropic" }, client);

    const error = await provider.generate({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ provider: "anthropic", status: 429, retryable: true });
  });
});

describe("prompt caching", () => {
  async function paramsFor(request: Partial<Parameters<AnthropicProvider["generate"]>[0]>) {
    const { client, stream } = fakeClient(toolUseResponse);
    await new AnthropicProvider({ type: "anthropic" }, client).generate({
      model: "claude-opus-5",
      messages: [],
      ...request,
    });
    return (stream.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  }

  it("sends plain params when caching is off", async () => {
    const params = await paramsFor({
      system: "Rules.",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(params.system).toBe("Rules.");
    expect(params).not.toHaveProperty("cache_control");
  });

  it("caches the system prompt and the conversation tail when enabled", async () => {
    const params = await paramsFor({
      system: "Rules.",
      messages: [{ role: "user", content: "hi" }],
      promptCache: { ttl: "5m" },
    });
    expect(params.system).toEqual([
      { type: "text", text: "Rules.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });

  it("applies the 1h TTL to every breakpoint", async () => {
    const params = await paramsFor({
      system: [{ type: "text", text: "Rules." }],
      messages: [{ role: "user", content: [{ type: "text", text: "doc", cache: true }] }],
      promptCache: { ttl: "1h" },
    });
    const ttl1h = { type: "ephemeral", ttl: "1h" };
    expect(params.system).toEqual([{ type: "text", text: "Rules.", cache_control: ttl1h }]);
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "doc", cache_control: ttl1h }] },
    ]);
    expect(params.cache_control).toEqual(ttl1h);
  });

  it("marks flagged parts even without promptCache (shared document, varying question)", async () => {
    const params = await paramsFor({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<large document>", cache: true },
            { type: "text", text: "Question 1?" },
          ],
        },
      ],
    });
    expect(params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "<large document>", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Question 1?" },
        ],
      },
    ]);
    expect(params).not.toHaveProperty("cache_control");
  });

  it("stays within 4 breakpoints, dropping the earliest flagged parts first", async () => {
    const doc = (text: string) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text, cache: true }],
    });
    const params = await paramsFor({
      system: "Rules.",
      messages: [doc("d1"), doc("d2"), doc("d3"), doc("d4")],
      promptCache: { ttl: "5m" },
    });

    const marked = (params.messages as { content: { text: string; cache_control?: unknown }[] }[])
      .flatMap((m) => m.content)
      .filter((block) => block.cache_control)
      .map((block) => block.text);
    // 1 automatic + 1 system + 2 flagged parts = 4
    expect(marked).toEqual(["d3", "d4"]);
    expect((params.system as { cache_control?: unknown }[])[0]?.cache_control).toBeDefined();
    expect(params.cache_control).toBeDefined();
  });
});

describe("toAnthropicMessages", () => {
  it("converts tool calls and results", () => {
    const messages: Message[] = [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", id: "c1", name: "get_weather", input: { city: "Seoul" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", content: "boom", isError: true }],
      },
    ];

    expect(toAnthropicMessages(messages)).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "get_weather", input: { city: "Seoul" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }],
      },
    ]);
  });

  it("replays native content verbatim, ignoring other providers' data", () => {
    const native = [{ type: "thinking", thinking: "", signature: "sig" }];
    expect(
      toAnthropicMessages([
        {
          role: "assistant",
          content: "ignored",
          providerData: { providerType: "anthropic", content: native },
        },
        {
          role: "assistant",
          content: "kept",
          providerData: { providerType: "openai", content: [] },
        },
      ]),
    ).toEqual([
      { role: "assistant", content: native },
      { role: "assistant", content: "kept" },
    ]);
  });
});
