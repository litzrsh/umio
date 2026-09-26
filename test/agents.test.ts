import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AdrStore,
  Agent,
  type GenerateRequest,
  type GenerateResult,
  LLM,
  type ModelClient,
  parseConfig,
  type StreamEvent,
  type ToolCallPart,
  type ToolContext,
  tool,
  Workflow,
  type WorkflowEvent,
} from "../src/index.js";

const text = (value: string): GenerateResult => ({
  message: { role: "assistant", content: [{ type: "text", text: value }] },
  text: value,
  toolCalls: [],
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 2 },
  model: "fake",
  raw: {},
});

const callTool = (name: string, input: unknown): GenerateResult => {
  const call: ToolCallPart = { type: "tool-call", id: `c-${name}`, name, input };
  return {
    ...text(""),
    message: { role: "assistant", content: [call] },
    toolCalls: [call],
    finishReason: "tool-calls",
  };
};

/** Answers from a script keyed by agent name (parsed from the system prompt). */
function scriptedModel(script: Record<string, GenerateResult[]>) {
  const requests: GenerateRequest[] = [];
  const next = (request: GenerateRequest) => {
    requests.push(request);
    const system = JSON.stringify(request.system);
    const agent = Object.keys(script).find((name) => system.includes(`You are ${name}.`));
    const result = agent ? script[agent]?.shift() : undefined;
    if (!result) throw new Error(`no scripted reply for ${system}`);
    return result;
  };
  const model: ModelClient = {
    generate: async (request) => next(request),
    async *stream(request): AsyncGenerator<StreamEvent> {
      yield { type: "finish", result: next(request) };
    },
  };
  return { model, requests };
}

async function adrDir() {
  const dir = await mkdtemp(join(tmpdir(), "umio-wf-"));
  await writeFile(
    join(dir, "0001-use-typescript.md"),
    "# 1. Use TypeScript\n\n## Status\n\nAccepted\n\n## Decision\n\nWe will use TypeScript everywhere.\n",
  );
  return dir;
}

describe("Agent", () => {
  it("runs with its role as system prompt and only its own tools", async () => {
    const seen: ToolContext[] = [];
    const lookup = tool({
      name: "lookup",
      description: "Looks things up.",
      parameters: z.object({ q: z.string() }),
      execute: (_input, context) => {
        seen.push(context);
        return "found";
      },
    });
    const researcher = new Agent({
      name: "Researcher",
      role: "Gathers facts.",
      instructions: "Cite sources.",
      model: "small",
      tools: [lookup],
    });
    const { model, requests } = scriptedModel({
      Researcher: [callTool("lookup", { q: "x" }), text("facts")],
    });

    const result = await researcher.run("Research X", { llm: model, context: ["SHARED"] });

    expect(result.text).toBe("facts");
    expect(requests[0]).toMatchObject({
      model: "small",
      system: [
        { type: "text", text: "SHARED", cache: true },
        { type: "text", text: "You are Researcher. Gathers facts.\n\nCite sources." },
      ],
      messages: [{ role: "user", content: "Research X" }],
    });
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["lookup"]);
    expect(seen[0]).toMatchObject({ agent: "Researcher", toolCallId: "c-lookup" });
  });
});

describe("Workflow", () => {
  it("passes each output to the next step and supports custom inputs", async () => {
    const researcher = new Agent({ name: "Researcher", role: "Research." });
    const writer = new Agent({ name: "Writer", role: "Write." });
    const editor = new Agent({ name: "Editor", role: "Edit." });
    const { model, requests } = scriptedModel({
      Researcher: [text("notes")],
      Writer: [text("draft")],
      Editor: [text("final")],
    });

    const run = await new Workflow({ llm: model, adr: false })
      .step(researcher)
      .step(writer)
      .step(editor, {
        input: ({ input, outputs }) =>
          `Topic: ${input}\nNotes: ${outputs.Researcher}\nDraft: ${outputs.Writer}`,
      })
      .run("AI trends");

    expect(requests.map((r) => r.messages[0]?.content)).toEqual([
      "AI trends",
      "notes",
      "Topic: AI trends\nNotes: notes\nDraft: draft",
    ]);
    expect(run.output).toBe("final");
    expect(run.outputs).toEqual({ Researcher: "notes", Writer: "draft", Editor: "final" });
    expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
  });

  it("rejects duplicate step names and empty workflows", async () => {
    const agent = new Agent({ name: "A", role: "r" });
    const { model } = scriptedModel({});
    expect(() => new Workflow({ llm: model }).step(agent).step(agent)).toThrow(/Duplicate step/);
    await expect(new Workflow({ llm: model }).run()).rejects.toThrow(/no steps/);
  });

  it("rejects a step whose output is over the checkpoint limit, naming the limit", async () => {
    const writer = new Agent({ name: "Writer", role: "r" });
    const { model } = scriptedModel({ Writer: [text("x".repeat(300_000))] });
    await expect(new Workflow({ llm: model, adr: false }).step(writer).run()).rejects.toThrow(
      /over the 262144-byte limit/,
    );
  });

  it("shares state between steps and tools", async () => {
    const remember = tool({
      name: "remember",
      description: "",
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }, { state }) => {
        await state?.set("fact", value);
        return "ok";
      },
    });
    const first = new Agent({ name: "First", role: "r", tools: [remember] });
    const second = new Agent({ name: "Second", role: "r" });
    const { model, requests } = scriptedModel({
      First: [callTool("remember", { value: "42" }), text("done")],
      Second: [text("used it")],
    });

    const run = await new Workflow({ llm: model, adr: false })
      .step(first)
      .step(second, { input: async ({ state }) => `fact=${await state.get("fact")}` })
      .run();

    expect(requests.at(-1)?.messages[0]?.content).toBe("fact=42");
    await expect(run.state.get("fact")).resolves.toBe("42");
  });

  it("applies ADRs to every step: shared context, tools, and collected proposals", async () => {
    const store = new AdrStore(await adrDir());
    const planner = new Agent({ name: "Planner", role: "Plan." });
    const builder = new Agent({ name: "Builder", role: "Build." });
    const { model, requests } = scriptedModel({
      Planner: [
        callTool("propose_adr", {
          title: "Use Vitest",
          context: "Need tests.",
          decision: "We will use Vitest.",
          consequences: "Fast tests.",
        }),
        text("plan"),
      ],
      Builder: [text("built")],
    });
    const events: WorkflowEvent[] = [];

    const run = await new Workflow({ llm: model, adr: store, onEvent: (e) => void events.push(e) })
      .step(planner)
      .step(builder)
      .run("Build it");

    const systems = requests.map((r) => r.system as { text: string; cache?: boolean }[]);
    for (const system of systems) {
      expect(system[0]?.text).toContain("We will use TypeScript everywhere.");
      expect(system[0]?.cache).toBe(true);
    }
    // Identical ADR prefix across agents, so providers can reuse the cache.
    expect(new Set(systems.map((s) => s[0]?.text)).size).toBe(1);
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual([
      "list_adrs",
      "propose_adr",
      "read_adr",
    ]);

    expect(run.proposedAdrs.map((adr) => [adr.number, adr.title, adr.status])).toEqual([
      [2, "Use Vitest", "Proposed"],
    ]);
    expect(
      events.filter((e) => e.type !== "agent-event").map((e) => `${e.type}:${e.step}`),
    ).toEqual([
      "step-start:Planner",
      "adr-proposed:Planner",
      "step-finish:Planner",
      "step-start:Builder",
      "step-finish:Builder",
    ]);
    // Proposed ADRs are not binding context until a human accepts them.
    await expect(store.context()).resolves.not.toContain("Vitest");
  });

  it("uses the config's adr section by default", async () => {
    const dir = await adrDir();
    const config = parseConfig(
      {
        defaultModel: "m",
        providers: { p: { type: "ollama" } },
        models: { m: { provider: "p", model: "x" } },
        adr: { path: dir, tools: false },
      },
      {},
    );
    const seen: GenerateRequest[] = [];
    const llm = new LLM(config, {
      env: {},
      providerFactory: () => ({
        type: "ollama",
        generate: async (request) => {
          seen.push(request as GenerateRequest);
          return text("ok");
        },
      }),
    });

    await new Workflow({ llm }).step(new Agent({ name: "A", role: "r" })).run("go");

    expect(JSON.stringify(seen[0]?.system)).toContain("Use TypeScript");
    expect(seen[0]?.tools ?? []).toEqual([]);
  });
});

describe("Agent.asTool (hierarchical delegation)", () => {
  it("lets a coordinator delegate to a specialist that runs its own loop", async () => {
    const calculator = tool({
      name: "calc",
      description: "",
      parameters: z.object({}),
      execute: (_input, context) => `calc by ${context.agent}`,
    });
    const specialist = new Agent({ name: "Math Expert", role: "Does math.", tools: [calculator] });
    const { model, requests } = scriptedModel({
      Coordinator: [
        callTool("ask_math_expert", { task: "What is 6*7?" }),
        text("The answer is 42."),
      ],
      "Math Expert": [callTool("calc", {}), text("42")],
    });
    const coordinator = new Agent({
      name: "Coordinator",
      role: "Delegates.",
      tools: [specialist.asTool({ llm: model })],
    });

    const result = await coordinator.run("Ask the expert", { llm: model });

    expect(result.text).toBe("The answer is 42.");
    const delegation = result.steps[0]?.toolExecutions[0];
    expect(delegation?.result.content).toBe("42");
    // The specialist saw only the delegated task and only its own tools.
    const specialistRequest = requests.find((r) =>
      JSON.stringify(r.system).includes("Math Expert"),
    );
    expect(specialistRequest?.messages[0]).toEqual({ role: "user", content: "What is 6*7?" });
    expect(specialistRequest?.tools?.map((t) => t.name)).toEqual(["calc"]);
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual(["ask_math_expert"]);
  });
});
