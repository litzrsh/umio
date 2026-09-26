/**
 * Crash simulations (plan P4). Each simulated process gets its own executor
 * and a `ProcessStore` view of one shared store. Crashing a process makes every
 * store call it makes from then on hang forever: its timers stop re-arming and
 * it writes nothing more, as if the process had died.
 */
import { describe, expect, it } from "vitest";
import {
  type CasResult,
  type CheckpointStore,
  DefinitionMismatchError,
  type JsonValue,
  type Lease,
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
  type WorkflowRun,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";

const never = <T>() => new Promise<T>(() => {});

class ProcessStore implements CheckpointStore {
  crashed = false;
  /** Crash right after a successful write that matches. */
  crashAfterWrite?: (run: WorkflowRun) => boolean;

  constructor(private readonly inner: CheckpointStore) {}

  crash() {
    this.crashed = true;
  }

  private call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.crashed) return never();
    return operation().then((value) => (this.crashed ? never<T>() : value));
  }

  create(run: WorkflowRun, ownerId: string, ttlMs: number) {
    return this.call(() => this.inner.create(run, ownerId, ttlMs));
  }
  load(runId: string) {
    return this.call(() => this.inner.load(runId));
  }
  compareAndSwap(run: WorkflowRun, expected: number, lease: Lease) {
    return this.call(async (): Promise<CasResult> => {
      const result = await this.inner.compareAndSwap(run, expected, lease);
      if (result === "ok" && this.crashAfterWrite?.(run)) this.crash();
      return result;
    });
  }
  acquireLease(runId: string, ownerId: string, ttlMs: number) {
    return this.call(() => this.inner.acquireLease(runId, ownerId, ttlMs));
  }
  renewLease(lease: Lease, ttlMs: number) {
    return this.call(() => this.inner.renewLease(lease, ttlMs));
  }
  releaseLease(lease: Lease) {
    return this.call(() => this.inner.releaseLease(lease));
  }
  requestCancel(runId: string) {
    return this.call(() => this.inner.requestCancel(runId));
  }
  isCancelRequested(runId: string) {
    return this.call(() => this.inner.isCancelRequested(runId));
  }
  delete(runId: string) {
    return this.call(() => this.inner.delete(runId));
  }
}

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

describe("recoverNode", () => {
  const parked = async () => {
    const effects = { count: 0 };
    const w = await crashed((handlers) => chain(handlers), effectThenCrash(effects));
    const executor = w.spawn().executor;
    await executor.resume(w.definition, "r1");
    return { ...w, executor, effects };
  };

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
