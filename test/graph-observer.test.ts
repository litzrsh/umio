import { describe, expect, it } from "vitest";
import {
  GraphNodeError,
  type GraphRunEvent,
  MemoryCheckpointStore,
  WorkflowExecutor,
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

function setup(options: { observerDrainTimeoutMs?: number } = {}) {
  const clock = new FakeClock(0);
  const store = new ProcessStore(new MemoryCheckpointStore({ now: clock.now }));
  const executor = new WorkflowExecutor({ store, ...options }, clock);
  return { clock, store, executor };
}

/** research → (design ‖ security?) → merge (join any), with a flaky design node. */
function review() {
  let designCalls = 0;
  return graph(
    nodes(
      "research",
      { id: "design", handler: "design", retry: { maxAttempts: 2, initialDelayMs: 0 } },
      "security",
      { id: "merge", handler: "merge", join: "any" },
    ),
    [
      { from: "research", to: "design" },
      { from: "research", to: "security", when: "risky" },
      { from: "design", to: "merge" },
      { from: "security", to: "merge" },
    ],
    {
      research: async (context) => {
        context.emit({ type: "custom", name: "progress", data: 50 });
        return { risk: false };
      },
      design: async () => {
        if (++designCalls === 1) throw new GraphNodeError("flaky", { code: "x", retryable: true });
        return "design";
      },
      security: async () => "security",
      merge: async () => "merged",
    },
    { risky: (output) => (output as { risk: boolean }).risk },
  );
}

describe("run events", () => {
  it("are delivered in a pinned order", async () => {
    const { executor } = setup();
    const events = recorder();
    const run = await executor.run(review(), "go", { runId: "r1", observer: events.observer });
    expect(run.status).toBe("completed");
    expect(events.summary()).toEqual([
      "run-start",
      "node-start:research#1",
      "node-event:research#1",
      "node-finish:research:completed",
      "node-finish:security:skipped",
      "node-start:design#1",
      "node-retry:design#1",
      "node-start:design#2",
      "node-finish:design:completed",
      "node-start:merge#1",
      "node-finish:merge:completed",
      "run-finish:completed",
    ]);
    expect(events.events[0]).toEqual({ type: "run-start", runId: "r1", at: 0 });
    expect(
      events.events.find((event) => event.type === "node-finish" && event.nodeId === "security"),
    ).toMatchObject({
      attempt: 0,
    });
    expect(events.events[2]).toMatchObject({
      type: "node-event",
      event: { type: "custom", name: "progress", data: 50 },
    });
  });

  it("report a failed run and the node that failed", async () => {
    const { executor } = setup();
    const events = recorder();
    await executor.run(
      graph(nodes("a"), [], {
        a: async () => {
          throw new Error("no");
        },
      }),
      null,
      { observer: events.observer },
    );
    expect(events.summary()).toEqual([
      "run-start",
      "node-start:a#1",
      "node-finish:a:failed",
      "run-finish:failed",
    ]);
  });
});

describe("observer isolation (D6)", () => {
  it("errors from the observer go to onObserverError and change nothing", async () => {
    const { executor } = setup();
    const errors: [unknown, GraphRunEvent["type"]][] = [];
    const run = await executor.run(review(), "go", {
      observer: {
        emit: (event) => {
          if (event.type === "node-start") throw new Error("sync");
          if (event.type === "node-finish") return Promise.reject(new Error("async"));
        },
      },
      onObserverError: (error, event) => {
        errors.push([(error as Error).message, event.type]);
        throw new Error("the error handler breaks too");
      },
    });
    expect(run.status).toBe("completed");
    expect(errors.filter(([message]) => message === "sync")).toHaveLength(4);
    expect(errors.filter(([message]) => message === "async")).toHaveLength(4);
  });

  it("a hanging observer delays neither scheduling nor the persisted status", async () => {
    const { clock, store, executor } = setup();
    const a = controlled();
    const delivered: string[] = [];
    const run = track(
      executor.run(
        graph(nodes("a", "b"), [{ from: "a", to: "b" }], { a: a.handler, b: async () => "b" }),
        null,
        {
          runId: "r1",
          observer: {
            emit: (event) => {
              delivered.push(event.type);
              return new Promise(() => {}); // never resolves
            },
          },
        },
      ),
    );
    await settle();
    expect(a.calls()).toBe(1);
    a.finish();
    await settle();
    // The whole run finished and was persisted while the first event is still "being delivered".
    expect(delivered).toEqual(["run-start"]);
    expect((await store.inner.load("r1"))?.status).toBe("completed");
    expect(run.settled).toBe(false);

    // The drain gives up after observerDrainTimeoutMs; the status stays completed.
    await clock.advance(5 * SECOND - 1);
    expect(run.settled).toBe(false);
    await clock.advance(1);
    expect(run.value?.status).toBe("completed");
    expect(delivered).toEqual(["run-start"]);
    // The lease was released before the drain began.
    await expect(store.inner.acquireLease("r1", "x", 30_000)).resolves.toBeDefined();
  });

  it("drops events still queued when the drain times out", async () => {
    const { clock, executor } = setup({ observerDrainTimeoutMs: 1_000 });
    const delivered: string[] = [];
    let release = () => {};
    const run = track(
      executor.run(graph(nodes("a"), [], { a: async () => 1 }), null, {
        observer: {
          emit: (event) => {
            delivered.push(event.type);
            if (event.type === "run-start") {
              return new Promise<void>((resolve) => {
                release = resolve;
              });
            }
          },
        },
      }),
    );
    await clock.advance(1_000);
    expect(run.value?.status).toBe("completed");
    release(); // the stuck delivery finally returns, after the run resolved
    await settle();
    expect(delivered).toEqual(["run-start"]);
  });

  it("delivers events one at a time, in order, to a slow observer", async () => {
    const { clock, executor } = setup();
    const received: string[] = [];
    let busy = false;
    const run = track(
      executor.run(graph(nodes("a", "b"), [], { a: async () => 1, b: async () => 2 }), null, {
        observer: {
          emit: async (event) => {
            expect(busy).toBe(false);
            busy = true;
            await new Promise<void>((resolve) => clock.setTimer(100, resolve));
            received.push(event.type);
            busy = false;
          },
        },
      }),
    );
    await settle();
    await clock.advance(10 * 100);
    expect(run.value?.status).toBe("completed");
    expect(received).toEqual([
      "run-start",
      "node-start",
      "node-start",
      "node-finish",
      "node-finish",
      "run-finish",
    ]);
  });

  it("drops events emitted after the run resolved", async () => {
    const { clock, executor } = setup();
    const a = controlled({ cooperative: false });
    const events = recorder();
    const run = track(
      executor.run(
        graph(nodes({ id: "a", handler: "a", timeoutMs: SECOND }), [], { a: a.handler }),
        null,
        {
          observer: events.observer,
        },
      ),
    );
    await clock.advance(11 * SECOND);
    expect(run.value?.status).toBe("needs-recovery");
    const count = events.events.length;
    a.contexts[0]?.emit({ type: "custom", name: "still going" });
    await settle();
    expect(events.events).toHaveLength(count);
  });
});
