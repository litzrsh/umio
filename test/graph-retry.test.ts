import { describe, expect, it } from "vitest";
import { retryDelay, shouldRetry } from "../src/graph/retry.js";
import {
  GraphNodeError,
  LLMError,
  MemoryCheckpointStore,
  type NodeError,
  WorkflowExecutor,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import { controlled, graph, nodes, ProcessStore, recorder, track } from "./support/graph.js";

const retryable: NodeError = { code: "x", message: "x", retryable: true };

describe("retryDelay (full jitter)", () => {
  const policy = { maxAttempts: 5, initialDelayMs: 1_000 };

  it.each([
    [1, 0.5, 500],
    [2, 0.5, 1_000],
    [3, 0.5, 2_000],
    [4, 0.25, 2_000],
    [3, 0, 0],
    [1, 0.9999, 999],
  ])("after attempt %i with random %d waits %i ms", (attempt, random, expected) => {
    expect(retryDelay(policy, attempt, () => random)).toBe(expected);
  });

  it("applies the multiplier and caps at maxDelayMs", () => {
    const capped = { ...policy, multiplier: 3, maxDelayMs: 5_000 };
    expect(retryDelay(capped, 2, () => 0.5)).toBe(1_500); // cap 3000
    expect(retryDelay(capped, 3, () => 0.5)).toBe(2_500); // cap 9000 → 5000
  });

  it("waits nothing without a policy", () => {
    expect(retryDelay(undefined, 1, () => 0.5)).toBe(0);
  });
});

describe("shouldRetry", () => {
  it("retries retryable errors while attempts remain", () => {
    const policy = { maxAttempts: 3, initialDelayMs: 0 };
    expect(shouldRetry(policy, 1, retryable)).toBe(true);
    expect(shouldRetry(policy, 2, retryable)).toBe(true);
    expect(shouldRetry(policy, 3, retryable)).toBe(false);
    expect(shouldRetry(policy, 1, { ...retryable, retryable: false })).toBe(false);
    expect(shouldRetry(undefined, 1, retryable)).toBe(false); // default maxAttempts 1
  });
});

describe("retries in the executor", () => {
  function setup() {
    const clock = new FakeClock(10_000);
    const store = new ProcessStore(new MemoryCheckpointStore({ now: clock.now }));
    const executor = new WorkflowExecutor({ store }, clock);
    return { clock, store, executor };
  }

  it("waits the exact backoff between attempts and keeps the idempotency key", async () => {
    const { clock, store, executor } = setup();
    const a = controlled();
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 3, initialDelayMs: 1_000 } }, "b"),
      [{ from: "a", to: "b" }],
      { a: a.handler, b: async () => "b" },
    );
    const events = recorder();
    const run = track(executor.run(def, null, { runId: "r1", observer: events.observer }));
    await settle();

    a.fail(new GraphNodeError("flaky", { code: "flaky", retryable: true }));
    await settle();
    // W3: pending, retryAt = now + 0.5 × 1000, the error kept.
    const waiting = await store.inner.load("r1");
    expect(waiting?.nodes.a).toMatchObject({
      status: "pending",
      attempt: 1,
      retryAt: 10_500,
      error: { code: "flaky", retryable: true },
    });
    await clock.advance(499);
    expect(a.calls()).toBe(1);
    await clock.advance(1);
    expect(a.calls()).toBe(2);

    a.fail(new LLMError("overloaded", { provider: "p", retryable: true }));
    await settle();
    await clock.advance(999); // attempt 2: 0.5 × 2000
    expect(a.calls()).toBe(2);
    await clock.advance(1);
    expect(a.calls()).toBe(3);
    a.finish("ok");
    await settle();

    expect(run.value?.status).toBe("completed");
    expect(run.value?.nodes.a).toMatchObject({ status: "completed", attempt: 3, output: "ok" });
    expect(run.value?.nodes.a?.error).toBeUndefined();
    expect(new Set(a.contexts.map((context) => context.idempotencyKey))).toEqual(new Set(["r1:a"]));
    expect(a.contexts.map((context) => context.attempt)).toEqual([1, 2, 3]);
    expect(events.events.filter((event) => event.type === "node-retry")).toEqual([
      { type: "node-retry", runId: "r1", nodeId: "a", attempt: 1, retryAt: 10_500, at: 10_000 },
      { type: "node-retry", runId: "r1", nodeId: "a", attempt: 2, retryAt: 11_500, at: 10_500 },
    ]);
  });

  it("fails the node once the attempts are exhausted", async () => {
    const { clock, executor } = setup();
    clock.randomValue = 0;
    let calls = 0;
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 2, initialDelayMs: 1 } }),
      [],
      {
        a: async () => {
          calls++;
          throw new GraphNodeError(`try ${calls}`, { code: "flaky", retryable: true });
        },
      },
    );
    const run = await executor.run(def, null);
    expect(calls).toBe(2);
    expect(run.status).toBe("failed");
    expect(run.nodes.a).toMatchObject({
      status: "failed",
      attempt: 2,
      error: { code: "flaky", message: "try 2" },
    });
  });

  it("does not retry non-retryable errors", async () => {
    const { executor } = setup();
    let calls = 0;
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 5, initialDelayMs: 1 } }),
      [],
      {
        a: async () => {
          calls++;
          throw new Error("bug");
        },
      },
    );
    const run = await executor.run(def, null);
    expect(calls).toBe(1);
    expect(run.nodes.a?.error).toMatchObject({ code: "handler-error", retryable: false });
  });

  it("runs other nodes while one waits to retry", async () => {
    const { clock, executor } = setup();
    const a = controlled();
    const b = controlled();
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 2, initialDelayMs: 60_000 } }, "b"),
      [],
      { a: a.handler, b: b.handler },
    );
    const run = track(executor.run(def, null, { maxConcurrency: 1 }));
    await settle();
    expect([a.calls(), b.calls()]).toEqual([1, 0]);
    a.fail(new GraphNodeError("later", { code: "x", retryable: true }));
    await settle();
    expect(b.calls()).toBe(1); // the slot is free during a's 30 s wait
    b.finish();
    await clock.advance(30_000);
    expect(a.calls()).toBe(2);
    a.finish();
    await settle();
    expect(run.value?.status).toBe("completed");
  });

  it("honors a persisted retryAt when a crashed run is resumed", async () => {
    const clock = new FakeClock(10_000);
    const shared = new MemoryCheckpointStore({ now: clock.now });
    const first = new ProcessStore(shared);
    const a = controlled();
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 2, initialDelayMs: 120_000 } }),
      [],
      { a: a.handler },
    );
    void new WorkflowExecutor({ store: first }, clock).run(def, null, { runId: "r1" });
    await settle();
    a.fail(new GraphNodeError("later", { code: "x", retryable: true }));
    await settle();
    first.crash(); // while waiting until 70 000
    await clock.advance(31_000);

    const run = track(
      new WorkflowExecutor({ store: new ProcessStore(shared) }, clock).resume(def, "r1"),
    );
    await settle();
    expect(a.calls()).toBe(1);
    await clock.advance(70_000 - clock.now() - 1);
    expect(a.calls()).toBe(1);
    await clock.advance(1);
    expect(a.calls()).toBe(2);
    a.finish();
    await settle();
    expect(run.value?.status).toBe("completed");
  });

  it("ends a retry wait at once when the run is cancelled", async () => {
    const { clock, executor } = setup();
    const a = controlled();
    const controller = new AbortController();
    const def = graph(
      nodes({ id: "a", handler: "a", retry: { maxAttempts: 2, initialDelayMs: 3_600_000 } }),
      [],
      { a: a.handler },
    );
    const run = track(executor.run(def, null, { signal: controller.signal }));
    await settle();
    a.fail(new GraphNodeError("later", { code: "x", retryable: true }));
    await settle();
    controller.abort();
    await settle();
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.a).toMatchObject({ status: "pending", attempt: 1 });
    expect(clock.now()).toBe(10_000);
    expect(clock.pendingTimers()).toBe(0);
  });
});
