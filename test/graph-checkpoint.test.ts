import { describe, expect, it, vi } from "vitest";
import {
  type CasResult,
  CheckpointConflictError,
  type CheckpointStore,
  type JsonValue,
  type Lease,
  LeaseLostError,
  MemoryCheckpointStore,
  type NodeContext,
  type NodeHandler,
  type WorkflowDefinition,
  WorkflowExecutor,
  type WorkflowRun,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** a → b → c, every node calling `handler` unless overridden. */
function chain(handlers: Record<string, NodeHandler> = {}): WorkflowDefinition {
  const echo: NodeHandler = async (context) => context.nodeId;
  return {
    graph: {
      id: "wf",
      version: "1",
      entry: ["a"],
      nodes: ["a", "b", "c"].map((id) => ({ id, handler: id })),
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    },
    handlers: { a: echo, b: echo, c: echo, ...handlers },
    predicates: {},
  };
}

/**
 * Wraps a store, recording every call and letting a test replace any method's
 * result. Unset overrides pass through to the memory store.
 */
class SpyStore implements CheckpointStore {
  readonly inner: MemoryCheckpointStore;
  readonly writes: WorkflowRun[] = [];
  readonly casResults: CasResult[] = [];
  renewals = 0;
  onCas?: (run: WorkflowRun) => CasResult | undefined;
  onRenew?: (lease: Lease) => Lease | undefined | "throw";

  constructor(now: () => number) {
    this.inner = new MemoryCheckpointStore({ now });
  }

  create(run: WorkflowRun, ownerId: string, ttlMs: number) {
    this.writes.push(run);
    return this.inner.create(run, ownerId, ttlMs);
  }
  load(runId: string) {
    return this.inner.load(runId);
  }
  async compareAndSwap(run: WorkflowRun, expected: number, lease: Lease) {
    const forced = this.onCas?.(run);
    const result = forced ?? (await this.inner.compareAndSwap(run, expected, lease));
    this.casResults.push(result);
    if (result === "ok") this.writes.push(run);
    return result;
  }
  acquireLease(runId: string, ownerId: string, ttlMs: number) {
    return this.inner.acquireLease(runId, ownerId, ttlMs);
  }
  async renewLease(lease: Lease, ttlMs: number) {
    this.renewals += 1;
    const forced = this.onRenew?.(lease);
    if (forced === "throw") throw new Error("store unavailable");
    if (this.onRenew) return forced;
    return this.inner.renewLease(lease, ttlMs);
  }
  releaseLease(lease: Lease) {
    return this.inner.releaseLease(lease);
  }
  requestCancel(runId: string) {
    return this.inner.requestCancel(runId);
  }
  isCancelRequested(runId: string) {
    return this.inner.isCancelRequested(runId);
  }
  delete(runId: string) {
    return this.inner.delete(runId);
  }
}

function setup(options: { start?: number } = {}) {
  const clock = new FakeClock(options.start ?? 0);
  const store = new SpyStore(clock.now);
  const executor = new WorkflowExecutor({ store }, clock);
  return { clock, store, executor };
}

/** A handler that finishes only when `finish` is called, or rejects when its signal aborts. */
function blocking() {
  let resolve: ((value: JsonValue) => void) | undefined;
  let context: NodeContext | undefined;
  const handler: NodeHandler = (ctx) =>
    new Promise((done, fail) => {
      context = ctx;
      resolve = done;
      ctx.signal.addEventListener("abort", () => fail(ctx.signal.reason), { once: true });
    });
  return {
    handler,
    started: () => context !== undefined,
    context: () => context,
    finish: (value: JsonValue = "done") => resolve?.(value),
  };
}

describe("checkpointed runs", () => {
  it("writes every change through the store and releases the lease at the end", async () => {
    const { store, executor } = setup();
    const run = await executor.run(chain(), "go", { runId: "r1" });

    expect(run.status).toBe("completed");
    await expect(store.load("r1")).resolves.toEqual(run);
    // W0, then W1 + W2 per node, then W5; one revision per write.
    expect(store.writes.map((write) => write.revision)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(store.writes.at(-1)).toEqual(run);
    // Released: another owner can take the lease immediately.
    await expect(store.acquireLease("r1", "someone-else", 30_000)).resolves.toBeDefined();
  });

  it("records the attempt before invoking the handler (W1)", async () => {
    const { store, executor } = setup();
    let seen: WorkflowRun | undefined;
    const def = chain({
      b: async (context) => {
        seen = await store.load(context.runId);
        return "b";
      },
    });
    await executor.run(def, null, { runId: "r1" });
    expect(seen?.nodes.b).toMatchObject({ status: "running", attempt: 1 });
    expect(seen?.nodes.a).toMatchObject({ status: "completed", output: "a" });
  });

  it("rejects a run ID that already exists before running anything", async () => {
    const { executor } = setup();
    await executor.run(chain(), null, { runId: "r1" });
    const handler = vi.fn(async () => "x");
    await expect(executor.run(chain({ a: handler }), null, { runId: "r1" })).rejects.toBeInstanceOf(
      CheckpointConflictError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("starts no successor when the success write (W2) fails", async () => {
    const { store, executor } = setup();
    const b = vi.fn(async () => "b");
    store.onCas = (run) => {
      if (run.nodes.a?.status === "completed") throw new Error("disk full");
      return undefined;
    };
    await expect(executor.run(chain({ b }), null, { runId: "r1" })).rejects.toThrow("disk full");
    expect(b).not.toHaveBeenCalled();
    // The store still shows the last successful write: a running, unfinished.
    const stored = await store.load("r1");
    expect(stored?.nodes.a).toMatchObject({ status: "running", attempt: 1 });
    expect(stored?.status).toBe("running");
  });

  it("stops with CheckpointConflictError on a revision conflict under a valid lease", async () => {
    const { store, executor } = setup();
    const a = blocking();
    const def = chain({ a: a.handler });
    store.onCas = (run) => (run.nodes.a?.status === "completed" ? "revision-conflict" : undefined);

    const result = executor.run(def, null, { runId: "r1" });
    await vi.waitFor(() => expect(a.started()).toBe(true));
    const writesBefore = store.writes.length;
    a.finish();

    await expect(result).rejects.toBeInstanceOf(CheckpointConflictError);
    expect(store.writes.length).toBe(writesBefore);
    expect(store.casResults.at(-1)).toBe("revision-conflict");
    // The lease was not released: it simply expires.
    await expect(store.acquireLease("r1", "other", 30_000)).resolves.toBeUndefined();
  });

  it("stops with LeaseLostError when a write is fenced off, aborting running attempts", async () => {
    const { store, executor } = setup();
    const slow = blocking();
    const def: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["fast", "slow"],
        nodes: [
          { id: "fast", handler: "fast" },
          { id: "slow", handler: "slow" },
        ],
        edges: [],
      },
      handlers: { fast: async () => "fast", slow: slow.handler },
      predicates: {},
    };
    store.onCas = (run) => (run.nodes.fast?.status === "completed" ? "lease-lost" : undefined);

    await expect(executor.run(def, null, { runId: "r1" })).rejects.toBeInstanceOf(LeaseLostError);
    const signal = slow.context()?.signal;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(LeaseLostError);
    expect(store.casResults.filter((result) => result !== "ok")).toEqual(["lease-lost"]);
  });
});

describe("owner timers under a fake clock", () => {
  it("renews the lease every 10 s through a 2.5 h silent call, with no other writes", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const result = executor.run(chain({ a: a.handler }), null, { runId: "r1" });
    await settle();
    expect(a.started()).toBe(true);
    const writesAtStart = store.writes.length;

    // 2 h 30 min in 1-minute steps; nothing is written while the call is silent.
    await clock.advanceBy(2.5 * HOUR, MINUTE);
    expect(store.renewals).toBe((2.5 * HOUR) / 10_000); // 900
    expect(store.writes.length).toBe(writesAtStart);
    // The lease never lapsed: nobody else can take it.
    await expect(store.acquireLease("r1", "other", 30_000)).resolves.toBeUndefined();

    a.finish();
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(clock.pendingTimers()).toBe(0);
    // No renewals after the run ended.
    await clock.advance(HOUR);
    expect(store.renewals).toBe(900);
  });

  it("loses the lease when a renewal is refused: aborts, writes nothing, rejects", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const result = executor.run(chain({ a: a.handler }), null, { runId: "r1" });
    const rejected = expect(result).rejects.toBeInstanceOf(LeaseLostError);
    await settle();
    const writes = store.writes.length;

    store.onRenew = () => undefined;
    await clock.advance(10_000);
    await rejected;
    expect(a.context()?.signal.reason).toBeInstanceOf(LeaseLostError);
    expect(store.writes.length).toBe(writes);
    expect(clock.pendingTimers()).toBe(0);
    // Whatever was last written stays: the node is still recorded as running.
    await expect(store.load("r1")).resolves.toMatchObject({
      status: "running",
      nodes: { a: { status: "running" } },
    });
  });

  it("writes nothing for a result that arrives as the lease is lost", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const result = executor.run(chain({ a: a.handler }), null, { runId: "r1" });
    const rejected = expect(result).rejects.toBeInstanceOf(LeaseLostError);
    await settle();
    const writes = store.writes.length;

    // The store (whose own lease record is still valid) refuses the renewal
    // just as the handler returns: the result must not be written.
    store.onRenew = () => {
      a.finish();
      return undefined;
    };
    await clock.advance(10_000);
    await rejected;
    expect(store.writes.length).toBe(writes);
    expect(store.casResults).not.toContain("lease-lost");
  });

  it("tolerates renewal errors until the lease has actually expired", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const result = executor.run(chain({ a: a.handler }), null, { runId: "r1" });
    let settledWith: unknown;
    result.then(
      (value) => {
        settledWith = value;
      },
      (error) => {
        settledWith = error;
      },
    );
    await settle();

    // One failed renewal at 10 s, then the store recovers: the run continues.
    store.onRenew = () => "throw";
    await clock.advance(10_000);
    store.onRenew = undefined;
    await clock.advance(10_000);
    expect(settledWith).toBeUndefined();

    // Renewals keep failing: at 30 s the lease (last renewed at 20 s) is
    // still valid, at 50 s it has expired and the executor gives up.
    store.onRenew = () => "throw";
    await clock.advance(20_000);
    expect(settledWith).toBeUndefined();
    await clock.advance(10_000);
    expect(settledWith).toBeInstanceOf(LeaseLostError);
    expect(a.context()?.signal.aborted).toBe(true);
  });

  it("fences off the old owner after an expiry and takeover", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const result = executor.run(chain({ a: a.handler }), null, { runId: "r1" });
    const rejected = expect(result).rejects.toBeInstanceOf(LeaseLostError);
    await settle();

    // Renewals are acknowledged but never reach the store (e.g. a lost
    // response), so the store's lease expires at 30 s while the owner carries on.
    store.onRenew = (lease) => ({ ...lease, expiresAt: Number.POSITIVE_INFINITY });
    await clock.advance(30_000);
    const takeover = await store.acquireLease("r1", "new-owner", 30_000);
    expect(takeover?.token).toBe(2);

    // The old owner's handler finishes before it notices; its W2 is fenced off.
    a.finish();
    await rejected;
    expect(store.casResults.at(-1)).toBe("lease-lost");
    await expect(store.load("r1")).resolves.toMatchObject({ nodes: { a: { status: "running" } } });
  });

  it("detects a cancel request within one poll interval and ends the run cancelled", async () => {
    const { clock, store, executor } = setup();
    const a = blocking();
    const b = vi.fn(async () => "b");
    const result = executor.run(chain({ a: a.handler, b }), null, { runId: "r1" });
    await settle();

    await clock.advance(HOUR);
    expect(a.context()?.signal.aborted).toBe(false);
    await store.requestCancel("r1");
    await clock.advance(2_000);
    expect(a.context()?.signal.aborted).toBe(true);

    const run = await result;
    expect(run.status).toBe("cancelled");
    expect(run.nodes).toMatchObject({
      a: { status: "cancelled", attempt: 1 },
      b: { status: "pending", attempt: 0 },
      c: { status: "pending", attempt: 0 },
    });
    expect(b).not.toHaveBeenCalled();
    await expect(store.load("r1")).resolves.toEqual(run);
  });

  it("records a result that arrives after the cancel request, but starts nothing new", async () => {
    const { clock, store, executor } = setup();
    let finish: (() => void) | undefined;
    // Ignores its signal and finishes normally.
    const a: NodeHandler = () =>
      new Promise((resolve) => {
        finish = () => resolve("a");
      });
    const b = vi.fn(async () => "b");
    const result = executor.run(chain({ a, b }), null, { runId: "r1" });
    await settle();
    await store.requestCancel("r1");
    await clock.advance(2_000);
    finish?.();

    const run = await result;
    expect(run.status).toBe("cancelled");
    expect(run.nodes.a).toMatchObject({ status: "completed", output: "a" });
    expect(b).not.toHaveBeenCalled();
  });

  it("keeps the first terminal decision: a failure is not turned into a cancel", async () => {
    const { clock, store, executor } = setup();
    let stopSlow: ((error: Error) => void) | undefined;
    const def: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["bad", "slow"],
        nodes: [
          { id: "bad", handler: "bad" },
          { id: "slow", handler: "slow" },
        ],
        edges: [],
      },
      handlers: {
        bad: async () => {
          throw new Error("boom");
        },
        // Ignores its signal until the test stops it.
        slow: () =>
          new Promise((_, reject) => {
            stopSlow = reject;
          }),
      },
      predicates: {},
    };
    const result = executor.run(def, null, { runId: "r1" });
    await settle(); // "bad" has failed; the run is failing
    await store.requestCancel("r1");
    await clock.advance(2_000); // the cancel request is seen, and loses to the failure
    stopSlow?.(new Error("stopped"));

    const run = await result;
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ nodeId: "bad", message: "boom" });
    expect(run.nodes.slow?.status).toBe("cancelled");
  });

  it("validates the timer settings", () => {
    expect(
      () => new WorkflowExecutor({ leaseTtlMs: 10_000, leaseRenewIntervalMs: 10_000 }),
    ).toThrow(/leaseRenewIntervalMs/);
    expect(() => new WorkflowExecutor({ cancelPollIntervalMs: 0 })).toThrow(/cancelPollIntervalMs/);
  });
});
