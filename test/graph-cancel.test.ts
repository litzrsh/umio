import { describe, expect, it } from "vitest";
import {
  GraphNodeError,
  MemoryCheckpointStore,
  WorkflowExecutor,
  type WorkflowExecutorOptions,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import {
  controlled,
  graph,
  nodes,
  ProcessStore,
  recorder,
  SECOND,
  track,
} from "./support/graph.js";

function world() {
  const clock = new FakeClock(0);
  const shared = new MemoryCheckpointStore({ now: clock.now });
  const spawn = (options: WorkflowExecutorOptions = {}) => {
    const store = new ProcessStore(shared);
    return { store, executor: new WorkflowExecutor({ store, ...options }, clock) };
  };
  return { clock, shared, spawn };
}

describe("cancel() acknowledgements", () => {
  it("reports not-found and already-terminal without recording anything", async () => {
    const { shared, spawn } = world();
    const { executor } = spawn();
    await expect(executor.cancel("missing")).resolves.toEqual({
      runId: "missing",
      outcome: "not-found",
    });
    const done = await executor.run(graph(nodes("a"), [], { a: async () => 1 }), null, {
      runId: "r1",
    });
    await expect(executor.cancel("r1")).resolves.toEqual({
      runId: "r1",
      outcome: "already-terminal",
      status: "completed",
    });
    await expect(shared.isCancelRequested("r1")).resolves.toBe(false);
    await expect(shared.load("r1")).resolves.toEqual(done);
  });

  it("is `requested` for a run this executor drives, which then ends cancelled", async () => {
    const { shared, spawn } = world();
    const { executor } = spawn();
    const a = controlled();
    const events = recorder();
    const run = track(
      executor.run(
        graph(nodes("a", "b"), [{ from: "a", to: "b" }], { a: a.handler, b: a.handler }),
        null,
        {
          runId: "r1",
          observer: events.observer,
        },
      ),
    );
    await settle();
    await expect(executor.cancel("r1")).resolves.toEqual({
      runId: "r1",
      outcome: "requested",
      status: "running",
    });
    await settle();
    expect(a.aborted()).toBe(true);
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes).toMatchObject({
      a: { status: "cancelled" },
      b: { status: "pending" },
    });
    await expect(shared.isCancelRequested("r1")).resolves.toBe(true);
    expect(events.summary()).toEqual([
      "run-start",
      "node-start:a#1",
      "run-cancel-requested",
      "node-finish:a:cancelled",
      "run-finish:cancelled",
    ]);
  });

  it("is `requested` from another executor; the live owner notices within the poll interval", async () => {
    const { clock, spawn } = world();
    const owner = spawn();
    const other = spawn();
    const a = controlled();
    const run = track(
      owner.executor.run(graph(nodes("a"), [], { a: a.handler }), null, { runId: "r1" }),
    );
    await settle();
    await expect(other.executor.cancel("r1")).resolves.toMatchObject({ outcome: "requested" });
    await clock.advance(2 * SECOND - 1);
    expect(a.aborted()).toBe(false);
    await clock.advance(1);
    expect(a.aborted()).toBe(true);
    await settle();
    expect(run.value?.status).toBe("cancelled");
  });

  it("is `cancelled` when the owner is gone: running nodes become uncertain (W7)", async () => {
    const { clock, shared, spawn } = world();
    const owner = spawn();
    const a = controlled();
    void owner.executor.run(
      graph(nodes("a", "b"), [{ from: "a", to: "b" }], { a: a.handler, b: a.handler }),
      null,
      {
        runId: "r1",
      },
    );
    await settle();
    owner.store.crash();

    const other = spawn();
    // While the dead owner's lease is still valid, only a request can be recorded.
    await expect(other.executor.cancel("r1")).resolves.toMatchObject({ outcome: "requested" });
    await clock.advance(31 * SECOND);
    await expect(other.executor.cancel("r1")).resolves.toEqual({
      runId: "r1",
      outcome: "cancelled",
      status: "cancelled",
    });
    const record = await shared.load("r1");
    expect(record?.status).toBe("cancelled");
    expect(record?.nodes).toMatchObject({
      a: { status: "uncertain", uncertainReason: "process-lost" },
      b: { status: "pending" },
    });
    // Released after W7.
    await expect(shared.acquireLease("r1", "x", 30_000)).resolves.toBeDefined();
  });

  it("is `cancelled` for a parked run, keeping its uncertain nodes", async () => {
    const { clock, shared, spawn } = world();
    const { executor } = spawn();
    const a = controlled({ cooperative: false });
    const parked = track(
      executor.run(
        graph(nodes({ id: "a", handler: "a", timeoutMs: SECOND }), [], { a: a.handler }),
        null,
        {
          runId: "r1",
        },
      ),
    );
    await clock.advance(11 * SECOND);
    expect(parked.value?.status).toBe("needs-recovery");
    await expect(executor.cancel("r1")).resolves.toMatchObject({ outcome: "cancelled" });
    const record = await shared.load("r1");
    expect(record?.status).toBe("cancelled");
    expect(record?.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "abandoned-timeout",
    });
  });
});

describe("cancellation grace", () => {
  it("abandons a handler that ignores the abort after cancelGraceMs", async () => {
    const { clock, shared, spawn } = world();
    const { store, executor } = spawn();
    const a = controlled({ cooperative: false });
    const run = track(executor.run(graph(nodes("a"), [], { a: a.handler }), null, { runId: "r1" }));
    await settle();
    await executor.cancel("r1");
    await clock.advance(10 * SECOND - 1);
    expect(run.settled).toBe(false);
    await clock.advance(1);
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "abandoned-cancel",
    });
    // The abandoned promise settles later; nothing is written.
    const writes = store.writes.length;
    a.finish("late");
    await settle();
    expect(store.writes.length).toBe(writes);
    await expect(shared.load("r1")).resolves.toEqual(run.value);
  });

  it("abandons a sibling that ignores the abort when another node fails", async () => {
    const { clock, spawn } = world();
    const { executor } = spawn({ cancelGraceMs: 3 * SECOND });
    const a = controlled();
    const b = controlled({ cooperative: false });
    const run = track(
      executor.run(graph(nodes("a", "b"), [], { a: a.handler, b: b.handler }), null),
    );
    await settle();
    a.fail(new Error("broken"));
    await settle();
    expect(b.aborted()).toBe(true);
    await clock.advance(3 * SECOND);
    expect(run.value?.status).toBe("failed");
    expect(run.value?.nodes).toMatchObject({
      a: { status: "failed" },
      b: { status: "uncertain", uncertainReason: "abandoned-failure" },
    });
  });
});

describe("GraphRunOptions.signal", () => {
  it("cancels the run like cancel() and records the request durably", async () => {
    const { shared, spawn } = world();
    const { executor } = spawn();
    const a = controlled();
    const controller = new AbortController();
    const run = track(
      executor.run(graph(nodes("a"), [], { a: a.handler }), null, {
        runId: "r1",
        signal: controller.signal,
      }),
    );
    await settle();
    controller.abort();
    await settle();
    expect(run.value?.status).toBe("cancelled");
    await expect(shared.isCancelRequested("r1")).resolves.toBe(true);
  });

  it("starts nothing when the signal is already aborted", async () => {
    const { spawn } = world();
    const { executor } = spawn();
    const a = controlled();
    const run = await executor.run(graph(nodes("a"), [], { a: a.handler }), null, {
      signal: AbortSignal.abort(),
    });
    expect(a.calls()).toBe(0);
    expect(run.status).toBe("cancelled");
    expect(run.nodes.a?.status).toBe("pending");
  });
});

describe("cancel requests between attempts", () => {
  it("are read before every attempt start, not only by the poll", async () => {
    const { shared, spawn } = world();
    const { executor } = spawn();
    let bCalls = 0;
    const run = await executor.run(
      graph(nodes("a", "b"), [{ from: "a", to: "b" }], {
        a: async () => {
          await shared.requestCancel("r1");
          return "a";
        },
        b: async () => {
          bCalls++;
          return "b";
        },
      }),
      null,
      { runId: "r1" },
    );
    expect(bCalls).toBe(0);
    expect(run.status).toBe("cancelled");
    expect(run.nodes).toMatchObject({ a: { status: "completed" }, b: { status: "pending" } });
  });

  /** Holds the first W1 of node `a` open until `open()` is called. */
  const holdW1 = (store: ProcessStore) => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = false;
    store.beforeWrite = async (run) => {
      if (held || run.nodes.a?.status !== "running") return;
      held = true;
      await gate;
    };
    return { open, held: () => held };
  };

  // Persisted state when the cancel wins at this boundary: W1 stays written
  // (the attempt counts), then W4 records the node `cancelled`, not
  // `uncertain`, because its handler never ran; the run ends `cancelled`.
  // No node-start is reported.
  it("win when received while W1 is being written: the handler never starts", async () => {
    const { shared, spawn } = world();
    const { store, executor } = spawn();
    const w1 = holdW1(store);
    const a = controlled();
    const events = recorder();
    const run = track(
      executor.run(graph(nodes("a"), [], { a: a.handler }), null, {
        runId: "r1",
        observer: events.observer,
      }),
    );
    await settle();
    expect(w1.held()).toBe(true);
    await expect(executor.cancel("r1")).resolves.toMatchObject({ outcome: "requested" });
    w1.open();
    await settle();

    expect(a.calls()).toBe(0);
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.a).toMatchObject({ status: "cancelled", attempt: 1 });
    expect(run.value?.nodes.a?.uncertainReason).toBeUndefined();
    await expect(shared.load("r1")).resolves.toEqual(run.value);
    expect(store.writes.map((write) => [write.status, write.nodes.a?.status])).toEqual([
      ["running", "pending"], // W0
      ["running", "running"], // W1
      ["running", "cancelled"], // W4
      ["cancelled", "cancelled"], // W5
    ]);
    expect(events.summary()).toEqual([
      "run-start",
      "run-cancel-requested",
      "node-finish:a:cancelled",
      "run-finish:cancelled",
    ]);
  });

  it("win the same way when recorded by another executor during W1, without waiting for the poll", async () => {
    const { spawn } = world();
    const owner = spawn();
    const other = spawn();
    const w1 = holdW1(owner.store);
    const a = controlled();
    const run = track(
      owner.executor.run(graph(nodes("a"), [], { a: a.handler }), null, { runId: "r1" }),
    );
    await settle();
    await expect(other.executor.cancel("r1")).resolves.toMatchObject({ outcome: "requested" });
    w1.open();
    await settle(); // no clock advance: the poll never ran

    expect(a.calls()).toBe(0);
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.a).toMatchObject({ status: "cancelled", attempt: 1 });
  });

  it("win the same way when the run's signal aborts during W1", async () => {
    const { spawn } = world();
    const { store, executor } = spawn();
    const w1 = holdW1(store);
    const a = controlled();
    const controller = new AbortController();
    const run = track(
      executor.run(graph(nodes("a"), [], { a: a.handler }), null, {
        runId: "r1",
        signal: controller.signal,
      }),
    );
    await settle();
    controller.abort();
    w1.open();
    await settle();

    expect(a.calls()).toBe(0);
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.a?.status).toBe("cancelled");
  });
});

describe("cancel versus failure (I9)", () => {
  const setup = () => {
    const w = world();
    const process = w.spawn();
    const a = controlled();
    const b = controlled();
    const run = track(
      process.executor.run(graph(nodes("a", "b"), [], { a: a.handler, b: b.handler }), null, {
        runId: "r1",
      }),
    );
    return { ...w, ...process, a, b, run };
  };

  it("a failure first: the run fails and the later cancel changes nothing", async () => {
    const { store, executor, a, run } = setup();
    await settle();
    a.fail(new GraphNodeError("boom", { code: "boom" }));
    const ack = executor.cancel("r1");
    await settle();
    expect(run.value?.status).toBe("failed");
    expect(run.value?.nodes).toMatchObject({ a: { status: "failed" }, b: { status: "cancelled" } });
    expect(store.terminalWrites()).toHaveLength(1);
    await expect(ack).resolves.toMatchObject({
      outcome: expect.stringMatching(/requested|already-terminal/),
    });
  });

  it("a cancel first: errors caused by the abort are recorded as cancelled", async () => {
    const { store, executor, a, run } = setup();
    await settle();
    await executor.cancel("r1");
    a.fail(new GraphNodeError("boom", { code: "boom" }));
    await settle();
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes).toMatchObject({
      a: { status: "cancelled" },
      b: { status: "cancelled" },
    });
    expect(store.terminalWrites()).toHaveLength(1);
  });
});
