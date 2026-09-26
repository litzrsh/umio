/**
 * Bounded loops: a loop node runs its body DAG once per iteration until its
 * `until` predicate holds or `maxIterations` is reached. Every iteration's
 * nodes are checkpointed under their own keys, and the `until` decision is
 * recorded with the next iteration, so recovery never skips or repeats one.
 */
import { describe, expect, it } from "vitest";
import {
  GraphNodeError,
  type GraphValidationError,
  type JsonValue,
  MemoryCheckpointStore,
  type NodeContext,
  type NodeHandler,
  type NodeSpec,
  validateDefinition,
  type WorkflowDefinition,
  WorkflowExecutor,
  type WorkflowExecutorOptions,
} from "../src/index.js";
import { FakeClock, settle } from "./support/fake-clock.js";
import { controlled, ProcessStore, recorder, SECOND, track } from "./support/graph.js";

type BodyHandler = (context: NodeContext) => Promise<JsonValue> | undefined | Promise<undefined>;

function world() {
  const clock = new FakeClock(0);
  const shared = new MemoryCheckpointStore({ now: clock.now });
  const spawn = (options: WorkflowExecutorOptions = {}) => {
    const store = new ProcessStore(shared);
    return { store, executor: new WorkflowExecutor({ store, ...options }, clock) };
  };
  return { clock, shared, spawn };
}

/**
 * start → refine (loop: draft → check) → publish. `check` reports a score that
 * rises by one per iteration; the loop stops at `target`.
 */
function refining(
  options: {
    target?: number;
    maxIterations?: number;
    onExhausted?: "fail" | "complete";
    /** Returning undefined keeps the default output. */
    draft?: BodyHandler;
    check?: BodyHandler;
    loop?: Partial<NodeSpec>;
    body?: Partial<NodeSpec>;
  } = {},
) {
  const contexts: Record<string, NodeContext[]> = { draft: [], check: [], publish: [] };
  const handlers: Record<string, NodeHandler> = {
    start: async () => "brief",
    draft: async (context) => {
      contexts.draft?.push(context);
      return (await options.draft?.(context)) ?? `draft ${context.loop?.iteration}`;
    },
    check: async (context) => {
      contexts.check?.push(context);
      return (await options.check?.(context)) ?? { score: context.loop?.iteration ?? 0 };
    },
    publish: async (context) => {
      contexts.publish?.push(context);
      return context.predecessors.refine ?? null;
    },
  };
  const definition: WorkflowDefinition = {
    graph: {
      id: "refine",
      version: "1",
      entry: ["start"],
      nodes: [
        { id: "start", handler: "start" },
        {
          id: "refine",
          loop: {
            body: {
              entry: ["draft"],
              nodes: [
                { id: "draft", handler: "draft", ...options.body },
                { id: "check", handler: "check" },
              ],
              edges: [{ from: "draft", to: "check" }],
            },
            until: "goodEnough",
            maxIterations: options.maxIterations ?? 5,
            ...(options.onExhausted && { onExhausted: options.onExhausted }),
          },
          ...options.loop,
        },
        { id: "publish", handler: "publish" },
      ],
      edges: [
        { from: "start", to: "refine" },
        { from: "refine", to: "publish" },
      ],
    },
    handlers,
    predicates: {
      goodEnough: (output) =>
        ((output as { check?: { score: number } }).check?.score ?? 0) >= (options.target ?? 3),
    },
  };
  return { contexts, definition };
}

describe("loop nodes", () => {
  it("iterate until the condition holds, with a checkpoint identity per iteration", async () => {
    const { spawn } = world();
    const { contexts, definition } = refining({ target: 3 });
    const events = recorder();
    const run = await spawn().executor.run(definition, "input", {
      runId: "r1",
      observer: events.observer,
    });
    expect(run.status).toBe("completed");
    expect(run.schemaVersion).toBe(2);
    expect(run.nodes.refine).toMatchObject({
      status: "completed",
      loop: { iteration: 3, decisions: [false, false, true] },
      output: { iterations: 3, exhausted: false, outputs: { check: { score: 3 } } },
    });
    expect(Object.keys(run.nodes)).toEqual([
      "start",
      "refine",
      "publish",
      "refine#1/draft",
      "refine#1/check",
      "refine#2/draft",
      "refine#2/check",
      "refine#3/draft",
      "refine#3/check",
    ]);
    expect(run.edges["refine#2/draft->refine#2/check"]).toBe(true);
    // Contexts: identity, iteration, the previous iteration's output, and the loop's inputs.
    expect(contexts.draft?.map((context) => context.nodeId)).toEqual([
      "refine#1/draft",
      "refine#2/draft",
      "refine#3/draft",
    ]);
    expect(contexts.draft?.map((context) => context.idempotencyKey)).toEqual([
      "r1:refine#1/draft",
      "r1:refine#2/draft",
      "r1:refine#3/draft",
    ]);
    expect(contexts.draft?.map((context) => context.loop)).toEqual([
      { id: "refine", iteration: 1 },
      { id: "refine", iteration: 2, previous: { check: { score: 1 } } },
      { id: "refine", iteration: 3, previous: { check: { score: 2 } } },
    ]);
    expect(contexts.draft?.[0]?.predecessors).toEqual({ start: "brief" });
    expect(contexts.check?.[1]?.predecessors).toEqual({ "refine#2/draft": "draft 2" });
    expect(contexts.publish?.[0]?.predecessors.refine).toEqual(run.nodes.refine?.output);
    expect(events.summary().filter((line) => !line.startsWith("node-"))).toEqual([
      "run-start",
      "loop-iteration",
      "loop-iteration",
      "loop-iteration",
      "run-finish:completed",
    ]);
  });

  it("stop at maxIterations: fail by default, or complete as exhausted", async () => {
    const { spawn } = world();
    const failed = await spawn().executor.run(
      refining({ target: 99, maxIterations: 2 }).definition,
      null,
      { runId: "r1" },
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ code: "loop-exhausted", nodeId: "refine" });
    expect(failed.nodes.refine).toMatchObject({
      status: "failed",
      loop: { iteration: 2, decisions: [false, false] },
    });
    expect(failed.nodes["refine#3/draft"]).toBeUndefined();
    expect(failed.nodes.publish?.status).toBe("pending");

    const exhausted = await spawn().executor.run(
      refining({ target: 99, maxIterations: 2, onExhausted: "complete" }).definition,
      null,
      { runId: "r2" },
    );
    expect(exhausted.status).toBe("completed");
    expect(exhausted.nodes.refine?.output).toEqual({
      iterations: 2,
      exhausted: true,
      outputs: { check: { score: 2 } },
    });
  });

  it("recovery after a crash between an iteration's last write and the decision neither skips nor repeats it", async () => {
    const { clock, shared, spawn } = world();
    const { contexts, definition } = refining({ target: 3 });
    const crashing = spawn();
    crashing.store.crashAfterWrite = (run) =>
      run.nodes["refine#1/check"]?.status === "completed" && !run.nodes["refine#2/draft"];
    const lost = track(crashing.executor.run(definition, null, { runId: "r1" }));
    await settle();
    expect(lost.settled).toBe(false);
    expect((await shared.load("r1"))?.nodes.refine?.loop).toEqual({
      iteration: 1,
      decisions: [],
    });
    await clock.advance(31 * SECOND);
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(done.nodes.refine?.loop).toEqual({ iteration: 3, decisions: [false, false, true] });
    // Iteration 1 ran once; each later iteration once.
    expect(contexts.check?.map((context) => context.nodeId)).toEqual([
      "refine#1/check",
      "refine#2/check",
      "refine#3/check",
    ]);
  });

  it("an attempt interrupted inside an iteration becomes uncertain under its own key and is recovered there", async () => {
    const { clock, shared, spawn } = world();
    const hang = controlled();
    let calls = 0;
    const { contexts, definition } = refining({
      target: 2,
      draft: (context) => {
        calls += 1;
        return context.loop?.iteration === 2 && calls === 2 ? hang.handler(context) : undefined;
      },
    });
    const crashing = spawn();
    void crashing.executor.run(definition, null, { runId: "r1" });
    await settle();
    expect(hang.calls()).toBe(1);
    crashing.store.crash();
    await clock.advance(31 * SECOND);
    const parked = await spawn().executor.resume(definition, "r1");
    expect(parked.status).toBe("needs-recovery");
    expect(parked.nodes["refine#2/draft"]).toMatchObject({
      status: "uncertain",
      uncertainReason: "process-lost",
    });
    expect(parked.nodes.refine?.status).toBe("running"); // a loop node is never orphaned
    await spawn().executor.recoverNode(definition, "r1", "refine#2/draft", { type: "retry" });
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(contexts.draft?.map((context) => [context.nodeId, context.attempt])).toEqual([
      ["refine#1/draft", 1],
      ["refine#2/draft", 1],
      ["refine#2/draft", 2],
    ]);
    // Same idempotency key for the repeated attempt of the same iteration.
    expect(new Set(contexts.draft?.slice(1).map((context) => context.idempotencyKey))).toEqual(
      new Set(["r1:refine#2/draft"]),
    );
    expect((await shared.load("r1"))?.nodes.refine?.loop?.decisions).toEqual([false, true]);
  });

  it("retries count per iteration: each iteration's node starts at attempt 1", async () => {
    const { clock, spawn } = world();
    let failures = 0;
    const { contexts, definition } = refining({
      target: 2,
      body: { retry: { maxAttempts: 2, initialDelayMs: 1_000 } },
      draft: async (context) => {
        if (context.attempt === 1 && failures < 2) {
          failures += 1;
          throw new GraphNodeError("flaky", { code: "flaky", retryable: true });
        }
        return undefined;
      },
    });
    const run = track(spawn().executor.run(definition, null, { runId: "r1" }));
    await clock.advance(10 * SECOND);
    expect(run.value?.status).toBe("completed");
    expect(contexts.draft?.map((context) => `${context.nodeId}@${context.attempt}`)).toEqual([
      "refine#1/draft@1",
      "refine#1/draft@2",
      "refine#2/draft@1",
      "refine#2/draft@2",
    ]);
  });

  it("a failing body node fails the loop node and the run", async () => {
    const { spawn } = world();
    const { definition } = refining({
      check: async (context) => {
        if (context.loop?.iteration === 2) throw new Error("broken");
        return undefined;
      },
    });
    const run = await spawn().executor.run(definition, null, { runId: "r1" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "handler-error", nodeId: "refine#2/check" });
    expect(run.nodes.refine).toMatchObject({
      status: "failed",
      error: { code: "loop-body-failed", message: 'Node "refine#2/check" failed in iteration 2.' },
    });
  });

  it("a cancel inside an iteration stops the body attempt and cancels the loop node", async () => {
    const { spawn } = world();
    const hang = controlled();
    const { definition } = refining({ draft: (context) => hang.handler(context) });
    const { executor } = spawn();
    const run = track(executor.run(definition, null, { runId: "r1" }));
    await settle();
    await executor.cancel("r1");
    await settle();
    expect(run.value?.status).toBe("cancelled");
    expect(run.value?.nodes).toMatchObject({
      refine: { status: "cancelled" },
      "refine#1/draft": { status: "cancelled" },
      "refine#1/check": { status: "pending" },
    });
  });

  it("a loop result over the output limit parks the loop node for recoverNode", async () => {
    const { spawn } = world();
    const { definition } = refining({
      target: 1,
      loop: { maxOutputBytes: 64 },
      check: async () => ({ score: 5, text: "x".repeat(200) }),
    });
    const parked = await spawn().executor.run(definition, null, { runId: "r1" });
    expect(parked.status).toBe("needs-recovery");
    expect(parked.nodes.refine).toMatchObject({
      status: "uncertain",
      uncertainReason: "invalid-output",
      error: { code: "output-too-large" },
      loop: { iteration: 1, decisions: [true] },
    });
    const executor = spawn().executor;
    await expect(
      executor.recoverNode(definition, "r1", "refine", { type: "retry" }),
    ).rejects.toThrow(/cannot be retried/);
    await executor.recoverNode(definition, "r1", "refine", {
      type: "complete",
      output: { summary: "ok" },
    });
    const done = await executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(done.nodes.publish?.output).toEqual({ summary: "ok" });
  });

  it("joins and conditional edges work inside an iteration", async () => {
    const { spawn } = world();
    const definition: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["loop"],
        nodes: [
          {
            id: "loop",
            loop: {
              body: {
                entry: ["a"],
                nodes: [
                  { id: "a", handler: "a" },
                  { id: "b", handler: "b" },
                  { id: "c", handler: "c" },
                  { id: "join", handler: "join" },
                ],
                edges: [
                  { from: "a", to: "b" },
                  { from: "a", to: "c", when: "odd" },
                  { from: "b", to: "join" },
                  { from: "c", to: "join" },
                ],
              },
              until: "done",
              maxIterations: 3,
            },
          },
        ],
        edges: [],
      },
      handlers: {
        a: async (context) => context.loop?.iteration ?? 0,
        b: async () => "b",
        c: async () => "c",
        join: async (context) => Object.keys(context.predecessors),
      },
      predicates: {
        odd: (output) => (output as number) % 2 === 1,
        done: (output) => (output as { join: string[] }).join.length === 1,
      },
    };
    const run = await spawn().executor.run(definition, null, { runId: "r1" });
    expect(run.status).toBe("completed");
    expect(run.nodes["loop#1/join"]?.output).toEqual(["loop#1/b", "loop#1/c"]);
    expect(run.nodes["loop#2/c"]?.status).toBe("skipped");
    expect(run.nodes["loop#2/join"]?.output).toEqual(["loop#2/b"]);
    expect(run.nodes.loop?.output).toMatchObject({ iterations: 2 });
  });

  it("an approval inside the body asks again each iteration: revise until approved", async () => {
    const { spawn } = world();
    const drafts: number[] = [];
    const definition: WorkflowDefinition = {
      graph: {
        id: "wf",
        version: "1",
        entry: ["revise"],
        nodes: [
          {
            id: "revise",
            loop: {
              body: {
                entry: ["draft"],
                nodes: [
                  { id: "draft", handler: "draft" },
                  { id: "review", approval: { title: "Accept this draft?", onReject: "continue" } },
                ],
                edges: [{ from: "draft", to: "review" }],
              },
              until: "accepted",
              maxIterations: 5,
            },
          },
        ],
        edges: [],
      },
      handlers: {
        draft: async (context) => {
          drafts.push(context.loop?.iteration ?? 0);
          return `draft ${context.loop?.iteration}`;
        },
      },
      predicates: {
        accepted: (output) => (output as { review: { approved: boolean } }).review.approved,
      },
    };
    const first = await spawn().executor.run(definition, null, { runId: "r1" });
    expect(first.status).toBe("paused");
    const [request] = await spawn().executor.pendingApprovals("r1");
    expect(request).toMatchObject({
      nodeId: "revise#1/review",
      context: { "revise#1/draft": "draft 1" },
    });
    await spawn().executor.reject("r1", "revise#1/review", { comment: "shorter" });
    const second = await spawn().executor.resume(definition, "r1");
    expect(second.status).toBe("paused");
    const [again] = await spawn().executor.pendingApprovals("r1");
    expect(again?.nodeId).toBe("revise#2/review");
    expect(again?.request.requestId).not.toBe(request?.request.requestId);
    // The old request is settled; deciding it again changes nothing.
    await expect(spawn().executor.approve("r1", "revise#1/review")).resolves.toMatchObject({
      outcome: "already-decided",
      decision: { approved: false, comment: "shorter" },
    });
    await spawn().executor.approve("r1", "revise#2/review");
    const done = await spawn().executor.resume(definition, "r1");
    expect(done.status).toBe("completed");
    expect(drafts).toEqual([1, 2]);
    expect(done.nodes.revise?.loop).toEqual({ iteration: 2, decisions: [false, true] });
  });

  it("are validated: bounded, a registered condition, no nesting, edges inside the body", () => {
    const loop = (spec: Partial<NodeSpec["loop"]>, extra: Partial<NodeSpec> = {}): NodeSpec => ({
      id: "l",
      // Keys set to undefined are left out, as in JSON.
      loop: JSON.parse(
        JSON.stringify({
          body: { entry: ["x"], nodes: [{ id: "x", handler: "h" }], edges: [] },
          until: "stop",
          maxIterations: 3,
          ...spec,
        }),
      ),
      ...extra,
    });
    const issues = (nodes: NodeSpec[], edges: WorkflowDefinition["graph"]["edges"] = []) => {
      try {
        validateDefinition({
          graph: { id: "wf", version: "1", entry: [nodes[0]?.id ?? "l"], nodes, edges },
          handlers: { h: async () => 1 },
          predicates: { stop: () => true },
        });
        return [];
      } catch (error) {
        return (error as GraphValidationError).issues;
      }
    };
    expect(issues([loop({})])).toEqual([]);
    expect(issues([loop({ maxIterations: undefined as unknown as number })])).toEqual([
      'loop "l": maxIterations is required and must be an integer from 1 to 10000',
    ]);
    expect(issues([loop({ maxIterations: 10_001 })])).toHaveLength(1);
    expect(issues([loop({ until: "missing" })])).toEqual([
      'loop "l": until must name a registered predicate (got "missing")',
    ]);
    expect(issues([loop({}, { retry: { maxAttempts: 2, initialDelayMs: 0 } })])).toEqual([
      'node "l": retry applies to task nodes only',
    ]);
    expect(
      issues([
        loop({
          body: {
            entry: ["inner"],
            nodes: [
              {
                id: "inner",
                loop: {
                  body: { entry: ["y"], nodes: [{ id: "y", handler: "h" }], edges: [] },
                  until: "stop",
                  maxIterations: 2,
                },
              },
            ],
            edges: [],
          },
        }),
      ]),
    ).toContain('loop "l": body node "inner": loops cannot be nested');
    expect(
      issues(
        [
          loop({
            body: {
              entry: ["x"],
              nodes: [{ id: "x", handler: "h" }],
              edges: [{ from: "x", to: "after" }],
            },
          }),
          { id: "after", handler: "h" },
        ],
        [{ from: "l", to: "after" }],
      ),
    ).toEqual(['loop "l" body: edge x->after: unknown target node "after"']);
    expect(
      issues([
        loop({
          body: {
            entry: ["x"],
            nodes: [
              { id: "x", handler: "h" },
              { id: "y", handler: "h" },
            ],
            edges: [
              { from: "x", to: "y" },
              { from: "y", to: "x" },
            ],
          },
        }),
      ]),
    ).toEqual([
      'loop "l" body: entry "x" must not have incoming edges',
      'loop "l" body: cycle: x -> y -> x (graphs must be acyclic; repeat work with an explicit loop node)',
    ]);
    expect(issues([loop({}, { id: "l#1" })])).toContain(
      'loop "l#1": a loop node id must not contain "#"',
    );
    // Plain cycles stay invalid: repetition needs an explicit, bounded loop.
    expect(
      issues(
        [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).toContain(
      "cycle: a -> b -> a (graphs must be acyclic; repeat work with an explicit loop node)",
    );
  });
});
