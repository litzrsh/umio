/**
 * Simulated multi-hour LLM operations (plan §10), on a fake clock: no real
 * waiting. Executors use the default limits: a 3 h node timeout, a 30 s lease
 * renewed every 10 s, a 2 s cancel poll and a 10 s grace period.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  agentNode,
  type GenerateResult,
  LLM,
  type LLMProvider,
  MemoryCheckpointStore,
  type ModelClient,
  type NodeSpec,
  type ProviderRequest,
  parseConfig,
  WorkflowExecutor,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import {
  graph,
  HOUR,
  MINUTE,
  ProcessStore,
  recorder,
  SECOND,
  sleeper,
  track,
} from "./support/graph.js";

const START = 1_000_000;

function world() {
  const clock = new FakeClock(START);
  const shared = new MemoryCheckpointStore({ now: clock.now });
  const spawn = () => {
    const store = new ProcessStore(shared);
    return { store, executor: new WorkflowExecutor({ store }, clock) };
  };
  return { clock, shared, spawn };
}

const reply = (text: string): GenerateResult => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  text,
  toolCalls: [],
  finishReason: "stop",
  rawFinishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "fake",
  raw: {},
});

/** A model call that answers when the fake clock reaches `start + durationMs`, silent until then. */
function slowModel(clock: FakeClock, durationMs: number) {
  const aborts: number[] = [];
  const calls: number[] = [];
  const answer = (signal: AbortSignal | undefined) =>
    new Promise<GenerateResult>((resolve, reject) => {
      calls.push(clock.now());
      const cancel = clock.setTimer(durationMs, () => resolve(reply("finally")));
      signal?.addEventListener(
        "abort",
        () => {
          aborts.push(clock.now());
          cancel();
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  return { answer, aborts, calls };
}

describe("a 2.5-hour model call", () => {
  it("completes without a timeout, abort or retry, with ~900 renewals and a live lease", async () => {
    const { clock, shared, spawn } = world();
    const { store, executor } = spawn();
    const model = slowModel(clock, 2.5 * HOUR);
    const llm: ModelClient = {
      generate: (request) => model.answer(request.signal),
      stream: () => {
        throw new Error("unused");
      },
    };
    const def = graph([{ id: "think", handler: "think" }], [], {
      think: agentNode(new Agent({ name: "Thinker", role: "Thinks slowly." }), { llm, adr: false }),
    });
    const events = recorder();
    const run = track(executor.run(def, "ponder", { runId: "r1", observer: events.observer }));

    for (let minute = 1; minute <= 150; minute++) {
      await clock.advance(MINUTE);
      if (minute % 10 === 0 && minute < 150) {
        // Nobody else can take the run over: the lease never lapses.
        await expect(shared.acquireLease("r1", "intruder", 30_000)).resolves.toBeUndefined();
      }
    }

    expect(run.value?.status).toBe("completed");
    expect(run.value?.nodes.think?.output).toMatchObject({ text: "finally" });
    expect(model.aborts).toEqual([]);
    expect(events.summary().filter((event) => event.startsWith("node-retry"))).toEqual([]);
    // One per 10 s; the 900th falls due together with the answer, which may win the tie.
    expect(store.renewals).toBeGreaterThanOrEqual(899);
    expect(store.renewals).toBeLessThanOrEqual(900);
  });
});

describe("a model call beyond the 3-hour node timeout", () => {
  const long = (cooperative: boolean) => {
    const w = world();
    const { executor } = w.spawn();
    const node = sleeper(w.clock, 4 * HOUR, { cooperative });
    const run = track(
      executor.run(graph([{ id: "a", handler: "a" }], [], { a: node.handler }), null),
    );
    return { ...w, node, run };
  };

  it("is aborted at exactly 3 h; a cooperative handler fails with timeout", async () => {
    const { clock, node, run } = long(true);
    await clock.advance(3 * HOUR - 1);
    expect(node.abortTimes).toEqual([]);
    await clock.advance(1);
    expect(node.abortTimes).toEqual([START + 3 * HOUR]);
    await settle();
    expect(run.value?.status).toBe("failed");
    expect(run.value?.nodes.a).toMatchObject({ status: "failed", error: { code: "timeout" } });
  });

  it("leaves an uncooperative handler uncertain after the grace period", async () => {
    const { clock, node, run } = long(false);
    await clock.advance(3 * HOUR + 10 * SECOND - 1);
    expect(node.abortTimes).toEqual([START + 3 * HOUR]);
    expect(run.settled).toBe(false);
    await clock.advance(1);
    expect(run.value?.status).toBe("needs-recovery");
    expect(run.value?.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "abandoned-timeout",
    });
  });
});

describe("a cancel at 1 h into a model call", () => {
  it("is detected within 2 s, aborts the call and drops the queued one unsent", async () => {
    const { clock, spawn } = world();
    const owner = spawn();
    const model = slowModel(clock, 2.5 * HOUR);
    const provider: LLMProvider = {
      type: "stub",
      generate: (request: ProviderRequest) => model.answer(request.signal),
    };
    // A local provider: one request at a time by default.
    const llm = new LLM(
      parseConfig(
        {
          defaultModel: "m",
          providers: { p: { type: "ollama" } },
          models: { m: { provider: "p", model: "x" } },
        },
        {},
      ),
      { env: {}, providerFactory: () => provider },
    );
    const agent = new Agent({ name: "Worker", role: "Works." });
    const def = graph(
      [
        { id: "a", handler: "a" },
        { id: "b", handler: "b" },
      ],
      [],
      { a: agentNode(agent, { llm, adr: false }), b: agentNode(agent, { llm, adr: false }) },
    );
    const events = recorder();
    const run = track(
      owner.executor.run(def, "go", { runId: "r1", maxConcurrency: 2, observer: events.observer }),
    );
    await settle();
    expect(model.calls).toHaveLength(1); // b waits for the provider slot
    expect(llm.requestStats().p).toMatchObject({ inFlight: 1, waiting: 1 });

    await clock.advance(HOUR);
    const second = spawn();
    await expect(second.executor.cancel("r1")).resolves.toMatchObject({ outcome: "requested" });
    await clock.advance(2 * SECOND);
    expect(model.aborts).toEqual([START + HOUR + 2 * SECOND]);
    await settle();

    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes).toMatchObject({
      a: { status: "cancelled" },
      b: { status: "cancelled" },
    });
    expect(model.calls).toHaveLength(1); // b's call never reached the provider
    expect(llm.requestStats().p).toMatchObject({ inFlight: 0, waiting: 0 });
    expect(events.summary()).toContain("run-cancel-requested");
  });
});

describe("a crash at 2 h into a model call", () => {
  const crash = async (spec: Partial<NodeSpec> = {}) => {
    const w = world();
    const first = w.spawn();
    const node = sleeper(w.clock, 2.5 * HOUR);
    const def = () => graph([{ id: "a", handler: "a", ...spec }], [], { a: node.handler });
    void first.executor.run(def(), null, { runId: "r1" });
    await w.clock.advance(2 * HOUR);
    first.store.crash(); // its timers stop and nothing more is written
    const oldLease = first.store.leases.at(-1);
    await w.clock.advance(31 * SECOND);
    const second = w.spawn();
    return { ...w, node, def, first, second, oldLease };
  };

  it("leaves the node uncertain and fences off the old owner", async () => {
    const { shared, node, def, second, oldLease } = await crash();
    const record = await second.executor.resume(def(), "r1");

    expect(record.status).toBe("needs-recovery");
    expect(record.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "process-lost",
      attempt: 1,
    });
    expect(node.contexts).toHaveLength(1); // no attempt started
    const newLease = second.store.leases.at(-1);
    expect(newLease?.token).toBeGreaterThan(oldLease?.token ?? Number.POSITIVE_INFINITY);
    // Any write the old owner still attempts is rejected.
    if (!oldLease) throw new Error("no lease recorded");
    await expect(
      shared.compareAndSwap(
        { ...record, revision: record.revision + 1 },
        record.revision,
        oldLease,
      ),
    ).resolves.toBe("lease-lost");
    await expect(shared.load("r1")).resolves.toEqual(record);
  });

  it("with recovery: retry, runs the node again with the same idempotency key", async () => {
    const { clock, node, def, second } = await crash({
      recovery: "retry",
      retry: { maxAttempts: 2, initialDelayMs: 0 },
    });
    const run = track(second.executor.resume(def(), "r1"));
    await settle();
    expect(node.contexts.map((context) => [context.attempt, context.idempotencyKey])).toEqual([
      [1, "r1:a"],
      [2, "r1:a"],
    ]);
    await clock.advance(2.5 * HOUR);
    expect(run.value?.status).toBe("completed");
  });
});
