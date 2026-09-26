/**
 * Crash simulations (plan P4). Each simulated process gets its own executor
 * and a `ProcessStore` view of one shared store. Crashing a process makes every
 * store call it makes from then on hang forever: its timers stop re-arming and
 * it writes nothing more, as if the process had died.
 */
import { describe, expect, it } from "vitest";
import {
  DefinitionMismatchError,
  type JsonValue,
  LeaseUnavailableError,
  MemoryCheckpointStore,
  type NodeContext,
  type NodeHandler,
  type NodeSpec,
  RecoveryNotApplicableError,
  RunNotFoundError,
  RunNotResumableError,
  type WorkflowDefinition,
  WorkflowExecutor,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import { ProcessStore } from "./support/graph.js";

const never = <T>() => new Promise<T>(() => {});

/** Handlers for a → b → c that count calls and record their contexts. */
function counted(overrides: Record<string, NodeHandler> = {}) {
  const calls: { a: NodeContext[]; b: NodeContext[]; c: NodeContext[] } = { a: [], b: [], c: [] };
  const handlers: Record<string, NodeHandler> = {};
  for (const id of ["a", "b", "c"]) {
    handlers[id] = async (context) => {
      calls[id as keyof typeof calls].push(context);
      return (await overrides[id]?.(context)) ?? id;
    };
  }
  return { calls, handlers };
}

function chain(
  handlers: Record<string, NodeHandler>,
  options: { version?: string; a?: Partial<NodeSpec>; extraEdge?: boolean } = {},
): WorkflowDefinition {
  return {
    graph: {
      id: "wf",
      version: options.version ?? "1",
      entry: ["a"],
      nodes: [
        { id: "a", handler: "a", ...options.a },
        { id: "b", handler: "b" },
        { id: "c", handler: "c" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        ...(options.extraEdge ? [{ from: "a", to: "c" }] : []),
      ],
    },
    handlers,
    predicates: {},
  };
}

function world() {
  const clock = new FakeClock(1_000);
  const shared = new MemoryCheckpointStore({ now: clock.now });
  const processes: { store: ProcessStore; executor: WorkflowExecutor }[] = [];
  const spawn = () => {
    const store = new ProcessStore(shared);
    const process = { store, executor: new WorkflowExecutor({ store }, clock) };
    processes.push(process);
    return process;
  };
  return { clock, shared, spawn };
}

/** Starts run "r1" in a first process and lets it crash where `setup` arranges. */
async function crashed(
  definition: (handlers: Record<string, NodeHandler>) => WorkflowDefinition,
  arrange: (store: ProcessStore) => Record<string, NodeHandler>,
) {
  const w = world();
  const first = w.spawn();
  const { calls, handlers } = counted(arrange(first.store));
  void first.executor.run(definition(handlers), "input", { runId: "r1" });
  await settle();
  expect(first.store.crashed).toBe(true);
  // The dead owner's lease lapses; then a new process can take over.
  await w.clock.advance(30_000);
  return { ...w, calls, handlers, definition: definition(handlers) };
}

const effectThenCrash = (effects: { count: number }) => (store: ProcessStore) => ({
  a: async () => {
    effects.count += 1; // the side effect happens...
    store.crash(); // ...and the process dies before W2
    return "a";
  },
});

describe("crash simulations", () => {
  it("after W1, before the handler: the node is uncertain and nothing starts", async () => {
    const { spawn, calls, definition, shared } = await crashed(
      (handlers) => chain(handlers),
      (store) => {
        store.crashAfterWrite = (run) => run.nodes.a?.status === "running";
        return {};
      },
    );
    expect(calls.a).toHaveLength(0);

    const run = await spawn().executor.resume(definition, "r1");
    expect(run.status).toBe("needs-recovery");
    expect(run.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "process-lost",
      attempt: 1,
    });
    expect(run.nodes.b?.status).toBe("pending");
    expect(calls).toEqual({ a: [], b: [], c: [] });
    await expect(shared.load("r1")).resolves.toEqual(run);
    // The lease was released on parking.
    await expect(shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
  });

  it("after a side effect, before W2: uncertain; recover by completing, then resume", async () => {
    const effects = { count: 0 };
    const { spawn, calls, definition } = await crashed(
      (handlers) => chain(handlers),
      effectThenCrash(effects),
    );

    const second = spawn().executor;
    const parked = await second.resume(definition, "r1");
    expect(parked.status).toBe("needs-recovery");
    expect(parked.nodes.a?.status).toBe("uncertain");
    // Resuming again changes nothing and starts nothing.
    await expect(second.resume(definition, "r1")).resolves.toMatchObject({
      status: "needs-recovery",
      revision: parked.revision,
    });

    // The operator checked that the effect happened and records its output.
    const recovered = await second.recoverNode(definition, "r1", "a", {
      type: "complete",
      output: "a (checked)",
    });
    expect(recovered.status).toBe("running");
    expect(recovered.revision).toBe(parked.revision + 1);
    expect(recovered.nodes.a).toMatchObject({
      status: "completed",
      output: "a (checked)",
      recoveries: [{ action: "complete" }],
    });
    expect(recovered.nodes.a).not.toHaveProperty("uncertainReason");
    expect(recovered.edges).toEqual({ "a->b": true });

    const done = await second.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(calls.a).toHaveLength(1);
    expect(effects.count).toBe(1);
    expect(calls.b[0]?.predecessors).toEqual({ a: "a (checked)" });
  });

  it("after W2, before successors: the completed node never re-runs", async () => {
    const { spawn, calls, definition } = await crashed(
      (handlers) => chain(handlers),
      (store) => {
        store.crashAfterWrite = (run) => run.nodes.a?.status === "completed";
        return {};
      },
    );
    const run = await spawn().executor.resume(definition, "r1");
    expect(run.status).toBe("completed");
    expect(calls.a).toHaveLength(1);
    expect(calls.b).toHaveLength(1);
    expect(calls.c).toHaveLength(1);
    expect(run.nodes.a?.attempt).toBe(1);
  });

  it("after a failure write, before the terminal write: the run fails without new starts", async () => {
    const { spawn, calls, definition } = await crashed(
      (handlers) => chain(handlers),
      (store) => {
        store.crashAfterWrite = (run) => run.nodes.a?.status === "failed";
        return {
          a: async () => {
            throw new Error("boom");
          },
        };
      },
    );
    const run = await spawn().executor.resume(definition, "r1");
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ nodeId: "a", message: "boom" });
    expect(calls.b).toHaveLength(0);
  });

  it("refuses a takeover while the crashed owner's lease is still valid", async () => {
    const w = world();
    const first = w.spawn();
    first.store.crashAfterWrite = (run) => run.nodes.a?.status === "running";
    const { handlers } = counted();
    void first.executor.run(chain(handlers), null, { runId: "r1" });
    await settle();

    await w.clock.advance(29_999);
    const error = await w
      .spawn()
      .executor.resume(chain(handlers), "r1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeaseUnavailableError);
    expect((error as LeaseUnavailableError).leaseTtlMs).toBe(30_000);
    await w.clock.advance(1);
    await expect(w.spawn().executor.resume(chain(handlers), "r1")).resolves.toMatchObject({
      status: "needs-recovery",
    });
  });
});

/** Run "r1" parked with `a` uncertain after a crash, seen from a fresh process. */
const parked = async () => {
  const effects = { count: 0 };
  const w = await crashed((handlers) => chain(handlers), effectThenCrash(effects));
  const { store, executor } = w.spawn();
  await executor.resume(w.definition, "r1");
  return { ...w, store, executor, effects };
};

describe("recoverNode", () => {
  it("retry: runs the node again with the same idempotency key, beyond its budget", async () => {
    const { executor, definition, calls } = await parked();
    const retried = await executor.recoverNode(definition, "r1", "a", { type: "retry" });
    expect(retried.status).toBe("running");
    expect(retried.nodes.a).toMatchObject({
      status: "pending",
      attempt: 1,
      recoveries: [{ action: "retry" }],
    });
    expect(calls.a).toHaveLength(1); // recoverNode itself starts nothing

    const done = await executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(done.nodes.a?.attempt).toBe(2);
    expect(calls.a.map((context) => [context.attempt, context.idempotencyKey])).toEqual([
      [1, "r1:a"],
      [2, "r1:a"],
    ]);
  });

  it("fail: the node and the run fail, and the run is no longer resumable", async () => {
    const { executor, definition, calls } = await parked();
    const failed = await executor.recoverNode(definition, "r1", "a", {
      type: "fail",
      message: "charged twice; refunded by hand",
    });
    expect(failed.status).toBe("failed");
    expect(failed.nodes.a).toMatchObject({
      status: "failed",
      error: { code: "recovery-failed", message: "charged twice; refunded by hand" },
    });
    expect(failed.error).toMatchObject({ code: "recovery-failed", nodeId: "a" });
    await expect(executor.resume(definition, "r1")).rejects.toBeInstanceOf(RunNotResumableError);
    expect(calls.b).toHaveLength(0);
  });

  it("rejects actions that do not apply, writing nothing and releasing the lease", async () => {
    const { executor, definition, shared } = await parked();
    const before = await shared.load("r1");
    for (const [nodeId, action] of [
      ["b", { type: "retry" }], // pending, not uncertain
      ["zzz", { type: "retry" }], // no such node
      ["a", { type: "complete", output: { big: "x".repeat(300_000) } }],
      ["a", { type: "complete", output: undefined as unknown as JsonValue }],
    ] as const) {
      await expect(executor.recoverNode(definition, "r1", nodeId, action)).rejects.toBeInstanceOf(
        RecoveryNotApplicableError,
      );
    }
    await expect(shared.load("r1")).resolves.toEqual(before);
    await expect(shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
  });

  it("requires a needs-recovery run", async () => {
    const w = world();
    const { handlers } = counted();
    const executor = w.spawn().executor;
    await executor.run(chain(handlers), null, { runId: "done" });
    await expect(
      executor.recoverNode(chain(handlers), "done", "a", { type: "retry" }),
    ).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it("keeps the run parked while other nodes are still uncertain", async () => {
    const w = world();
    const first = w.spawn();
    const handlers: Record<string, NodeHandler> = {
      a: () => never(),
      b: () => never(),
      c: async () => "c",
    };
    const definition: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["a", "b"],
        nodes: [
          { id: "a", handler: "a" },
          { id: "b", handler: "b" },
          { id: "c", handler: "c" },
        ],
        edges: [
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
      },
      handlers,
      predicates: {},
    };
    void first.executor.run(definition, null, { runId: "r1" });
    await settle();
    first.store.crash();
    await w.clock.advance(30_000);

    const second = w.spawn().executor;
    await expect(second.resume(definition, "r1")).resolves.toMatchObject({
      status: "needs-recovery",
      nodes: { a: { status: "uncertain" }, b: { status: "uncertain" } },
    });
    const one = await second.recoverNode(definition, "r1", "a", { type: "complete", output: 1 });
    expect(one.status).toBe("needs-recovery");
    const both = await second.recoverNode(definition, "r1", "b", { type: "complete", output: 2 });
    expect(both.status).toBe("running");
    const done = await second.resume(
      { ...definition, handlers: { ...handlers, c: async (ctx) => ctx.predecessors } },
      "r1",
    );
    expect(done.nodes.c?.output).toEqual({ a: 1, b: 2 });
  });
});

describe("recoverNode lease cleanup", () => {
  for (const operation of ["isCancelRequested", "compareAndSwap"] as const) {
    it(`releases the lease when ${operation} fails, so the next call need not wait for expiry`, async () => {
      const { executor, store, definition, shared } = await parked();
      store.failures.set(operation, new Error("store down"));
      await expect(executor.recoverNode(definition, "r1", "a", { type: "retry" })).rejects.toThrow(
        "store down",
      );
      expect(store.failures.size).toBe(0);
      expect((await shared.load("r1"))?.status).toBe("needs-recovery");
      // No clock advance: before the fix the lease stayed held for its TTL.
      const retried = await executor.recoverNode(definition, "r1", "a", { type: "retry" });
      expect(retried.nodes.a?.status).toBe("pending");
      await expect(shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
    });
  }

  it("releases the lease when the output's predicate throws", async () => {
    const w = world();
    const first = w.spawn();
    const definition = (a: NodeHandler): WorkflowDefinition => ({
      graph: {
        id: "wf",
        version: "1",
        entry: ["a"],
        nodes: [
          { id: "a", handler: "a" },
          { id: "b", handler: "b" },
        ],
        edges: [{ from: "a", to: "b", when: "go" }],
      },
      handlers: { a, b: async () => "b" },
      predicates: {
        go: () => {
          throw new Error("predicate broke");
        },
      },
    });
    void first.executor.run(
      definition(async () => {
        first.store.crash();
        return "a";
      }),
      null,
      { runId: "r1" },
    );
    await settle();
    await w.clock.advance(30_000);
    const { executor } = w.spawn();
    const def = definition(async () => "a");
    await executor.resume(def, "r1");
    await expect(
      executor.recoverNode(def, "r1", "a", { type: "complete", output: "a" }),
    ).rejects.toThrow(/predicate broke/);
    await expect(w.shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
  });

  it("never lets a release error mask the original one", async () => {
    const { executor, store, definition } = await parked();
    store.failures.set("compareAndSwap", new Error("write failed"));
    store.failures.set("releaseLease", new Error("release failed"));
    await expect(executor.recoverNode(definition, "r1", "a", { type: "retry" })).rejects.toThrow(
      "write failed",
    );
    expect(store.failures.size).toBe(0); // the release was attempted
  });
});

describe("invalid output after a side effect", () => {
  const ref = {
    $artifact: { uri: "s3://bucket/r1/a", sha256: "ab".repeat(32), bytes: 300_000 },
  };

  it("parks the node as uncertain instead of failing the run; completing it with an ArtifactRef continues", async () => {
    const w = world();
    const effects = { count: 0 };
    const { calls, handlers } = counted({
      a: async () => {
        effects.count += 1; // e.g. uploaded, charged, sent…
        return "x".repeat(300_000); // …then returned the whole result inline
      },
    });
    // Automatic retry is allowed for crashes, but never for a rejected output.
    const definition = chain(handlers, {
      a: { recovery: "retry", retry: { maxAttempts: 3, initialDelayMs: 0 } },
    });
    const { executor } = w.spawn();

    const parked = await executor.run(definition, "input", { runId: "r1" });
    expect(parked.status).toBe("needs-recovery");
    expect(parked.error).toBeUndefined();
    expect(parked.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "invalid-output",
      attempt: 1,
      error: { code: "output-too-large", retryable: false },
    });
    expect(parked.nodes.a?.output).toBeUndefined();
    expect(calls.b).toHaveLength(0);

    // resume() does not re-run it either.
    expect((await executor.resume(definition, "r1")).status).toBe("needs-recovery");
    expect(effects.count).toBe(1);

    // After checking the effect and storing the result, the operator supplies a reference.
    const recovered = await executor.recoverNode(definition, "r1", "a", {
      type: "complete",
      output: ref,
    });
    expect(recovered.status).toBe("running");
    expect(recovered.nodes.a).toMatchObject({ status: "completed", output: ref });
    expect(recovered.nodes.a?.error).toBeUndefined();
    expect(recovered.nodes.a?.uncertainReason).toBeUndefined();

    const done = await executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(effects.count).toBe(1);
    expect(calls.a).toHaveLength(1);
    expect(calls.b[0]?.predecessors).toEqual({ a: ref });
  });

  it("parks non-JSON output the same way; an explicit retry re-runs it", async () => {
    const w = world();
    let attempt = 0;
    const { calls, handlers } = counted({
      a: async () => (++attempt === 1 ? ({ at: new Date() } as unknown as JsonValue) : "fixed"),
    });
    const definition = chain(handlers);
    const { executor } = w.spawn();
    const parked = await executor.run(definition, null, { runId: "r1" });
    expect(parked.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "invalid-output",
      error: { code: "output-not-json" },
    });
    await executor.recoverNode(definition, "r1", "a", { type: "retry" });
    const done = await executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(done.nodes.a).toMatchObject({ output: "fixed", attempt: 2 });
    expect(done.nodes.a?.error).toBeUndefined();
    expect(calls.a.map((context) => context.idempotencyKey)).toEqual(["r1:a", "r1:a"]);
  });

  it("rejects a recovery output that is still too large", async () => {
    const w = world();
    const { handlers } = counted({ a: async () => "x".repeat(300_000) });
    const definition = chain(handlers);
    const { executor } = w.spawn();
    await executor.run(definition, null, { runId: "r1" });
    await expect(
      executor.recoverNode(definition, "r1", "a", {
        type: "complete",
        output: "y".repeat(300_000),
      }),
    ).rejects.toBeInstanceOf(RecoveryNotApplicableError);
  });
});

describe('recovery: "retry"', () => {
  it("retries an orphaned attempt automatically while attempts remain", async () => {
    const effects = { count: 0 };
    let first = true;
    const { spawn, calls, definition } = await crashed(
      (handlers) =>
        chain(handlers, { a: { recovery: "retry", retry: { maxAttempts: 2, initialDelayMs: 0 } } }),
      (store) => ({
        a: async () => {
          effects.count += 1;
          if (first) {
            first = false;
            store.crash();
          }
          return "a";
        },
      }),
    );
    const run = await spawn().executor.resume(definition, "r1");
    expect(run.status).toBe("completed");
    expect(run.nodes.a?.attempt).toBe(2);
    expect(effects.count).toBe(2); // I11: the effect may repeat; the key is stable
    expect(calls.a.map((context) => context.idempotencyKey)).toEqual(["r1:a", "r1:a"]);
  });

  it("becomes uncertain once the budget is used up", async () => {
    const { spawn, definition } = await crashed(
      (handlers) => chain(handlers, { a: { recovery: "retry" } }), // maxAttempts 1
      effectThenCrash({ count: 0 }),
    );
    await expect(spawn().executor.resume(definition, "r1")).resolves.toMatchObject({
      status: "needs-recovery",
      nodes: { a: { status: "uncertain", uncertainReason: "process-lost" } },
    });
  });
});

describe("cancel requests found on takeover", () => {
  it("resume() finalizes the run as cancelled; orphans become uncertain (W7)", async () => {
    const { spawn, shared, calls, definition } = await crashed(
      (handlers) => chain(handlers),
      effectThenCrash({ count: 0 }),
    );
    await shared.requestCancel("r1");
    const run = await spawn().executor.resume(definition, "r1");
    expect(run.status).toBe("cancelled");
    expect(run.nodes.a).toMatchObject({ status: "uncertain", uncertainReason: "process-lost" });
    expect(calls.b).toHaveLength(0);
    await expect(shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
  });

  it("recoverNode() cancels a parked run instead of applying the action", async () => {
    const { spawn, shared, calls, definition } = await crashed(
      (handlers) => chain(handlers),
      effectThenCrash({ count: 0 }),
    );
    const executor = spawn().executor;
    await executor.resume(definition, "r1");
    await shared.requestCancel("r1");
    const run = await executor.recoverNode(definition, "r1", "a", { type: "retry" });
    expect(run.status).toBe("cancelled");
    expect(run.nodes.a?.status).toBe("uncertain");
    expect(calls.a).toHaveLength(1);
  });
});

describe("takeover checks", () => {
  it("rejects missing and terminal runs", async () => {
    const w = world();
    const { handlers } = counted();
    const executor = w.spawn().executor;
    await expect(executor.resume(chain(handlers), "missing")).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
    await executor.run(chain(handlers), null, { runId: "done" });
    await expect(executor.resume(chain(handlers), "done")).rejects.toBeInstanceOf(
      RunNotResumableError,
    );
  });

  it("rejects a definition whose version or structure changed", async () => {
    const { spawn, handlers, shared } = await crashed(
      (h) => chain(h),
      effectThenCrash({ count: 0 }),
    );
    const executor = spawn().executor;
    const version = await executor
      .resume(chain(handlers, { version: "2" }), "r1")
      .catch((e: unknown) => e);
    expect(version).toBeInstanceOf(DefinitionMismatchError);
    expect(version).toMatchObject({ field: "definitionVersion", expected: "1", actual: "2" });
    await expect(executor.resume(chain(handlers, { extraEdge: true }), "r1")).rejects.toMatchObject(
      { field: "definitionHash" },
    );
    await expect(
      executor.recoverNode(chain(handlers, { version: "2" }), "r1", "a", { type: "retry" }),
    ).rejects.toBeInstanceOf(DefinitionMismatchError);
    // Nothing was written or left locked.
    await expect(shared.load("r1")).resolves.toMatchObject({ status: "running", revision: 1 });
    await expect(shared.acquireLease("r1", "someone", 30_000)).resolves.toBeDefined();
  });
});
