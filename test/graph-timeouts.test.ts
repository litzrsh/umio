import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  agentNode,
  DEFAULT_NODE_TIMEOUT_MS,
  GraphNodeError,
  LLM,
  MemoryCheckpointStore,
  parseConfig,
  shortProviderTimeouts,
  WorkflowExecutor,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import {
  controlled,
  graph,
  HOUR,
  nodes,
  ProcessStore,
  recorder,
  SECOND,
  track,
} from "./support/graph.js";

function setup(options: { nodeTimeoutMs?: number | null } = {}) {
  const clock = new FakeClock(0);
  const store = new ProcessStore(new MemoryCheckpointStore({ now: clock.now }));
  const executor = new WorkflowExecutor({ store, ...options }, clock);
  return { clock, store, executor };
}

describe("node timeout", () => {
  it("aborts a cooperative attempt at the limit and fails it with a retryable timeout", async () => {
    const { clock, executor } = setup();
    const a = controlled();
    const def = graph(nodes({ id: "a", handler: "a", timeoutMs: 5 * SECOND }), [], {
      a: a.handler,
    });
    const run = track(executor.run(def, null));
    await settle();
    expect(a.contexts[0]?.deadline).toBe(5 * SECOND);

    await clock.advance(5 * SECOND - 1);
    expect(a.aborted()).toBe(false);
    await clock.advance(1);
    expect(a.aborted()).toBe(true);
    expect(a.contexts[0]?.signal.reason).toBeInstanceOf(GraphNodeError);
    await settle();

    expect(run.value?.status).toBe("failed");
    expect(run.value?.nodes.a).toMatchObject({
      status: "failed",
      error: { code: "timeout", retryable: true },
    });
    expect(run.value?.error).toMatchObject({ code: "timeout", nodeId: "a" });
  });

  it("retries a timed-out attempt per the retry policy", async () => {
    const { clock, executor } = setup();
    clock.randomValue = 0;
    const a = controlled();
    const def = graph(
      nodes({
        id: "a",
        handler: "a",
        timeoutMs: 5 * SECOND,
        retry: { maxAttempts: 2, initialDelayMs: 1 },
      }),
      [],
      { a: a.handler },
    );
    const run = track(executor.run(def, null));
    await clock.advance(5 * SECOND);
    expect(a.calls()).toBe(2);
    expect(a.contexts[1]?.deadline).toBe(10 * SECOND);
    a.finish("second time");
    await settle();
    expect(run.value?.nodes.a).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("discards a result that arrives after the timeout fired", async () => {
    const { clock, executor } = setup();
    const a = controlled({ cooperative: false });
    const def = graph(nodes({ id: "a", handler: "a", timeoutMs: 5 * SECOND }), [], {
      a: a.handler,
    });
    const run = track(executor.run(def, null));
    await clock.advance(5 * SECOND);
    a.finish("too late");
    await settle();
    expect(run.value?.nodes.a).toMatchObject({ status: "failed", error: { code: "timeout" } });
    expect(run.value?.nodes.a?.output).toBeUndefined();
  });

  it("abandons an attempt that ignores the abort: uncertain, then needs-recovery", async () => {
    const { clock, store, executor } = setup();
    const a = controlled({ cooperative: false });
    const def = graph(
      nodes({ id: "a", handler: "a", timeoutMs: 5 * SECOND }, "b"),
      [{ from: "a", to: "b" }],
      { a: a.handler, b: async () => "b" },
    );
    const events = recorder();
    const run = track(executor.run(def, null, { runId: "r1", observer: events.observer }));

    await clock.advance(5 * SECOND + 10 * SECOND - 1);
    expect(run.settled).toBe(false);
    await clock.advance(1);
    expect(run.value?.status).toBe("needs-recovery");
    expect(run.value?.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "abandoned-timeout",
      finishedAt: 15 * SECOND,
    });
    expect(run.value?.nodes.b?.status).toBe("pending");
    expect(events.summary().slice(-2)).toEqual(["node-finish:a:uncertain", "run-needs-recovery:a"]);

    // The abandoned handler finishes later; its result is discarded (I7).
    const writes = store.writes.length;
    a.finish("late");
    await settle();
    expect(store.writes.length).toBe(writes);
    await expect(store.inner.load("r1")).resolves.toEqual(run.value);
    // The lease was released: another executor can recover at once.
    await expect(store.inner.acquireLease("r1", "other", 30_000)).resolves.toBeDefined();
  });

  it("makes an abandoned recovery-retry node pending again with the same idempotency key", async () => {
    const { clock, executor } = setup();
    clock.randomValue = 0;
    const a = controlled({ cooperative: false });
    const def = graph(
      nodes({
        id: "a",
        handler: "a",
        timeoutMs: 5 * SECOND,
        recovery: "retry",
        retry: { maxAttempts: 2, initialDelayMs: 1 },
      }),
      [],
      { a: a.handler },
    );
    const run = track(executor.run(def, null, { runId: "r1" }));
    await clock.advance(15 * SECOND);
    expect(a.calls()).toBe(2);
    a.finish("ok");
    await settle();
    expect(run.value?.status).toBe("completed");
    expect(a.contexts.map((context) => context.idempotencyKey)).toEqual(["r1:a", "r1:a"]);
  });

  it("starts nothing new once a node is uncertain, but lets running attempts finish", async () => {
    const { clock, executor } = setup();
    const a = controlled({ cooperative: false });
    const b = controlled();
    const c = controlled();
    const def = graph(
      nodes({ id: "a", handler: "a", timeoutMs: 5 * SECOND }, "b", "c"),
      [{ from: "b", to: "c" }],
      { a: a.handler, b: b.handler, c: c.handler },
    );
    const events = recorder();
    const run = track(executor.run(def, null, { observer: events.observer }));
    await clock.advance(15 * SECOND); // a abandoned
    expect(run.settled).toBe(false); // b is still running
    // The abandoned attempt's progress is no longer reported; b's still is.
    a.contexts[0]?.emit({ type: "custom", name: "stale" });
    b.contexts[0]?.emit({ type: "custom", name: "live" });
    await settle();
    expect(events.summary().filter((event) => event.startsWith("node-event"))).toEqual([
      "node-event:b#1",
    ]);
    expect(b.aborted()).toBe(false);
    b.finish();
    await settle();
    expect(c.calls()).toBe(0);
    expect(run.value?.status).toBe("needs-recovery");
    expect(run.value?.nodes).toMatchObject({
      a: { status: "uncertain" },
      b: { status: "completed" },
      c: { status: "pending" },
    });
  });

  it("uses the executor's nodeTimeoutMs, defaulting to 3 h, and null disables it", async () => {
    for (const [option, node, expected] of [
      [undefined, undefined, DEFAULT_NODE_TIMEOUT_MS],
      [HOUR, undefined, HOUR],
      [HOUR, 2 * HOUR, 2 * HOUR],
      [HOUR, null, undefined],
      [null, undefined, undefined],
    ] as const) {
      const { clock, executor } = setup({ nodeTimeoutMs: option });
      const a = controlled();
      const def = graph(
        nodes({ id: "a", handler: "a", ...(node !== undefined && { timeoutMs: node }) }),
        [],
        {
          a: a.handler,
        },
      );
      const run = track(executor.run(def, null));
      await settle();
      expect(a.contexts[0]?.deadline).toBe(expected);
      await clock.advance(10 * HOUR);
      expect(a.aborted()).toBe(expected !== undefined);
      if (expected === undefined) a.finish();
      await settle();
      expect(run.value?.status).toBe(expected === undefined ? "completed" : "failed");
    }
  });
});

describe("inactivity timeout", () => {
  it("aborts an attempt that stops reporting progress", async () => {
    const { clock, executor } = setup();
    const a = controlled();
    const def = graph(nodes({ id: "a", handler: "a", inactivityTimeoutMs: 60 * SECOND }), [], {
      a: a.handler,
    });
    const run = track(executor.run(def, null));
    await settle();
    // Progress every 30 s for 5 minutes keeps it alive.
    for (let i = 0; i < 10; i++) {
      await clock.advance(30 * SECOND);
      a.contexts[0]?.emit({ type: "custom", name: "tick" });
    }
    expect(a.aborted()).toBe(false);
    await clock.advance(60 * SECOND - 1);
    expect(a.aborted()).toBe(false);
    await clock.advance(1);
    expect(a.aborted()).toBe(true);
    await settle();
    expect(run.value?.nodes.a?.error).toMatchObject({
      code: "timeout",
      message: expect.stringMatching(/no progress for 60000 ms/),
    });
  });
});

describe("configuration checks (D12)", () => {
  it("rejects lease, poll and grace settings that do not fit the lease", () => {
    expect(() => new WorkflowExecutor({ leaseRenewIntervalMs: 15_000 })).toThrow(
      /leaseRenewIntervalMs × 2 \(30000\) must be below leaseTtlMs/,
    );
    expect(() => new WorkflowExecutor({ leaseRenewIntervalMs: 14_999 })).not.toThrow();
    expect(() => new WorkflowExecutor({ cancelPollIntervalMs: 30_000 })).toThrow(
      /cancelPollIntervalMs/,
    );
    expect(() => new WorkflowExecutor({ cancelGraceMs: 30_000 })).toThrow(/cancelGraceMs/);
    expect(
      () => new WorkflowExecutor({ cancelGraceMs: 0, observerDrainTimeoutMs: 0 }),
    ).not.toThrow();
    expect(() => new WorkflowExecutor({ cancelGraceMs: -1 })).toThrow(/non-negative/);
    expect(() => new WorkflowExecutor({ nodeTimeoutMs: 0 })).toThrow(/nodeTimeoutMs/);
    expect(new WorkflowExecutor({ nodeTimeoutMs: null }).nodeTimeoutMs).toBeNull();
  });

  it("applies every graph setting from the config, with explicit options winning", () => {
    const config = parseConfig(
      {
        defaultModel: "m",
        providers: { p: { type: "anthropic", apiKey: "k" } },
        models: { m: { provider: "p", model: "x" } },
        graph: { nodeTimeoutMs: null, leaseTtlMs: 60_000, cancelGraceMs: 40_000 },
      },
      {},
    );
    expect(WorkflowExecutor.fromConfig(config).nodeTimeoutMs).toBeNull();
    expect(WorkflowExecutor.fromConfig(config, { nodeTimeoutMs: HOUR }).nodeTimeoutMs).toBe(HOUR);
    // cancelGraceMs 40 s fits only because the config's leaseTtlMs was applied.
    expect(() => WorkflowExecutor.fromConfig(config, { leaseTtlMs: 30_000 })).toThrow(
      /cancelGraceMs/,
    );
  });
});

describe("provider timeout warnings (D12)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = (provider: Record<string, unknown>, graph?: Record<string, unknown>) =>
    parseConfig(
      {
        defaultModel: "m",
        providers: { p: provider, cloud: { type: "anthropic", apiKey: "k" } },
        models: { m: { provider: "p", model: "x" }, c: { provider: "cloud", model: "y" } },
        ...(graph && { graph }),
      },
      {},
    );

  it("flags local providers whose request or header timeout is below the node timeout", () => {
    expect(shortProviderTimeouts(config({ type: "ollama" }), DEFAULT_NODE_TIMEOUT_MS)).toEqual([]);
    expect(
      shortProviderTimeouts(
        config({ type: "ollama", timeoutMs: 600_000 }),
        DEFAULT_NODE_TIMEOUT_MS,
      ),
    ).toEqual([expect.stringMatching(/"p" has timeoutMs 600000 ms, below .* 10800000 ms/)]);
    expect(
      shortProviderTimeouts(
        config({ type: "ollama", transport: { headersTimeoutMs: 300_000 } }),
        DEFAULT_NODE_TIMEOUT_MS,
      ),
    ).toEqual([expect.stringMatching(/transport.headersTimeoutMs 300000/)]);
    // Not local, or no node timeout: nothing to compare.
    expect(
      shortProviderTimeouts(
        config({ type: "ollama", local: false, timeoutMs: 1_000 }),
        DEFAULT_NODE_TIMEOUT_MS,
      ),
    ).toEqual([]);
    expect(shortProviderTimeouts(config({ type: "ollama", timeoutMs: 1_000 }), null)).toEqual([]);
    // Only the given aliases are checked.
    expect(
      shortProviderTimeouts(config({ type: "ollama", timeoutMs: 1_000 }), HOUR, ["c"]),
    ).toEqual([]);
  });

  it("emits each warning once, from fromConfig and agentNode", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const short = config({ type: "ollama", timeoutMs: 123_456 });
    WorkflowExecutor.fromConfig(short);
    WorkflowExecutor.fromConfig(short);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ code: "UMIO_PROVIDER_TIMEOUT_BELOW_NODE_TIMEOUT" });

    // A config disabling the node timeout raises nothing.
    WorkflowExecutor.fromConfig(
      config({ type: "ollama", timeoutMs: 999 }, { nodeTimeoutMs: null }),
    );
    expect(warn).toHaveBeenCalledTimes(1);

    const llm = new LLM(config({ type: "ollama", timeoutMs: 654_321 }), {
      env: {},
      providerFactory: () => {
        throw new Error("unused");
      },
    });
    agentNode(new Agent({ name: "A", role: "r" }), { llm, adr: false });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/654321/);
    // An agent on the cloud model is not affected.
    agentNode(new Agent({ name: "B", role: "r", model: "c" }), { llm, adr: false });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
