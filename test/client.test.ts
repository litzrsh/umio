import { describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  type GenerateResult,
  LLM,
  type LLMProvider,
  MemoryKVStore,
  type ProviderConfig,
  parseConfig,
} from "../src/index.js";

const rawConfig = {
  defaultModel: "local",
  providers: {
    cloud: { type: "anthropic", apiKey: "${CLOUD_KEY}" },
    ollama: { type: "ollama" },
  },
  models: {
    smart: {
      provider: "cloud",
      model: "claude-opus-5",
      maxTokens: 8000,
      options: { output_config: { effort: "high" } },
    },
    local: { provider: "ollama", model: "llama3.2" },
  },
};

const config = parseConfig(rawConfig, {});

const result = { text: "ok", toolCalls: [] } as unknown as GenerateResult;

function stubFactory() {
  const created: ProviderConfig[] = [];
  const generate = vi.fn(async () => result);
  const factory = (providerConfig: ProviderConfig): LLMProvider => {
    created.push(providerConfig);
    return { type: providerConfig.type, generate };
  };
  return { factory, created, generate };
}

describe("LLM", () => {
  it("routes the default model to its provider", async () => {
    const { factory, generate } = stubFactory();
    const llm = new LLM(config, { providerFactory: factory, env: {} });

    await expect(llm.generate({ messages: [{ role: "user", content: "hi" }] })).resolves.toBe(
      result,
    );
    expect(generate).toHaveBeenCalledWith({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("applies model settings and lets the request override maxTokens", async () => {
    const { factory, generate } = stubFactory();
    const llm = new LLM(config, { providerFactory: factory, env: { CLOUD_KEY: "k" } });

    await llm.generate({ model: "smart", messages: [] });
    await llm.generate({ model: "smart", messages: [], maxTokens: 10 });

    expect(generate).toHaveBeenNthCalledWith(1, {
      model: "claude-opus-5",
      messages: [],
      maxTokens: 8000,
      options: { output_config: { effort: "high" } },
    });
    expect(generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ maxTokens: 10 }));
  });

  it("creates each provider once, with env references resolved", async () => {
    const { factory, created } = stubFactory();
    const llm = new LLM(config, { providerFactory: factory, env: { CLOUD_KEY: "secret" } });

    await llm.generate({ model: "smart", messages: [] });
    await llm.generate({ model: "smart", messages: [] });

    expect(created).toEqual([{ type: "anthropic", apiKey: "secret" }]);
  });

  it("only requires env vars for providers that are used", async () => {
    const { factory } = stubFactory();
    const llm = new LLM(config, { providerFactory: factory, env: {} });

    await expect(llm.generate({ model: "local", messages: [] })).resolves.toBe(result);
    await expect(llm.generate({ model: "smart", messages: [] })).rejects.toThrow(/CLOUD_KEY/);
  });

  it("streams through the provider, or falls back to generate()", async () => {
    const withStream = stubFactory();
    const streamed: LLMProvider = {
      type: "ollama",
      generate: withStream.generate,
      async *stream() {
        yield { type: "text-delta", text: "o" };
        yield { type: "finish", result };
      },
    };
    const llm = new LLM(config, { providerFactory: () => streamed, env: {} });
    const events = [];
    for await (const event of llm.stream({ messages: [] })) events.push(event);
    expect(events).toEqual([
      { type: "text-delta", text: "o" },
      { type: "finish", result },
    ]);

    const fallback = new LLM(config, { providerFactory: stubFactory().factory, env: {} });
    const fallbackEvents = [];
    for await (const event of fallback.stream({ messages: [] })) fallbackEvents.push(event);
    expect(fallbackEvents).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "finish", result },
    ]);
  });

  it("rejects unknown model aliases", async () => {
    const llm = new LLM(config, { providerFactory: stubFactory().factory });
    await expect(llm.generate({ model: "nope", messages: [] })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("LLM prompt cache setting", () => {
  it("passes the model's promptCache setting to the provider", async () => {
    const { factory, generate } = stubFactory();
    const cached = parseConfig(
      {
        defaultModel: "a",
        providers: { p: { type: "ollama" } },
        models: {
          a: { provider: "p", model: "m", promptCache: true },
          b: { provider: "p", model: "m", promptCache: { ttl: "1h" } },
          c: { provider: "p", model: "m" },
        },
      },
      {},
    );
    const llm = new LLM(cached, { providerFactory: factory, env: {} });
    await llm.generate({ model: "a", messages: [] });
    await llm.generate({ model: "b", messages: [] });
    await llm.generate({ model: "c", messages: [] });
    expect(generate.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { model: "m", messages: [], promptCache: { ttl: "5m" } },
      { model: "m", messages: [], promptCache: { ttl: "1h" } },
      { model: "m", messages: [] },
    ]);
  });
});

describe("LLM response cache", () => {
  const complete = {
    message: { role: "assistant", content: "fresh" },
    text: "fresh",
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: { inputTokens: 50, outputTokens: 5 },
    model: "llama3.2",
    raw: {},
  } satisfies GenerateResult;

  function cachedLLM(models: Record<string, unknown> = {}) {
    const created: ProviderConfig[] = [];
    const generate = vi.fn(async (_request: unknown) => complete);
    const withCache = parseConfig(
      {
        ...rawConfig,
        models: { ...rawConfig.models, ...models },
        responseCache: { store: "memory", ttlSeconds: 60 },
      },
      {},
    );
    const llm = new LLM(withCache, {
      env: {},
      providerFactory: (providerConfig) => {
        created.push(providerConfig);
        return { type: providerConfig.type, generate };
      },
    });
    return { llm, generate, created };
  }

  it("serves a repeated request from the cache without calling the provider", async () => {
    const { llm, generate } = cachedLLM();
    const request = { messages: [{ role: "user" as const, content: "hi" }] };

    const first = await llm.generate(request);
    const second = await llm.generate({ ...request, signal: new AbortController().signal });

    expect(generate).toHaveBeenCalledOnce();
    expect(first.cached).toBeUndefined();
    expect(second).toMatchObject({
      text: "fresh",
      cached: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("misses when anything sent to the provider differs", async () => {
    const { llm, generate } = cachedLLM();
    await llm.generate({ messages: [{ role: "user", content: "a" }] });
    await llm.generate({ messages: [{ role: "user", content: "b" }] });
    await llm.generate({ system: "x", messages: [{ role: "user", content: "a" }] });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("can be bypassed per request and per model", async () => {
    const { llm, generate } = cachedLLM({
      nocache: { provider: "ollama", model: "llama3.2", responseCache: false },
    });
    const messages = [{ role: "user" as const, content: "hi" }];
    await llm.generate({ messages, responseCache: false });
    await llm.generate({ messages, responseCache: false });
    await llm.generate({ model: "nocache", messages });
    await llm.generate({ model: "nocache", messages });
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("replays hits as a stream and stores streamed misses", async () => {
    const { llm, generate } = cachedLLM();
    const request = { messages: [{ role: "user" as const, content: "hi" }] };

    const miss = [];
    for await (const event of llm.stream(request)) miss.push(event);
    const hit = [];
    for await (const event of llm.stream(request)) hit.push(event);

    expect(generate).toHaveBeenCalledOnce(); // stub has no stream(): falls back to generate
    expect(miss.map((e) => e.type)).toEqual(["text-delta", "finish"]);
    expect(hit[0]).toEqual({ type: "text-delta", text: "fresh" });
    expect(hit.at(-1)).toMatchObject({ type: "finish", result: { cached: true } });
  });

  it("does not need the provider (or its API key) on a hit", async () => {
    const store = new MemoryKVStore();
    const request = { model: "smart", messages: [{ role: "user" as const, content: "hi" }] };
    const withCache = parseConfig({ ...rawConfig, responseCache: { store: "memory" } }, {});

    const online = new LLM(withCache, {
      env: { CLOUD_KEY: "k" },
      responseCacheStore: store,
      providerFactory: (c) => ({ type: c.type, generate: async () => complete }),
    });
    await online.generate(request);

    const factory = vi.fn();
    const offline = new LLM(withCache, {
      env: {},
      responseCacheStore: store,
      providerFactory: factory,
    });
    await expect(offline.generate(request)).resolves.toMatchObject({ cached: true });
    expect(factory).not.toHaveBeenCalled();
    await expect(offline.generate({ ...request, responseCache: false })).rejects.toThrow(
      /CLOUD_KEY/,
    );
  });
});
