import { describe, expect, it, vi } from "vitest";
import {
  composeHooks,
  type GenerateResult,
  LLM,
  type LLMProvider,
  limitToolOutput,
  MemoryKVStore,
  type Middleware,
  type ProviderRequest,
  parseConfig,
  promptTranslator,
  type StreamEvent,
  type ToolExecution,
} from "../src/index.js";

const config = parseConfig(
  {
    defaultModel: "main",
    providers: { p: { type: "ollama" } },
    models: {
      main: { provider: "p", model: "big" },
      translator: { provider: "p", model: "small" },
    },
    responseCache: { store: "memory" },
  },
  {},
);

function answer(text: string, model = "big"): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
    model,
    raw: {},
  };
}

/** Provider that echoes the last user text; the "small" model plays translator. */
function echoProvider() {
  const requests: ProviderRequest[] = [];
  const lastUserText = (request: ProviderRequest) => {
    const last = request.messages.at(-1);
    if (last?.role !== "user") return "";
    return typeof last.content === "string"
      ? last.content
      : last.content.map((p) => p.text).join("");
  };
  const provider: LLMProvider = {
    type: "ollama",
    async generate(request) {
      requests.push(request);
      const text = lastUserText(request);
      if (request.model === "small") {
        const toKorean = String(request.system).includes("Korean");
        return answer(toKorean ? `KO(${text})` : `EN(${text})`, "small");
      }
      return answer(`answer to ${text}`);
    },
  };
  return { provider, requests };
}

function llmWith(middleware: Middleware[], provider: LLMProvider, store = new MemoryKVStore()) {
  return new LLM(config, {
    env: {},
    middleware,
    responseCacheStore: store,
    providerFactory: () => provider,
  });
}

describe("middleware pipeline", () => {
  it("runs layers outermost first and lets them rewrite requests and results", async () => {
    const order: string[] = [];
    const layer = (name: string): Middleware => ({
      name,
      transformRequest(request) {
        order.push(`${name}:request`);
        return { ...request, system: `${request.system ?? ""}[${name}]` };
      },
      async wrapGenerate({ request, next }) {
        const result = await next(request);
        order.push(`${name}:result`);
        return { ...result, text: `${result.text}<${name}>` };
      },
    });
    const { provider, requests } = echoProvider();
    const llm = llmWith([layer("a"), layer("b")], provider);

    const result = await llm.generate({ messages: [{ role: "user", content: "q" }] });

    expect(requests[0]?.system).toBe("[a][b]");
    expect(result.text).toBe("answer to q<b><a>");
    expect(order).toEqual(["a:request", "b:request", "b:result", "a:result"]);
  });

  it("keys the response cache on the rewritten request", async () => {
    let suffix = "1";
    const rewrite: Middleware = {
      name: "rewrite",
      transformRequest: (request) => ({ ...request, system: suffix }),
    };
    const { provider, requests } = echoProvider();
    const llm = llmWith([rewrite], provider);
    const request = { messages: [{ role: "user" as const, content: "q" }] };

    await llm.generate(request);
    await llm.generate(request);
    suffix = "2";
    await llm.generate(request);

    expect(requests.map((r) => r.system)).toEqual(["1", "2"]);
  });

  it("can short-circuit without calling the provider", async () => {
    const { provider, requests } = echoProvider();
    const llm = llmWith(
      [{ name: "stub", wrapGenerate: async () => answer("from middleware") }],
      provider,
    );
    await expect(llm.generate({ messages: [] })).resolves.toMatchObject({
      text: "from middleware",
    });
    expect(requests).toHaveLength(0);
  });

  it("applies generate-only middleware to streams by replaying their result", async () => {
    const { provider } = echoProvider();
    const upper: Middleware = {
      name: "upper",
      async wrapGenerate({ request, next }) {
        const result = await next(request);
        return { ...result, text: result.text.toUpperCase() };
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of llmWith([upper], provider).stream({
      messages: [{ role: "user", content: "q" }],
    })) {
      events.push(event);
    }
    expect(events[0]).toEqual({ type: "text-delta", text: "ANSWER TO Q" });
  });

  it("uses wrapStream for streaming calls", async () => {
    const { provider } = echoProvider();
    const tagger: Middleware = {
      name: "tagger",
      async *wrapStream({ request, next }) {
        yield { type: "text-delta", text: "[start]" };
        yield* next(request);
      },
    };
    const types: string[] = [];
    for await (const event of llmWith([tagger], provider).stream({ messages: [] })) {
      types.push(event.type === "text-delta" ? event.text : event.type);
    }
    expect(types[0]).toBe("[start]");
    expect(types.at(-1)).toBe("finish");
  });

  it("adds middleware with use()", async () => {
    const { provider, requests } = echoProvider();
    const llm = llmWith([], provider).use({
      name: "sys",
      transformRequest: (request) => ({ ...request, system: "added" }),
    });
    await llm.generate({ messages: [] });
    expect(requests[0]?.system).toBe("added");
  });
});

describe("promptTranslator", () => {
  it("translates user text for the main model and the answer back", async () => {
    const { provider, requests } = echoProvider();
    const llm = llmWith(
      [promptTranslator({ model: "translator", responseLanguage: "Korean" })],
      provider,
    );

    const result = await llm.generate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "문서", cache: true },
            { type: "text", text: "plain ascii" },
          ],
        },
      ],
    });

    const mainRequest = requests.find((r) => r.model === "big");
    expect(mainRequest?.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "EN(문서)", cache: true },
        { type: "text", text: "plain ascii" },
      ],
    });
    expect(result.text).toBe("KO(answer to EN(문서)plain ascii)");
    expect(result.message.content).toEqual([{ type: "text", text: result.text }]);
  });

  it("does not re-translate text it has seen before", async () => {
    const { provider, requests } = echoProvider();
    const llm = llmWith([promptTranslator({ model: "translator" })], provider);
    const first = { role: "user" as const, content: "안녕" };

    await llm.generate({ messages: [first], responseCache: false });
    await llm.generate({
      messages: [first, { role: "assistant", content: "hi" }, { role: "user", content: "잘가" }],
      responseCache: false,
    });

    const translations = requests.filter((r) => r.model === "small");
    expect(translations.map((r) => r.messages[0]?.content)).toEqual(["안녕", "잘가"]);
  });

  it("leaves calls to the translator model itself alone", async () => {
    const { provider, requests } = echoProvider();
    const llm = llmWith([promptTranslator({ model: "translator" })], provider);
    await llm.generate({ model: "translator", messages: [{ role: "user", content: "안녕" }] });
    expect(requests).toHaveLength(1);
  });

  it("fails loudly when the translation is incomplete", async () => {
    const provider: LLMProvider = {
      type: "ollama",
      generate: async () => ({ ...answer(""), finishReason: "length" }),
    };
    const llm = llmWith([promptTranslator({ model: "translator" })], provider);
    await expect(
      llm.generate({ messages: [{ role: "user", content: "안녕" }], responseCache: false }),
    ).rejects.toThrow(/did not complete/);
  });
});

describe("tool hooks helpers", () => {
  const execution = (content: string): ToolExecution => ({
    call: { type: "tool-call", id: "c", name: "t", input: {} },
    result: { type: "tool-result", toolCallId: "c", content },
    executed: true,
    durationMs: 1,
  });

  it("limitToolOutput keeps the head and tail of oversized output", () => {
    const hook = limitToolOutput({ maxChars: 10, tailRatio: 0.3 });
    expect(hook.afterToolCall?.(execution("short"))).toBeUndefined();
    const limited = hook.afterToolCall?.(execution("abcdefghijklmnopqrstuvwxyz")) as {
      content: string;
    };
    expect(limited.content).toBe("abcdefg\n… [16 characters omitted] …\nxyz");
  });

  it("composeHooks chains afterToolCall and stops at the first override", async () => {
    const log = vi.fn();
    const hooks = composeHooks(
      { afterToolCall: ({ result }) => ({ ...result, content: result.content.toUpperCase() }) },
      { afterToolCall: (e) => void log(e.result.content) },
      limitToolOutput({ maxChars: 3, tailRatio: 0 }),
      { beforeToolCall: () => undefined },
      { beforeToolCall: () => ({ content: "denied" }) },
      { beforeToolCall: () => ({ content: "never reached" }) },
    );

    await expect(hooks.afterToolCall?.(execution("abcdef"))).resolves.toMatchObject({
      content: "ABC\n… [3 characters omitted] …\n",
    });
    expect(log).toHaveBeenCalledWith("ABCDEF");
    await expect(hooks.beforeToolCall?.(execution("").call, undefined)).resolves.toEqual({
      content: "denied",
    });
    await expect(composeHooks().afterToolCall?.(execution("x"))).resolves.toBeUndefined();
  });
});
