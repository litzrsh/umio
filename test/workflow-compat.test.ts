// Workflow characterization tests.
// They pin the behavior of the sequential `Workflow` as of commit a216ef9 so the
// graph-executor refactor cannot change it silently. Do not edit expectations to
// make a refactor pass; a failing test here is a compatibility break.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdrStore,
  Agent,
  type GenerateRequest,
  type GenerateResult,
  LLMError,
  MemoryKVStore,
  type ModelClient,
  type StreamEvent,
  type ToolCallPart,
  Workflow,
  type WorkflowEvent,
} from "../src/index.js";

const text = (value: string, inputTokens = 10, outputTokens = 2): GenerateResult => ({
  message: { role: "assistant", content: [{ type: "text", text: value }] },
  text: value,
  toolCalls: [],
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: { inputTokens, outputTokens },
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

type Reply = GenerateResult | ((request: GenerateRequest) => Promise<GenerateResult>);

/** Scripted replies keyed by agent name, read from the system prompt. Records every call. */
function scriptedModel(script: Record<string, Reply[]>) {
  const calls: string[] = [];
  const agentOf = (request: GenerateRequest) => {
    const system = JSON.stringify(request.system);
    return Object.keys(script).find((name) => system.includes(`You are ${name}.`));
  };
  const next = async (request: GenerateRequest): Promise<GenerateResult> => {
    const agent = agentOf(request);
    if (agent) calls.push(agent);
    const reply = agent ? script[agent]?.shift() : undefined;
    if (!reply) throw new Error(`no scripted reply for ${agent ?? "unknown agent"}`);
    return typeof reply === "function" ? reply(request) : reply;
  };
  const model: ModelClient = {
    generate: next,
    async *stream(request): AsyncGenerator<StreamEvent> {
      yield { type: "finish", result: await next(request) };
    },
  };
  return { model, calls };
}

/** Rejects like a provider does when the request's signal aborts mid-call. */
function abortableReply(started: () => void): Reply {
  return (request) =>
    new Promise<GenerateResult>((_resolve, reject) => {
      const fail = () =>
        reject(new LLMError("Request aborted.", { provider: "fake", retryable: false }));
      if (request.signal?.aborted) return fail();
      request.signal?.addEventListener("abort", fail, { once: true });
      started();
    });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const agents = () => ({
  a: new Agent({ name: "A", role: "First." }),
  b: new Agent({ name: "B", role: "Second." }),
  c: new Agent({ name: "C", role: "Third." }),
});

/** Event sequence as compact strings: "type:step" plus the inner loop event type. */
function describeEvents(events: WorkflowEvent[]): string[] {
  return events.map((event) =>
    event.type === "agent-event"
      ? `agent-event:${event.step}:${event.event.type}`
      : `${event.type}:${event.step}`,
  );
}

describe("Workflow compatibility (P0)", () => {
  it("emits events in a fixed order, with adr-proposed inside its step", async () => {
    const store = new AdrStore(await mkdtemp(join(tmpdir(), "umio-p0-")));
    const { a, b, c } = agents();
    const { model } = scriptedModel({
      A: [text("a-out")],
      B: [
        callTool("propose_adr", {
          title: "Use X",
          context: "c",
          decision: "d",
          consequences: "q",
        }),
        text("b-out"),
      ],
      C: [text("c-out")],
    });
    const events: WorkflowEvent[] = [];

    await new Workflow({ llm: model, adr: store, onEvent: (event) => void events.push(event) })
      .step(a)
      .step(b)
      .step(c)
      .run("go");

    expect(describeEvents(events)).toEqual([
      "step-start:A",
      "agent-event:A:step-finish",
      "step-finish:A",
      "step-start:B",
      "adr-proposed:B",
      "agent-event:B:tool-result",
      "agent-event:B:step-finish",
      "agent-event:B:step-finish",
      "step-finish:B",
      "step-start:C",
      "agent-event:C:step-finish",
      "step-finish:C",
    ]);
    const start = events.find((e) => e.type === "step-start" && e.step === "B");
    expect(start).toEqual({ type: "step-start", step: "B", agent: "B", input: "a-out" });
    const proposed = events.find((e) => e.type === "adr-proposed");
    expect(proposed).toMatchObject({ step: "B", agent: "B", adr: { number: 1, title: "Use X" } });
  });

  it("wraps streamed agent events when stream is true", async () => {
    const { a } = agents();
    const { model } = scriptedModel({ A: [text("hi")] });
    const events: WorkflowEvent[] = [];

    await new Workflow({
      llm: model,
      adr: false,
      stream: true,
      onEvent: (e) => void events.push(e),
    })
      .step(a)
      .run("go");

    expect(describeEvents(events)).toEqual([
      "step-start:A",
      "agent-event:A:finish",
      "agent-event:A:step-finish",
      "step-finish:A",
    ]);
  });

  it("awaits onEvent: a slow callback delays the next step", async () => {
    const { a, b } = agents();
    const { model, calls } = scriptedModel({ A: [text("a")], B: [text("b")] });
    const gate = deferred();
    const reachedGate = deferred();

    const run = new Workflow({
      llm: model,
      adr: false,
      onEvent: async (event) => {
        if (event.type === "step-finish" && event.step === "A") {
          reachedGate.resolve();
          await gate.promise;
        }
      },
    })
      .step(a)
      .step(b)
      .run("go");

    await reachedGate.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["A"]);
    gate.resolve();
    await run;
    expect(calls).toEqual(["A", "B"]);
  });

  it("rejects run() with the error thrown by onEvent, and stops", async () => {
    const { a, b } = agents();
    const { model, calls } = scriptedModel({ A: [text("a")], B: [text("b")] });
    const failure = new Error("observer broke");

    const run = new Workflow({
      llm: model,
      adr: false,
      onEvent: (event) => {
        if (event.type === "step-start" && event.step === "B") throw failure;
      },
    })
      .step(a)
      .step(b)
      .run("go");

    await expect(run).rejects.toBe(failure);
    expect(calls).toEqual(["A"]);
  });

  it("rejects with the failing step's original error instance and skips later steps", async () => {
    const { a, b, c } = agents();
    const failure = new LLMError("overloaded", { provider: "fake", status: 529, retryable: true });
    const { model, calls } = scriptedModel({
      A: [text("a")],
      B: [() => Promise.reject(failure)],
      C: [text("c")],
    });
    const events: WorkflowEvent[] = [];

    const run = new Workflow({ llm: model, adr: false, onEvent: (e) => void events.push(e) })
      .step(a)
      .step(b)
      .step(c)
      .run("go");

    await expect(run).rejects.toBe(failure);
    expect(calls).toEqual(["A", "B"]);
    expect(describeEvents(events)).toEqual([
      "step-start:A",
      "agent-event:A:step-finish",
      "step-finish:A",
      "step-start:B",
    ]);
  });

  it("rejects with the provider's abort error when aborted during a step", async () => {
    const { a, b } = agents();
    const controller = new AbortController();
    const started = deferred();
    const { model, calls } = scriptedModel({
      A: [abortableReply(started.resolve)],
      B: [text("b")],
    });
    const events: WorkflowEvent[] = [];

    const run = new Workflow({
      llm: model,
      adr: false,
      signal: controller.signal,
      onEvent: (e) => void events.push(e),
    })
      .step(a)
      .step(b)
      .run("go");

    await started.promise;
    controller.abort();

    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect((error as LLMError).message).toBe("Request aborted.");
    expect(calls).toEqual(["A"]);
    expect(describeEvents(events)).toEqual(["step-start:A"]);
  });

  it("still starts the next step after an abort between steps, then rejects", async () => {
    const { a, b, c } = agents();
    const controller = new AbortController();
    const { model, calls } = scriptedModel({
      A: [text("a")],
      B: [abortableReply(() => {})],
      C: [text("c")],
    });
    const events: WorkflowEvent[] = [];

    const run = new Workflow({
      llm: model,
      adr: false,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "step-finish" && event.step === "A") controller.abort();
      },
    })
      .step(a)
      .step(b)
      .step(c)
      .run("go");

    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(calls).toEqual(["A", "B"]);
    expect(describeEvents(events)).toEqual([
      "step-start:A",
      "agent-event:A:step-finish",
      "step-finish:A",
      "step-start:B",
    ]);
  });

  it("rejects before step-start when a step's input function throws", async () => {
    const { a, b } = agents();
    const { model, calls } = scriptedModel({ A: [text("a")], B: [text("b")] });
    const failure = new Error("bad input");
    const events: WorkflowEvent[] = [];

    const run = new Workflow({ llm: model, adr: false, onEvent: (e) => void events.push(e) })
      .step(a)
      .step(b, {
        input: () => {
          throw failure;
        },
      })
      .run("go");

    await expect(run).rejects.toBe(failure);
    expect(calls).toEqual(["A"]);
    expect(describeEvents(events).at(-1)).toBe("step-finish:A");
    expect(events.some((e) => e.type === "step-start" && e.step === "B")).toBe(false);
  });

  it("returns the documented WorkflowResult shape", async () => {
    const { a, b } = agents();
    const { model } = scriptedModel({ A: [text("a-out", 7, 3)], B: [text("b-out", 11, 5)] });
    const state = new MemoryKVStore();
    const finished: Record<string, unknown> = {};

    const result = await new Workflow({
      llm: model,
      adr: false,
      state,
      onEvent: (event) => {
        if (event.type === "step-finish") finished[event.step] = event.result;
      },
    })
      .step(a)
      .step(b, { name: "second", input: ({ input, previous }) => `${input}|${previous}` })
      .run("go");

    expect(Object.keys(result).sort()).toEqual([
      "output",
      "outputs",
      "proposedAdrs",
      "state",
      "steps",
      "usage",
    ]);
    expect(result.output).toBe("b-out");
    expect(result.outputs).toEqual({ A: "a-out", second: "b-out" });
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 8 });
    expect(result.proposedAdrs).toEqual([]);
    expect(result.state).toBe(state);
    expect(result.steps.map(({ name, agent, input }) => ({ name, agent, input }))).toEqual([
      { name: "A", agent: "A", input: "go" },
      { name: "second", agent: "B", input: "go|a-out" },
    ]);
    // The same AgentResult objects the step-finish events carried.
    expect(result.steps[0]?.result).toBe(finished.A);
    expect(result.steps[1]?.result).toBe(finished.second);
    expect(result.steps[1]?.result.text).toBe("b-out");
  });

  it("creates a fresh in-memory state when none is given", async () => {
    const { a } = agents();
    const { model } = scriptedModel({ A: [text("a")] });
    const result = await new Workflow({ llm: model, adr: false }).step(a).run();
    expect(result.state).toBeInstanceOf(MemoryKVStore);
    expect(result.steps[0]?.input).toBe("");
  });
});
