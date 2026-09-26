import { describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "../src/graph/executor.js";
import { readyNodes } from "../src/graph/plan.js";
import {
  definitionHash,
  GraphNodeError,
  GraphValidationError,
  type JsonValue,
  LLMError,
  type NodeContext,
  type NodeHandler,
  validateDefinition,
  type WorkflowDefinition,
  type WorkflowGraph,
} from "../src/index.js";

const noop: NodeHandler = async () => null;

function definition(
  graph: Partial<WorkflowGraph> & Pick<WorkflowGraph, "nodes" | "edges" | "entry">,
  handlers: Record<string, NodeHandler> = {},
  predicates: WorkflowDefinition["predicates"] = {},
): WorkflowDefinition {
  const registered: Record<string, NodeHandler> = { ...handlers };
  for (const node of graph.nodes) registered[node.handler] ??= noop;
  return { graph: { id: "wf", version: "1", ...graph }, handlers: registered, predicates };
}

const diamond = () =>
  definition({
    entry: ["research"],
    nodes: [
      { id: "research", handler: "research" },
      { id: "design", handler: "design" },
      { id: "security", handler: "security" },
      { id: "merge", handler: "merge" },
    ],
    edges: [
      { from: "research", to: "design" },
      { from: "research", to: "security" },
      { from: "design", to: "merge" },
      { from: "security", to: "merge" },
    ],
  });

function issuesOf(def: WorkflowDefinition): string[] {
  try {
    validateDefinition(def);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(GraphValidationError);
    return [...(error as GraphValidationError).issues];
  }
}

describe("validateDefinition", () => {
  it("accepts a valid diamond with predicates and joins", () => {
    const def = diamond();
    const withBranches = {
      ...def,
      graph: {
        ...def.graph,
        nodes: def.graph.nodes.map((n) => (n.id === "merge" ? { ...n, join: "any" as const } : n)),
        edges: def.graph.edges.map((e) => (e.to === "security" ? { ...e, when: "risky" } : e)),
      },
      predicates: { risky: () => true },
    };
    expect(issuesOf(withBranches)).toEqual([]);
  });

  const rejections: [string, WorkflowDefinition, RegExp][] = [
    [
      "duplicate node ids",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "a", handler: "h" },
        ],
        edges: [],
      }),
      /duplicate node id "a"/,
    ],
    [
      "a missing handler",
      {
        graph: {
          id: "wf",
          version: "1",
          entry: ["a"],
          nodes: [{ id: "a", handler: "gone" }],
          edges: [],
        },
        handlers: {},
        predicates: {},
      },
      /node "a": no handler registered as "gone"/,
    ],
    [
      "a missing predicate",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
        ],
        edges: [{ from: "a", to: "b", when: "nope" }],
      }),
      /edge a->b: no predicate registered as "nope"/,
    ],
    [
      "an unknown edge endpoint",
      definition({
        entry: ["a"],
        nodes: [{ id: "a", handler: "h" }],
        edges: [{ from: "a", to: "zz" }],
      }),
      /edge a->zz: unknown target node "zz"/,
    ],
    [
      "a duplicate edge",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "b" },
        ],
      }),
      /edge a->b: duplicate edge/,
    ],
    [
      "a cycle",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
          { id: "c", handler: "h" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "b" },
        ],
      }),
      /cycle: b -> c -> b/,
    ],
    [
      "a self-edge",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "b" },
        ],
      }),
      /cycle: b -> b/,
    ],
    [
      "an unreachable node",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "island", handler: "h" },
        ],
        edges: [],
      }),
      /node "island" is unreachable/,
    ],
    [
      "an entry node with incoming edges",
      definition({
        entry: ["a", "b"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h" },
        ],
        edges: [{ from: "a", to: "b" }],
      }),
      /entry "b" must not have incoming edges/,
    ],
    [
      "an unknown entry",
      definition({ entry: ["ghost"], nodes: [{ id: "a", handler: "h" }], edges: [] }),
      /entry "ghost" is not a node/,
    ],
    [
      "an empty entry list",
      definition({ entry: [], nodes: [{ id: "a", handler: "h" }], edges: [] }),
      /at least one node/,
    ],
    [
      "a join with fewer than 2 incoming edges",
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h" },
          { id: "b", handler: "h", join: "all" },
        ],
        edges: [{ from: "a", to: "b" }],
      }),
      /node "b": join is only valid with 2 or more incoming edges/,
    ],
    [
      'a node id containing "->"',
      definition({ entry: ["a->b"], nodes: [{ id: "a->b", handler: "h" }], edges: [] }),
      /must not contain "->"/,
    ],
    [
      "non-JSON graph values",
      definition({
        entry: ["a"],
        nodes: [{ id: "a", handler: "h", timeoutMs: Number.NaN }],
        edges: [],
      }),
      /graph must contain only JSON values/,
    ],
    [
      "invalid node options",
      definition({
        entry: ["a"],
        nodes: [
          {
            id: "a",
            handler: "h",
            retry: { maxAttempts: 0, initialDelayMs: -1 },
            recovery: "auto" as "retry",
            timeoutMs: -5,
          },
        ],
        edges: [],
      }),
      /retry\.maxAttempts must be a positive integer/,
    ],
    [
      "an empty version",
      definition({ version: "", entry: ["a"], nodes: [{ id: "a", handler: "h" }], edges: [] }),
      /graph\.version must be a non-empty string/,
    ],
  ];

  it.each(rejections)("rejects %s", (_name, def, expected) => {
    expect(issuesOf(def).join("\n")).toMatch(expected);
  });

  it("reports every issue at once", () => {
    const issues = issuesOf(
      definition({
        entry: ["a"],
        nodes: [
          { id: "a", handler: "h", recovery: "auto" as "retry", timeoutMs: -5 },
          { id: "island", handler: "h" },
        ],
        edges: [{ from: "a", to: "zz" }],
      }),
    );
    expect(issues).toHaveLength(4);
  });
});

describe("definitionHash", () => {
  it("ignores object key order and handler registration order", () => {
    const a = diamond();
    const reordered: WorkflowDefinition = {
      graph: {
        entry: a.graph.entry,
        edges: a.graph.edges.map(({ to, from }) => ({ to, from })),
        nodes: a.graph.nodes.map(({ handler, id }) => ({ handler, id })),
        version: a.graph.version,
        id: a.graph.id,
      },
      handlers: Object.fromEntries(Object.entries(a.handlers).reverse()),
      predicates: {},
    };
    expect(definitionHash(reordered)).toBe(definitionHash(a));
    expect(definitionHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with any structural change", () => {
    const base = diamond();
    const variants: WorkflowDefinition[] = [
      { ...base, graph: { ...base.graph, version: "2" } },
      { ...base, graph: { ...base.graph, nodes: [...base.graph.nodes].reverse() } },
      { ...base, graph: { ...base.graph, edges: base.graph.edges.slice(1) } },
      {
        ...base,
        graph: {
          ...base.graph,
          nodes: base.graph.nodes.map((n) => (n.id === "merge" ? { ...n, timeoutMs: 1000 } : n)),
        },
      },
      { ...base, handlers: { ...base.handlers, extra: noop } },
      { ...base, predicates: { anything: () => true } },
    ];
    const hashes = new Set([definitionHash(base), ...variants.map(definitionHash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("cannot see handler code changes (documented: bump the version)", () => {
    const base = diamond();
    const changed = { ...base, handlers: { ...base.handlers, merge: async () => "different" } };
    expect(definitionHash(changed)).toBe(definitionHash(base));
  });
});

describe("WorkflowExecutor (sequential behavior)", () => {
  let clock = 1_000;
  let ids = 0;
  const executor = (options = {}) =>
    new WorkflowExecutor(options, { now: () => clock++, newId: () => `run-${++ids}` });

  it("runs a diamond once per node in declaration order, passing predecessors", async () => {
    const seen: NodeContext[] = [];
    const record =
      (id: string): NodeHandler =>
      async (context) => {
        seen.push(context);
        return { from: id };
      };
    const def = diamond();
    const handlers = Object.fromEntries(def.graph.nodes.map((n) => [n.handler, record(n.id)]));

    const run = await executor().run({ ...def, handlers }, { request: "review" });

    expect(run.status).toBe("completed");
    expect(seen.map((c) => c.nodeId)).toEqual(["research", "design", "security", "merge"]);
    const merge = seen[3] as NodeContext;
    expect(merge.predecessors).toEqual({
      design: { from: "design" },
      security: { from: "security" },
    });
    expect(Object.keys(merge.predecessors)).toEqual(["design", "security"]);
    expect(merge).toMatchObject({
      runId: run.runId,
      attempt: 1,
      input: { request: "review" },
      idempotencyKey: `${run.runId}:merge`,
      limits: { maxOutputBytes: 262_144 },
    });
    expect(seen[0]?.predecessors).toEqual({});
    expect(Object.values(run.nodes).map((n) => [n.nodeId, n.status, n.attempt])).toEqual([
      ["research", "completed", 1],
      ["design", "completed", 1],
      ["security", "completed", 1],
      ["merge", "completed", 1],
    ]);
    expect(run.edges).toEqual({
      "research->design": true,
      "research->security": true,
      "design->merge": true,
      "security->merge": true,
    });
  });

  it("produces a versioned, identified run record", async () => {
    const def = diamond();
    const run = await executor().run(def, null, { runId: "fixed" });
    expect(run).toMatchObject({
      schemaVersion: 1,
      runId: "fixed",
      workflowId: "wf",
      definitionVersion: "1",
      definitionHash: definitionHash(def),
      status: "completed",
      input: null,
    });
    // One revision per change: 4 × (start + complete) + terminal.
    expect(run.revision).toBe(9);
    expect(run.updatedAt).toBeGreaterThan(run.createdAt);
  });

  it("records a node failure as data and, run sequentially, starts no later nodes", async () => {
    const def = diamond();
    const handlers = {
      ...def.handlers,
      design: async () => {
        throw new GraphNodeError("quota exceeded", { code: "quota", retryable: true });
      },
      security: vi.fn(noop),
    };

    const run = await executor({ maxConcurrency: 1 }).run({ ...def, handlers }, null);

    expect(run.status).toBe("failed");
    expect(run.error).toEqual({ code: "quota", message: "quota exceeded", nodeId: "design" });
    expect(run.nodes.design).toMatchObject({
      status: "failed",
      attempt: 1,
      error: { code: "quota", message: "quota exceeded", retryable: true },
    });
    expect(handlers.security).not.toHaveBeenCalled();
    expect(run.nodes.security?.status).toBe("pending");
    expect(run.nodes.merge?.status).toBe("pending");
  });

  it("classifies errors from handlers", async () => {
    const failWith = async (error: unknown) => {
      const def = definition(
        { entry: ["a"], nodes: [{ id: "a", handler: "h" }], edges: [] },
        {
          h: async () => {
            throw error;
          },
        },
      );
      return (await executor().run(def, null)).nodes.a?.error;
    };
    await expect(
      failWith(new LLMError("overloaded", { provider: "p", retryable: true })),
    ).resolves.toEqual({
      code: "llm-error",
      message: "overloaded",
      retryable: true,
    });
    await expect(failWith("plain string")).resolves.toEqual({
      code: "handler-error",
      message: "plain string",
      retryable: false,
    });
    const long = (await failWith(new Error("x".repeat(5_000))))?.message ?? "";
    expect(long.length).toBe(1_000);
  });

  it("parks a node that returns non-JSON output for recovery, as non-retryable", async () => {
    const def = definition(
      { entry: ["a"], nodes: [{ id: "a", handler: "h" }], edges: [] },
      {
        h: async () => ({ at: new Date() }) as unknown as JsonValue,
      },
    );
    const run = await executor().run(def, null);
    expect(run.status).toBe("needs-recovery");
    expect(run.nodes.a).toMatchObject({ status: "uncertain", uncertainReason: "invalid-output" });
    expect(run.nodes.a?.error).toMatchObject({ code: "output-not-json", retryable: false });
    expect(run.nodes.a?.error?.message).toMatch(/idempotency key/);
  });

  it("forwards emitted node events and ignores observer errors", async () => {
    const events: unknown[] = [];
    const def = definition(
      { entry: ["a"], nodes: [{ id: "a", handler: "h" }], edges: [] },
      {
        h: async (context) => {
          context.emit({ type: "custom", name: "progress", data: 1 });
          context.emit({ type: "custom", name: "boom" });
          return "done";
        },
      },
    );
    const run = await executor().run(def, null, {
      observer: {
        emit: (event) => {
          if (event.type !== "node-event") return;
          if (event.event.type === "custom" && event.event.name === "boom") {
            throw new Error("observer broke");
          }
          events.push([event.nodeId, event.attempt, event.event]);
        },
      },
    });
    expect(run.status).toBe("completed");
    expect(events).toEqual([["a", 1, { type: "custom", name: "progress", data: 1 }]]);
  });

  it("rejects invalid definitions, non-JSON input and invalid options", async () => {
    await expect(
      executor().run(definition({ entry: ["x"], nodes: [], edges: [] }), null),
    ).rejects.toBeInstanceOf(GraphValidationError);
    await expect(
      executor().run(diamond(), { when: undefined } as unknown as JsonValue),
    ).rejects.toThrow(/JSON/);
    expect(() => new WorkflowExecutor({ maxConcurrency: 0 })).toThrow(/maxConcurrency/);
    await expect(executor().run(diamond(), null, { maxConcurrency: 1.5 })).rejects.toThrow(
      /maxConcurrency/,
    );
  });
});

describe("readyNodes", () => {
  it("honors retryAt and requires every incoming edge to be decided active", () => {
    const def = diamond();
    const base = {
      schemaVersion: 1 as const,
      runId: "r",
      workflowId: "wf",
      definitionVersion: "1",
      definitionHash: "h",
      status: "running" as const,
      input: null,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const run = {
      ...base,
      nodes: {
        research: { nodeId: "research", status: "completed" as const, attempt: 1 },
        design: { nodeId: "design", status: "completed" as const, attempt: 1 },
        security: { nodeId: "security", status: "pending" as const, attempt: 1, retryAt: 500 },
        merge: { nodeId: "merge", status: "pending" as const, attempt: 0 },
      },
      edges: { "research->design": true, "research->security": true, "design->merge": true },
    };
    expect(readyNodes(def.graph, run, 499)).toEqual([]);
    expect(readyNodes(def.graph, run, 500)).toEqual(["security"]);
  });
});
