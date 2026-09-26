/**
 * Durable pause and approval: approval nodes record a request, the run pauses
 * without an owner once nothing else can progress, decisions are recorded
 * first-wins from any "process" and applied at most once by the next owner.
 */
import { describe, expect, it } from "vitest";
import {
  type CheckpointStore,
  type GraphValidationError,
  MemoryCheckpointStore,
  type NodeHandler,
  type NodeSpec,
  UmioError,
  validateDefinition,
  type WorkflowDefinition,
  WorkflowExecutor,
  type WorkflowExecutorOptions,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import { controlled, ProcessStore, recorder, SECOND, track } from "./support/graph.js";

function world() {
  const clock = new FakeClock(0);
  const shared = new MemoryCheckpointStore({ now: clock.now });
  const spawn = (options: WorkflowExecutorOptions = {}) => {
    const store = new ProcessStore(shared);
    return { store, executor: new WorkflowExecutor({ store, ...options }, clock) };
  };
  return { clock, shared, spawn };
}

/** plan → approve → deploy, counting handler calls. */
function release(options: { approval?: Partial<NodeSpec["approval"]>; extra?: boolean } = {}) {
  const calls = { plan: 0, deploy: 0, fix: 0 };
  const handlers: Record<string, NodeHandler> = {
    plan: async () => {
      calls.plan += 1;
      return { steps: ["migrate", "restart"] };
    },
    deploy: async (context) => {
      calls.deploy += 1;
      return { deployed: context.predecessors.approve ?? null };
    },
    fix: async () => {
      calls.fix += 1;
      return "fixed";
    },
  };
  const continueOnReject = options.approval?.onReject === "continue";
  const definition: WorkflowDefinition = {
    graph: {
      id: "release",
      version: "1",
      entry: ["plan"],
      nodes: [
        { id: "plan", handler: "plan" },
        {
          id: "approve",
          approval: {
            title: "Deploy to production?",
            description: "Runs the migration, then restarts.",
            ...options.approval,
          },
        },
        { id: "deploy", handler: "deploy" },
        ...(continueOnReject ? [{ id: "fix", handler: "fix" }] : []),
      ],
      edges: [
        { from: "plan", to: "approve" },
        continueOnReject
          ? { from: "approve", to: "deploy", when: "approved" }
          : { from: "approve", to: "deploy" },
        ...(continueOnReject ? [{ from: "approve", to: "fix", when: "rejected" }] : []),
      ],
    },
    handlers,
    predicates: {
      approved: (output) => (output as { approved: boolean }).approved,
      rejected: (output) => !(output as { approved: boolean }).approved,
    },
  };
  return { calls, definition };
}

describe("approval nodes", () => {
  it("pause the run durably with the request and its context, releasing the lease", async () => {
    const { shared, spawn } = world();
    const { executor } = spawn();
    const { calls, definition } = release();
    const events = recorder();
    const paused = await executor.run(
      definition,
      { ticket: 7 },
      {
        runId: "r1",
        observer: events.observer,
      },
    );
    expect(paused.status).toBe("paused");
    expect(paused.schemaVersion).toBe(2);
    expect(paused.nodes.approve).toMatchObject({
      status: "waiting",
      approval: {
        requestId: expect.any(String),
        title: "Deploy to production?",
        description: "Runs the migration, then restarts.",
        context: ["plan"],
        onReject: "fail",
      },
    });
    expect(paused.nodes.deploy?.status).toBe("pending");
    expect(calls).toMatchObject({ plan: 1, deploy: 0 });
    // No owner: anyone can take the lease at once.
    const lease = await shared.acquireLease("r1", "someone", 1_000);
    expect(lease).toBeDefined();
    if (lease) await shared.releaseLease(lease);
    await expect(shared.load("r1")).resolves.toEqual(paused);
    expect(events.summary()).toEqual([
      "run-start",
      "node-start:plan#1",
      "node-finish:plan:completed",
      "node-waiting",
      "run-paused",
    ]);

    const [pending] = await executor.pendingApprovals("r1");
    expect(pending).toEqual({
      runId: "r1",
      workflowId: "release",
      runStatus: "paused",
      nodeId: "approve",
      request: paused.nodes.approve?.approval,
      input: { ticket: 7 },
      context: { plan: { steps: ["migrate", "restart"] } },
    });
  });

  it("continue after an approval from another process, on resume, without repeating completed nodes", async () => {
    const { shared, spawn } = world();
    const { calls, definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });

    // A second "process" approves; nothing is applied to the run yet.
    const approver = spawn().executor;
    const ack = await approver.approve("r1", "approve", { decidedBy: "ana", comment: "ship it" });
    expect(ack).toMatchObject({
      outcome: "recorded",
      status: "paused",
      decision: { nodeId: "approve", approved: true, decidedBy: "ana", comment: "ship it" },
    });
    expect((await shared.load("r1"))?.status).toBe("paused");
    await expect(approver.pendingApprovals("r1")).resolves.toMatchObject([
      { nodeId: "approve", decision: { approved: true } },
    ]);

    // A third one resumes after a "restart".
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(calls).toEqual({ plan: 1, deploy: 1, fix: 0 });
    expect(done.nodes.approve).toMatchObject({
      status: "completed",
      output: { approved: true, decidedBy: "ana", comment: "ship it", decidedAt: 0 },
    });
    expect(done.nodes.deploy?.output).toMatchObject({ deployed: { approved: true } });

    // Deciding again: the applied decision is reported; nothing changes.
    await expect(approver.reject("r1", "approve")).resolves.toMatchObject({
      outcome: "already-terminal",
    });
    await expect(shared.load("r1")).resolves.toEqual(done);
  });

  it("applies the first of conflicting concurrent decisions, exactly once", async () => {
    const { spawn } = world();
    const { calls, definition } = release({ approval: { onReject: "fail" } });
    const paused = await spawn().executor.run(definition, null, { runId: "r1" });
    const requestId = paused.nodes.approve?.approval?.requestId as string;
    const acks = await Promise.all([
      spawn().executor.approve("r1", requestId, { decidedBy: "ana" }),
      spawn().executor.reject("r1", "approve", { decidedBy: "bo" }),
      spawn().executor.approve("r1", "approve", { decidedBy: "cy" }),
    ]);
    const recorded = acks.filter((ack) => ack.outcome === "recorded");
    expect(recorded).toHaveLength(1);
    for (const ack of acks) expect(ack.decision).toEqual(recorded[0]?.decision);

    const [first, second] = [spawn().executor, spawn().executor];
    const done = await first.resume(definition, "r1");
    await expect(second.resume(definition, "r1")).rejects.toThrow(/cannot be resumed/);
    expect(done.status).toBe(recorded[0]?.decision?.approved ? "completed" : "failed");
    expect(calls.deploy).toBe(recorded[0]?.decision?.approved ? 1 : 0);
  });

  it("a rejection fails the node and the run by default; downstream never runs", async () => {
    const { spawn } = world();
    const { calls, definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });
    await spawn().executor.reject("r1", "approve", { decidedBy: "bo", comment: "not today" });
    const events = recorder();
    const done = await spawn().executor.resume(definition, "r1", { observer: events.observer });
    expect(done.status).toBe("failed");
    expect(done.error).toEqual({
      code: "approval-rejected",
      message: 'Approval "Deploy to production?" was rejected by bo: not today',
      nodeId: "approve",
    });
    expect(done.nodes.approve).toMatchObject({
      status: "failed",
      output: { approved: false, decidedBy: "bo" },
    });
    expect(done.nodes.deploy?.status).toBe("pending");
    expect(calls.deploy).toBe(0);
    expect(events.summary()).toEqual([
      "run-resume",
      "node-finish:approve:failed",
      "run-finish:failed",
    ]);
  });

  it('with onReject "continue", a rejection completes the node and its predicates route the run', async () => {
    const { spawn } = world();
    const { calls, definition } = release({ approval: { onReject: "continue" } });
    await spawn().executor.run(definition, null, { runId: "r1" });
    await spawn().executor.reject("r1", "approve");
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(done.nodes.approve?.output).toMatchObject({ approved: false });
    expect(done.nodes.deploy?.status).toBe("skipped");
    expect(calls).toEqual({ plan: 1, deploy: 0, fix: 1 });
  });

  it("while other branches run, the owner applies a decision within the poll interval and does not pause", async () => {
    const { clock, spawn } = world();
    const { executor } = spawn();
    const slow = controlled();
    const after = controlled();
    const definition: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["gate", "slow"],
        nodes: [
          { id: "gate", approval: { title: "Go?" } },
          { id: "after", handler: "after" },
          { id: "slow", handler: "slow" },
        ],
        edges: [{ from: "gate", to: "after" }],
      },
      handlers: { slow: slow.handler, after: after.handler },
      predicates: {},
    };
    const run = track(executor.run(definition, null, { runId: "r1" }));
    await settle();
    // A silent, long node keeps the run owned; the approval waits alongside it.
    await clock.advance(3_600 * SECOND);
    expect(run.settled).toBe(false);
    await spawn().executor.approve("r1", "gate");
    await clock.advance(1_999);
    expect(after.calls()).toBe(0);
    await clock.advance(1);
    expect(after.calls()).toBe(1);
    after.finish("a");
    slow.finish("s");
    await settle();
    expect(run.value?.status).toBe("completed");
  });

  it("an approve() on the executor driving the run is applied at once", async () => {
    const { spawn } = world();
    const { executor } = spawn();
    const slow = controlled();
    const definition: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["gate", "slow"],
        nodes: [
          { id: "gate", approval: { title: "Go?" } },
          { id: "after", handler: "after" },
          { id: "slow", handler: "slow" },
        ],
        edges: [{ from: "gate", to: "after" }],
      },
      handlers: { slow: slow.handler, after: async () => "a" },
      predicates: {},
    };
    const run = track(executor.run(definition, null, { runId: "r1" }));
    await settle();
    await executor.approve("r1", "gate");
    await settle();
    expect((await executor.pendingApprovals("r1")).length).toBe(0);
    slow.finish();
    await settle();
    expect(run.value?.nodes.after?.status).toBe("completed");
  });

  it("a crash after the decision was applied continues downstream without asking again", async () => {
    const { clock, shared, spawn } = world();
    const { calls, definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });
    await spawn().executor.approve("r1", "approve");
    const crashing = spawn();
    crashing.store.crashAfterWrite = (run) => run.nodes.approve?.status === "completed";
    const lost = track(crashing.executor.resume(definition, "r1"));
    await settle();
    expect(lost.settled).toBe(false);
    expect((await shared.load("r1"))?.nodes.approve?.status).toBe("completed");
    await clock.advance(31 * SECOND); // the dead owner's lease expires
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(calls).toEqual({ plan: 1, deploy: 1, fix: 0 });
    expect(done.nodes.approve?.approval?.requestId).toBe(
      (await shared.load("r1"))?.nodes.approve?.approval?.requestId,
    );
  });

  it("a crash after the approved side effect ran never repeats it", async () => {
    const { clock, spawn } = world();
    const { calls, definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });
    await spawn().executor.approve("r1", "approve");
    const crashing = spawn();
    crashing.store.crashAfterWrite = (run) => run.nodes.deploy?.status === "completed";
    void crashing.executor.resume(definition, "r1");
    await settle();
    await clock.advance(31 * SECOND);
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(calls.deploy).toBe(1);
  });

  it("resume() of a paused run without a decision writes nothing and stays paused", async () => {
    const { spawn } = world();
    const { definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });
    const second = spawn();
    const events = recorder();
    const again = await second.executor.resume(definition, "r1", { observer: events.observer });
    expect(again.status).toBe("paused");
    expect(second.store.writes).toEqual([]);
    expect(events.summary()).toEqual(["run-resume", "run-paused"]);
    // The lease was released.
    await expect(spawn().executor.resume(definition, "r1")).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("cancel() of a paused run finalizes it; the request is closed and cannot be decided", async () => {
    const { spawn } = world();
    const { definition } = release();
    await spawn().executor.run(definition, null, { runId: "r1" });
    await expect(spawn().executor.cancel("r1")).resolves.toMatchObject({ outcome: "cancelled" });
    const approver = spawn().executor;
    await expect(approver.approve("r1", "approve")).resolves.toMatchObject({
      outcome: "already-terminal",
      status: "cancelled",
    });
    const record = await approver.pendingApprovals("r1");
    expect(record).toEqual([]);
  });

  it("a cancel ends a run that is waiting while other work runs; the waiting node is cancelled", async () => {
    const { spawn } = world();
    const { executor } = spawn();
    const slow = controlled();
    const run = track(
      executor.run(
        {
          graph: {
            id: "wf",
            version: "1",
            entry: ["gate", "slow"],
            nodes: [
              { id: "gate", approval: { title: "Go?" } },
              { id: "slow", handler: "slow" },
            ],
            edges: [],
          },
          handlers: { slow: slow.handler },
          predicates: {},
        },
        null,
        { runId: "r1" },
      ),
    );
    await settle();
    await executor.cancel("r1");
    await settle();
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes.gate?.status).toBe("cancelled");
  });

  it("reports targets that are not pending, runs that do not exist, and bad options", async () => {
    const { spawn } = world();
    const { definition } = release();
    const { executor } = spawn();
    await executor.run(definition, null, { runId: "r1" });
    await expect(executor.approve("r1", "plan")).resolves.toMatchObject({
      outcome: "not-pending",
    });
    await expect(executor.approve("r1", "nope")).resolves.toMatchObject({
      outcome: "not-pending",
    });
    await expect(executor.approve("missing", "approve")).resolves.toEqual({
      runId: "missing",
      outcome: "not-found",
    });
    await expect(executor.pendingApprovals("missing")).rejects.toThrow(/not found/);
    await expect(
      executor.approve("r1", "approve", { comment: 5 as unknown as string }),
    ).rejects.toThrow(/comment must be a string/);
  });

  it("need a store that keeps decisions", async () => {
    const { shared } = world();
    const legacy: CheckpointStore = {
      create: shared.create.bind(shared),
      load: shared.load.bind(shared),
      compareAndSwap: shared.compareAndSwap.bind(shared),
      acquireLease: shared.acquireLease.bind(shared),
      renewLease: shared.renewLease.bind(shared),
      releaseLease: shared.releaseLease.bind(shared),
      requestCancel: shared.requestCancel.bind(shared),
      isCancelRequested: shared.isCancelRequested.bind(shared),
      delete: shared.delete.bind(shared),
    };
    const executor = new WorkflowExecutor({ store: legacy });
    await expect(executor.run(release().definition, null)).rejects.toBeInstanceOf(UmioError);
    await expect(executor.approve("r", "x")).rejects.toThrow(/approval decisions/);
    // Plain DAG workflows still run on it, and stay on schema version 1.
    const done = await executor.run(
      {
        graph: {
          id: "wf",
          version: "1",
          entry: ["a"],
          nodes: [{ id: "a", handler: "a" }],
          edges: [],
        },
        handlers: { a: async () => 1 },
        predicates: {},
      },
      null,
    );
    expect(done).toMatchObject({ status: "completed", schemaVersion: 1 });
  });

  it("are validated: no handler or task options, a title, and guarded edges for onReject continue", () => {
    const invalid: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["a"],
        nodes: [
          { id: "a", handler: "a", approval: { title: "x" } },
          { id: "b", approval: { title: " " }, retry: { maxAttempts: 2, initialDelayMs: 0 } },
          { id: "c", approval: { title: "ok", onReject: "continue" } },
          { id: "d", handler: "a" },
          { id: "e" } as NodeSpec,
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "d" },
          { from: "a", to: "e" },
        ],
      },
      handlers: { a: async () => 1 },
      predicates: {},
    };
    let issues: readonly string[] = [];
    try {
      validateDefinition(invalid);
    } catch (error) {
      issues = (error as GraphValidationError).issues;
    }
    expect(issues).toEqual([
      'node "a": set only one of handler, approval and loop',
      'node "b": retry applies to task nodes only',
      'node "b": approval.title must be a non-empty string',
      'node "e": set one of handler (task), approval or loop',
      'edge c->d: an approval with onReject "continue" needs a when predicate on every outgoing edge, so a rejection cannot pass through by default',
    ]);
  });
});
