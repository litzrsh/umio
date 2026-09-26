import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  effectiveProviderSettings,
  type GenerateResult,
  isLocalProvider,
  LLM,
  LLMError,
  type LLMProvider,
  LOCAL_TIMEOUT_MS,
  OpenAIProvider,
  type ProviderConfig,
  parseConfig,
  runToolLoop,
  type StreamEvent,
  tool,
} from "../src/index.js";
import { RequestLimiter } from "../src/llm/limiter.js";
import { anthropicClientOptions } from "../src/llm/providers/anthropic.js";
import { openAIClientOptions } from "../src/llm/providers/openai.js";

describe("local classification", () => {
  const cases: [ProviderConfig, boolean][] = [
    [{ type: "ollama" }, true],
    [{ type: "ollama", baseURL: "http://gpu-box.example.com:11434/v1" }, true],
    [{ type: "ollama", local: false }, false],
    [{ type: "openai-compatible", baseURL: "http://localhost:1234/v1" }, true],
    [{ type: "openai-compatible", baseURL: "http://llm.localhost/v1" }, true],
    [{ type: "openai-compatible", baseURL: "http://127.0.0.1:8080/v1" }, true],
    [{ type: "openai-compatible", baseURL: "http://192.168.1.5:8000/v1" }, true],
    [{ type: "openai-compatible", baseURL: "http://[::1]:8000/v1" }, true],
    [{ type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" }, false],
    [{ type: "openai-compatible", baseURL: "https://api.groq.com/openai/v1" }, false],
    [{ type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", local: true }, true],
    [{ type: "openai-compatible", baseURL: "not a url" }, false],
    [{ type: "openai" }, false],
    [{ type: "anthropic" }, false],
    [{ type: "anthropic", local: true }, true],
  ];
  it.each(cases)("%j → local: %s", (config, expected) => {
    expect(isLocalProvider(config)).toBe(expected);
  });
});

describe("effective provider settings", () => {
  it("applies local defaults sized for multi-hour inference", () => {
    expect(effectiveProviderSettings({ type: "ollama" })).toEqual({
      local: true,
      timeoutMs: LOCAL_TIMEOUT_MS,
      maxRetries: 0,
      transport: { headersTimeoutMs: LOCAL_TIMEOUT_MS, bodyTimeoutMs: LOCAL_TIMEOUT_MS },
      maxConcurrentRequests: 1,
    });
    expect(LOCAL_TIMEOUT_MS).toBe(3 * 3_600_000 + 5 * 60_000);
  });

  it("lets explicit values win, and derives transport timeouts from timeoutMs", () => {
    expect(
      effectiveProviderSettings({
        type: "ollama",
        timeoutMs: 60_000,
        maxRetries: 1,
        maxConcurrentRequests: 2,
        transport: { bodyTimeoutMs: 5_000 },
      }),
    ).toEqual({
      local: true,
      timeoutMs: 60_000,
      maxRetries: 1,
      transport: { headersTimeoutMs: 60_000, bodyTimeoutMs: 5_000 },
      maxConcurrentRequests: 2,
    });
  });

  it("leaves non-local providers on SDK defaults", () => {
    expect(
      effectiveProviderSettings({
        type: "openai-compatible",
        baseURL: "https://openrouter.ai/api/v1",
      }),
    ).toEqual({
      local: false,
      timeoutMs: undefined,
      maxRetries: undefined,
      transport: undefined,
      maxConcurrentRequests: Number.POSITIVE_INFINITY,
    });
  });

  it("builds SDK options with a dispatcher only when transport timeouts apply", () => {
    const local = openAIClientOptions({ type: "ollama" });
    expect(local).toMatchObject({ timeout: LOCAL_TIMEOUT_MS, maxRetries: 0 });
    const { fetchOptions } = local as { fetchOptions: { dispatcher: unknown } };
    expect(fetchOptions.dispatcher).toBeInstanceOf(Agent);

    const cloud = openAIClientOptions({ type: "openai", apiKey: "k" });
    expect(cloud).not.toHaveProperty("timeout");
    expect(cloud).not.toHaveProperty("maxRetries");
    expect(cloud).not.toHaveProperty("fetchOptions");

    expect(anthropicClientOptions({ type: "anthropic" })).toEqual({});
    expect(
      anthropicClientOptions({ type: "anthropic", local: true, timeoutMs: 1000 }),
    ).toMatchObject({ timeout: 1000, maxRetries: 0 });
  });

  it("accepts the new fields in the config schema", () => {
    const config = parseConfig(
      {
        defaultModel: "m",
        providers: {
          p: {
            type: "openai-compatible",
            baseURL: "http://localhost:1234/v1",
            local: true,
            maxConcurrentRequests: 2,
            transport: { headersTimeoutMs: 1000, bodyTimeoutMs: 2000 },
          },
        },
        models: { m: { provider: "p", model: "x" } },
      },
      {},
    );
    expect(config.providers.p).toMatchObject({ maxConcurrentRequests: 2 });
    expect(() =>
      parseConfig(
        {
          defaultModel: "m",
          providers: { p: { type: "ollama", transport: { idleMs: 1 } } },
          models: { m: { provider: "p", model: "x" } },
        },
        {},
      ),
    ).toThrow(/idleMs/);
  });
});

describe("transport behavior against a real local HTTP server", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    server = createServer(handler);
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  const completion = {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  };

  it("uses the configured header timeout (not undici's 300 s) and does not retry locally", async () => {
    let requests = 0;
    const baseURL = await serve(() => {
      requests++; // never answers: a local server still "generating"
    });
    const provider = new OpenAIProvider({
      type: "openai-compatible",
      baseURL,
      transport: { headersTimeoutMs: 300 },
    });

    const started = Date.now();
    const error = await provider.generate({ model: "m", messages: [] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LLMError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requests).toBe(1);
  });

  it("retries on 5xx only when the provider is not local", async () => {
    let requests = 0;
    const baseURL = await serve((_req, res) => {
      requests++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"message":"boom"}}');
    });

    await new OpenAIProvider({ type: "openai-compatible", baseURL })
      .generate({ model: "m", messages: [] })
      .catch(() => undefined);
    expect(requests).toBe(1);

    requests = 0;
    await new OpenAIProvider({ type: "openai-compatible", baseURL, local: false, maxRetries: 1 })
      .generate({ model: "m", messages: [] })
      .catch(() => undefined);
    expect(requests).toBe(2);
  });

  it("closes the connection when the request's signal aborts", async () => {
    const closed = vi.fn();
    let receivedRequest!: () => void;
    const received = new Promise<void>((resolve) => {
      receivedRequest = resolve;
    });
    const baseURL = await serve((_req, res) => {
      res.on("close", closed);
      receivedRequest();
    });
    const controller = new AbortController();

    const call = new OpenAIProvider({ type: "ollama", baseURL }).generate({
      model: "m",
      messages: [],
      signal: controller.signal,
    });
    await received;
    controller.abort();

    await expect(call).rejects.toThrow("Request aborted.");
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
  });

  it("completes normally through the local dispatcher", async () => {
    const baseURL = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion));
    });
    const result = await new OpenAIProvider({ type: "ollama", baseURL }).generate({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("ok");
  });
});

describe("RequestLimiter", () => {
  const abortError = () => new Error("aborted");

  it("caps in-flight requests and serves waiters in FIFO order", async () => {
    const limiter = new RequestLimiter(1);
    const order: string[] = [];
    const first = await limiter.acquire(undefined, abortError);
    const second = limiter.acquire(undefined, abortError).then((release) => {
      order.push("second");
      return release;
    });
    const third = limiter.acquire(undefined, abortError).then((release) => {
      order.push("third");
      return release;
    });
    expect(limiter.inFlight).toBe(1);
    expect(limiter.waiting).toBe(2);

    first();
    first(); // idempotent
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
    expect(limiter.inFlight).toBe(0);
  });

  it("removes aborted waiters without granting them a slot", async () => {
    const limiter = new RequestLimiter(1);
    const release = await limiter.acquire(undefined, abortError);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal, abortError);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(limiter.waiting).toBe(0);
    release();
    expect(limiter.inFlight).toBe(0);
    await expect(limiter.acquire(AbortSignal.abort(), abortError)).rejects.toThrow("aborted");
    expect(limiter.inFlight).toBe(0);
  });
});

describe("LLM request concurrency", () => {
  function gatedProvider() {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const gates: (() => void)[] = [];
    const answer = (text: string): GenerateResult => ({
      message: { role: "assistant", content: [{ type: "text", text }] },
      text,
      toolCalls: [],
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
      raw: {},
    });
    const enter = async (label: string) => {
      calls.push(label);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
    };
    const lastText = (messages: { content: unknown }[]) => String(messages.at(-1)?.content ?? "");
    const provider: LLMProvider = {
      type: "ollama",
      async generate(request) {
        await enter(lastText(request.messages));
        return answer(`re:${lastText(request.messages)}`);
      },
      async *stream(request): AsyncGenerator<StreamEvent> {
        const label = lastText(request.messages);
        calls.push(label);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          yield { type: "text-delta", text: "a" };
          await new Promise<void>((resolve) => gates.push(resolve));
          yield { type: "finish", result: answer(`re:${label}`) };
        } finally {
          inFlight--;
        }
      },
    };
    /** Releases gated calls one at a time until `done` settles. */
    const drain = async <T>(done: Promise<T>): Promise<T> => {
      let settled = false;
      void done.finally(() => {
        settled = true;
      });
      while (!settled) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        gates.shift()?.();
      }
      return done;
    };
    return { provider, calls, gates, drain, stats: () => ({ inFlight, maxInFlight }) };
  }

  function llmFor(provider: LLMProvider, providerConfig: Record<string, unknown>, extra = {}) {
    return new LLM(
      parseConfig(
        {
          defaultModel: "m",
          providers: { p: providerConfig },
          models: { m: { provider: "p", model: "x" } },
          ...extra,
        },
        {},
      ),
      { env: {}, providerFactory: () => provider },
    );
  }

  const ask = (content: string, signal?: AbortSignal) => ({
    messages: [{ role: "user" as const, content }],
    ...(signal && { signal }),
  });

  it("serializes calls to a local provider by default", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" });
    await gated.drain(Promise.all(["a", "b", "c"].map((q) => llm.generate(ask(q)))));
    expect(gated.stats().maxInFlight).toBe(1);
    expect(gated.calls).toEqual(["a", "b", "c"]);
    expect(llm.requestStats().p).toEqual({ inFlight: 0, waiting: 0, max: 1 });
  });

  it("honors maxConcurrentRequests and leaves non-local providers unlimited", async () => {
    const two = gatedProvider();
    await two.drain(
      Promise.all(
        ["a", "b", "c", "d"].map((q) =>
          llmFor(two.provider, { type: "ollama", maxConcurrentRequests: 2 }).generate(ask(q)),
        ),
      ),
    );
    // Separate LLM instances do not share a limit (documented).
    expect(two.stats().maxInFlight).toBe(4);

    const shared = gatedProvider();
    const llm = llmFor(shared.provider, { type: "ollama", maxConcurrentRequests: 2 });
    await shared.drain(Promise.all(["a", "b", "c", "d"].map((q) => llm.generate(ask(q)))));
    expect(shared.stats().maxInFlight).toBe(2);

    const cloud = gatedProvider();
    const cloudLlm = llmFor(cloud.provider, {
      type: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
    });
    await cloud.drain(Promise.all(["a", "b", "c"].map((q) => cloudLlm.generate(ask(q)))));
    expect(cloud.stats().maxInFlight).toBe(3);
  });

  it("serializes parallel tool calls that call the model inside one agent loop", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" });
    const nested = tool({
      name: "nested",
      description: "",
      parameters: z.object({ q: z.string() }),
      execute: async ({ q }) => (await llm.generate(ask(q))).text,
    });
    const model = {
      calls: 0,
      async generate(request: Parameters<LLM["generate"]>[0]): Promise<GenerateResult> {
        this.calls++;
        if (this.calls === 1) {
          const toolCalls = ["x", "y", "z"].map((q) => ({
            type: "tool-call" as const,
            id: q,
            name: "nested",
            input: { q },
          }));
          return {
            message: { role: "assistant", content: toolCalls },
            text: "",
            toolCalls,
            finishReason: "tool-calls",
            rawFinishReason: null,
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "outer",
            raw: {},
          };
        }
        return (await llm.generate({ ...request, tools: [] })) as GenerateResult;
      },
      stream: () => {
        throw new Error("unused");
      },
    };

    const result = await gated.drain(
      runToolLoop(model, { messages: ask("go").messages, tools: [nested] }),
    );
    expect(result.steps[0]?.toolExecutions.map((e) => e.result.content)).toEqual([
      "re:x",
      "re:y",
      "re:z",
    ]);
    expect(gated.stats().maxInFlight).toBe(1);
  });

  it("rejects a queued call on abort without sending it", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" });
    const first = llm.generate(ask("first"));
    const controller = new AbortController();
    const queued = llm.generate(ask("queued", controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(llm.requestStats().p).toMatchObject({ inFlight: 1, waiting: 1 });

    controller.abort();
    const error = await queued.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).message).toBe("Request aborted.");
    await gated.drain(first);
    expect(gated.calls).toEqual(["first"]);
    expect(llm.requestStats().p).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("holds the slot for a whole stream and releases it when the consumer stops early", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" });
    const stream = llm.stream(ask("s"));
    const first = await stream.next();
    expect(first.value).toEqual({ type: "text-delta", text: "a" });

    const other = llm.generate(ask("other"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gated.calls).toEqual(["s"]); // still waiting for the stream's slot

    await stream.return(undefined); // consumer stops early
    await gated.drain(other);
    expect(gated.calls).toEqual(["s", "other"]);
    expect(llm.requestStats().p).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it("serves response-cache hits without waiting for a slot", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" }, { responseCache: { store: "memory" } });
    await gated.drain(llm.generate(ask("cached")));

    const busy = llm.generate(ask("busy"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(llm.generate(ask("cached"))).resolves.toMatchObject({ cached: true });
    await gated.drain(busy);
  });

  it("makes middleware model calls (context.generate) share the limit", async () => {
    const gated = gatedProvider();
    const llm = llmFor(gated.provider, { type: "ollama" });
    llm.use({
      name: "side-call",
      async transformRequest(request, context) {
        await context.generate(ask("side"));
        return request;
      },
    });
    await gated.drain(Promise.all([llm.generate(ask("a")), llm.generate(ask("b"))]));
    expect(gated.stats().maxInFlight).toBe(1);
    expect(gated.calls.filter((c) => c === "side")).toHaveLength(2);
  });

  it("releases the slot when the provider throws", async () => {
    const provider: LLMProvider = {
      type: "ollama",
      generate: async () => {
        throw new Error("boom");
      },
    };
    const llm = llmFor(provider, { type: "ollama" });
    await expect(llm.generate(ask("x"))).rejects.toThrow("boom");
    await expect(llm.generate(ask("y"))).rejects.toThrow("boom");
    expect(llm.requestStats().p).toMatchObject({ inFlight: 0, waiting: 0 });
  });
});
