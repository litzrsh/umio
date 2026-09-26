import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigError,
  type GenerateResult,
  LLM,
  type LLMProvider,
  loadConfig,
  type ProviderRequest,
  parseConfig,
  runToolLoop,
  tool,
} from "../src/index.js";

const rawConfig = {
  defaultModel: "small",
  providers: { p: { type: "ollama" } },
  harnesses: {
    compact: {
      system: "Be terse. Think step by step.",
      middleware: [{ use: "promptTranslator", model: "big" }],
      toolLoop: { maxSteps: 2, maxToolOutputChars: 12 },
    },
  },
  models: {
    small: { provider: "p", model: "tiny", harness: "compact" },
    big: { provider: "p", model: "large", harness: { system: "You are thorough." } },
    plain: { provider: "p", model: "large" },
  },
};

function recordingProvider(reply: (request: ProviderRequest) => GenerateResult) {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    type: "ollama",
    async generate(request) {
      requests.push(request);
      return reply(request);
    },
  };
  return { provider, requests };
}

const text = (value: string): GenerateResult => ({
  message: { role: "assistant", content: [{ type: "text", text: value }] },
  text: value,
  toolCalls: [],
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "m",
  raw: {},
});

describe("harness config", () => {
  it("rejects references to unknown harnesses", () => {
    expect(() =>
      parseConfig(
        { ...rawConfig, models: { small: { provider: "p", model: "x", harness: "nope" } } },
        {},
      ),
    ).toThrow(/Unknown harness "nope"/);
  });

  it("rejects unknown middleware at construction and invalid options on first use", async () => {
    const withMiddleware = (middleware: unknown[]) =>
      parseConfig({ ...rawConfig, harnesses: { compact: { middleware } } }, {});
    expect(() => new LLM(withMiddleware([{ use: "nope" }]))).toThrow(/unknown middleware "nope"/);
    const llm = new LLM(withMiddleware([{ use: "promptTranslator" }]));
    await expect(llm.generate({ model: "small", messages: [] })).rejects.toThrow(ConfigError);
  });

  it("resolves the ADR path against the config file's directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "umio-"));
    const file = join(dir, "umio.config.json");
    await writeFile(file, JSON.stringify({ ...rawConfig, adr: { path: "docs/adr" } }));
    await expect(loadConfig(file, {})).resolves.toMatchObject({
      adr: { path: join(dir, "docs/adr") },
    });
  });
});

describe("harness at call time", () => {
  it("prepends the harness system prompt, for named and inline harnesses", async () => {
    const { provider, requests } = recordingProvider(() => text("ok"));
    const llm = new LLM(parseConfig(rawConfig, {}), { env: {}, providerFactory: () => provider });

    await llm.generate({ model: "big", system: "Task rules.", messages: [] });
    await llm.generate({
      model: "big",
      system: [{ type: "text", text: "Docs", cache: true }],
      messages: [],
    });
    await llm.generate({ model: "plain", system: "Task rules.", messages: [] });

    expect(requests.map((r) => r.system)).toEqual([
      "You are thorough.\n\nTask rules.",
      [
        { type: "text", text: "You are thorough." },
        { type: "text", text: "Docs", cache: true },
      ],
      "Task rules.",
    ]);
  });

  it("applies harness middleware only to that model", async () => {
    const { provider, requests } = recordingProvider((request) =>
      request.model === "large" ? text("TRANSLATED") : text("answer"),
    );
    const llm = new LLM(parseConfig(rawConfig, {}), { env: {}, providerFactory: () => provider });

    await llm.generate({ model: "small", messages: [{ role: "user", content: "안녕" }] });
    expect(requests.map((r) => r.model)).toEqual(["large", "tiny"]);
    expect(requests[1]?.messages[0]?.content).toBe("TRANSLATED");

    requests.length = 0;
    await llm.generate({ model: "plain", messages: [{ role: "user", content: "안녕" }] });
    expect(requests.map((r) => r.model)).toEqual(["large"]);
  });

  it("supplies tool-loop defaults: maxSteps and tool output limits", async () => {
    const big = tool({
      name: "dump",
      description: "",
      parameters: z.object({}),
      execute: () => "0123456789abcdefghij",
    });
    const { provider, requests } = recordingProvider(() => ({
      ...text(""),
      finishReason: "tool-calls",
      toolCalls: [{ type: "tool-call", id: "c", name: "dump", input: {} }],
    }));
    const config = parseConfig(
      { ...rawConfig, harnesses: { compact: { toolLoop: rawConfig.harnesses.compact.toolLoop } } },
      {},
    );
    const llm = new LLM(config, { env: {}, providerFactory: () => provider });

    const result = await runToolLoop(llm, { model: "small", messages: [], tools: [big] });
    expect(result.stopReason).toBe("max-steps");
    expect(requests).toHaveLength(2);
    expect(result.steps[0]?.toolExecutions[0]?.result.content).toMatch(
      /^012345678\n… \[8 characters omitted\] …\nhij$/,
    );

    const explicit = await runToolLoop(llm, {
      model: "small",
      messages: [],
      tools: [big],
      maxSteps: 1,
    });
    expect(explicit.steps).toHaveLength(1);
  });
});
