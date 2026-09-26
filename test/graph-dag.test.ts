// P2 (docs/work/umio-graph-workflow-plan.md §9): DAG execution — branches,
// joins, skip propagation, concurrency and its configuration, output limits,
// failure while nodes run concurrently, artifacts, and agentNode.
import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  agentNode,
  collectArtifactRefs,
  defaultTask,
  type GenerateResult,
  isArtifactRef,
  type JsonValue,
  type ModelClient,
  type NodeContext,
  type NodeEvent,
  type NodeHandler,
  parseConfig,
  type WorkflowDefinition,
  WorkflowExecutor,
  type WorkflowGraph,
} from "../src/index.js";

const noop: NodeHandler = async () => null;

function definition(
  graph: Pick<WorkflowGraph, "nodes" | "edges" | "entry">,
  handlers: Record<string, NodeHandler> = {},
  predicates: WorkflowDefinition["predicates"] = {},
): WorkflowDefinition {
  const registered: Record<string, NodeHandler> = { ...handlers };
  for (const node of graph.nodes) registered[node.handler] ??= noop;
  return { graph: { id: "wf", version: "1", ...graph }, handlers: registered, predicates };
}

const node = (id: string, extra = {}) => ({ id, handler: id, ...extra });

/** Handlers that wait until released, tracking how many run at once. */
function gates() {
  const waiting = new Map<string, () => void>();
  let inFlight = 0;
  let maxInFlight = 0;
  const started: string[] = [];
  const handler =
    (id: string, output: JsonValue = { from: id }): NodeHandler =>
    async (context) => {
      started.push(id);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve, reject) => {
          waiting.set(id, resolve);
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return output;
      } finally {
        inFlight--;
      }
    };
  const release = async (id: string) => {
    await vi.waitFor(() => expect(waiting.has(id)).toBe(true));
    waiting.get(id)?.();
    waiting.delete(id);
  };
  return {
    handler,
    release,
    started,
    running: () => [...waiting.keys()],
    maxInFlight: () => maxInFlight,
  };
}

const executor = (options = {}) => {
  let clock = 0;
  let ids = 0;
  return new WorkflowExecutor(options, { now: () => ++clock, newId: () => `run-${++ids}` });
};

describe("branches and skips", () => {
  it("runs a diamond once per node, with both branches in parallel", async () => {
    const g = gates();
    const def = definition(
      {
        entry: ["research"],
        nodes: [node("research"), node("design"), node("security"), node("merge")],
        edges: [
          { from: "research", to: "design" },
          { from: "research", to: "security" },
          { from: "design", to: "merge" },
          { from: "security", to: "merge" },
        ],
      },
      Object.fromEntries(
        ["research", "design", "security", "merge"].map((id) => [id, g.handler(id)]),
      ),
    );

    const run = executor().run(def, null);
    await g.release("research");
    await vi.waitFor(() => expect(g.running().sort()).toEqual(["design", "security"]));
    await g.release("security");
    await g.release("design");
    await g.release("merge");
    const record = await run;

    expect(record.status).toBe("completed");
    expect(g.started.sort()).toEqual(["design", "merge", "research", "security"]);
    expect(Object.values(record.nodes).every((n) => n.attempt === 1)).toBe(true);
    expect(g.maxInFlight()).toBe(2);
  });

  it("skips an inactive branch transitively and joins on the active one", async () => {
    const seen: Record<string, NodeContext> = {};
    const capture =
      (id: string): NodeHandler =>
      async (context) => {
        seen[id] = context;
        return { risky: false, from: id };
      };
    const def = definition(
      {
        entry: ["research"],
        nodes: [node("research"), node("design"), node("security"), node("audit"), node("merge")],
        edges: [
          { from: "research", to: "design" },
          { from: "research", to: "security", when: "risky" },
          { from: "security", to: "audit" },
          { from: "design", to: "merge" },
          { from: "audit", to: "merge" },
        ],
      },
      Object.fromEntries(
        ["research", "design", "security", "audit", "merge"].map((id) => [id, capture(id)]),
      ),
      { risky: (output) => (output as { risky: boolean }).risky },
    );

    const record = await executor().run(def, null);

    expect(record.status).toBe("completed");
    expect(record.nodes.security?.status).toBe("skipped");
    expect(record.nodes.audit?.status).toBe("skipped");
    expect(record.nodes.security?.attempt).toBe(0);
    expect(record.edges).toMatchObject({
      "research->security": false,
      "security->audit": false,
      "audit->merge": false,
      "research->design": true,
      "design->merge": true,
    });
    expect(Object.keys(seen).sort()).toEqual(["design", "merge", "research"]);
    expect(seen.merge?.predecessors).toEqual({ design: { risky: false, from: "design" } });
  });

  it("skips a join whose incoming edges are all inactive, and everything after it", async () => {
    const def = definition(
      {
        entry: ["a"],
        nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
        edges: [
          { from: "a", to: "b", when: "never" },
          { from: "a", to: "c", when: "never" },
          { from: "b", to: "d" },
          { from: "c", to: "d" },
          { from: "d", to: "e" },
        ],
      },
      {},
      { never: () => false },
    );
    const record = await executor().run(def, null);
    expect(record.status).toBe("completed");
    expect(["b", "c", "d", "e"].map((id) => record.nodes[id]?.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  it("evaluates each predicate once per completed source, with the run input", async () => {
    const predicate = vi.fn((output: JsonValue, input: JsonValue) => output === input);
    const def = definition(
      {
        entry: ["a"],
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [
          { from: "a", to: "b", when: "same" },
          { from: "a", to: "c", when: "same" },
          { from: "b", to: "d" },
          { from: "c", to: "d" },
        ],
      },
      { a: async () => "x" },
      { same: predicate },
    );
    const record = await executor().run(def, "x");
    expect(record.status).toBe("completed");
    expect(predicate).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenCalledWith("x", "x");
  });

  it("fails the node when a predicate throws or returns a non-boolean", async () => {
    const run = (predicate: () => unknown) =>
      executor().run(
        definition(
          {
            entry: ["a"],
            nodes: [node("a"), node("b")],
            edges: [{ from: "a", to: "b", when: "p" }],
          },
          {},
          { p: predicate as () => boolean },
        ),
        null,
      );
    const thrown = await run(() => {
      throw new Error("bad data");
    });
    expect(thrown.status).toBe("failed");
    expect(thrown.nodes.a?.error).toMatchObject({ code: "predicate-error", retryable: false });
    expect(thrown.nodes.a?.error?.message).toMatch(/edge a->b failed: bad data/);
    expect(thrown.nodes.b?.status).toBe("pending");

    const wrongType = await run(() => "yes");
    expect(wrongType.nodes.a?.error?.message).toMatch(/returned string, expected boolean/);
  });
});

describe('join: "any"', () => {
  it("runs once on the first active predecessor and keeps that choice", async () => {
    const g = gates();
    const joined: NodeContext[] = [];
    const def = definition(
      {
        entry: ["start"],
        nodes: [node("start"), node("slow"), node("fast"), node("first", { join: "any" })],
        edges: [
          { from: "start", to: "slow" },
          { from: "start", to: "fast" },
          { from: "slow", to: "first" },
          { from: "fast", to: "first" },
        ],
      },
      {
        start: async () => null,
        slow: g.handler("slow"),
        fast: g.handler("fast"),
        first: async (context) => {
          joined.push(context);
          return "joined";
        },
      },
    );

    const run = executor().run(def, null);
    await g.release("fast");
    await vi.waitFor(() => expect(joined).toHaveLength(1));
    await g.release("slow");
    const record = await run;

    expect(record.status).toBe("completed");
    expect(joined).toHaveLength(1);
    expect(joined[0]?.predecessors).toEqual({ fast: { from: "fast" } });
    expect(record.nodes.first).toMatchObject({ selectedPredecessor: "fast", attempt: 1 });
    expect(record.nodes.slow?.status).toBe("completed");
    expect(record.edges["slow->first"]).toBe(true);
  });

  it("keeps the first selection when another predecessor completes before the join starts", async () => {
    const g = gates();
    const joined: NodeContext[] = [];
    // Two slots: `fast` finishes first, but `blocker` takes the free slot before
    // `first` (declaration order), so `slow` also completes while `first` waits.
    const def = definition(
      {
        entry: ["start"],
        nodes: [
          node("start"),
          node("slow"),
          node("fast"),
          node("blocker"),
          node("first", { join: "any" }),
        ],
        edges: [
          { from: "start", to: "slow" },
          { from: "start", to: "fast" },
          { from: "start", to: "blocker" },
          { from: "slow", to: "first" },
          { from: "fast", to: "first" },
        ],
      },
      {
        start: async () => null,
        slow: g.handler("slow"),
        fast: g.handler("fast"),
        blocker: g.handler("blocker"),
        first: async (context) => {
          joined.push(context);
          return "joined";
        },
      },
    );

    const run = executor({ maxConcurrency: 2 }).run(def, null);
    await g.release("fast");
    await vi.waitFor(() => expect(g.running().sort()).toEqual(["blocker", "slow"]));
    await g.release("slow");
    await g.release("blocker");
    const record = await run;

    expect(joined).toHaveLength(1);
    expect(joined[0]?.predecessors).toEqual({ fast: { from: "fast" } });
    expect(record.nodes.first?.selectedPredecessor).toBe("fast");
  });

  it("selects the only active predecessor when the other branch is skipped", async () => {
    const def = definition(
      {
        entry: ["start"],
        nodes: [node("start"), node("left"), node("right"), node("join", { join: "any" })],
        edges: [
          { from: "start", to: "left", when: "no" },
          { from: "start", to: "right" },
          { from: "left", to: "join" },
          { from: "right", to: "join" },
        ],
      },
      {},
      { no: () => false },
    );
    const record = await executor().run(def, null);
    expect(record.nodes.left?.status).toBe("skipped");
    expect(record.nodes.join).toMatchObject({ status: "completed", selectedPredecessor: "right" });
  });
});

describe("concurrency", () => {
  const fanOut = (count: number, handler: (id: string) => NodeHandler) => {
    const ids = Array.from({ length: count }, (_, i) => `n${i}`);
    return definition(
      { entry: ids, nodes: ids.map((id) => node(id)), edges: [] },
      Object.fromEntries(ids.map((id) => [id, handler(id)])),
    );
  };

  async function peak(exec: WorkflowExecutor, runOptions = {}) {
    const g = gates();
    const run = exec.run(
      fanOut(6, (id) => g.handler(id)),
      null,
      runOptions,
    );
    for (let i = 0; i < 6; i++) await g.release(`n${i}`);
    await run;
    return g.maxInFlight();
  }

  it("never exceeds the limit, and defaults to 4", async () => {
    await expect(peak(executor({ maxConcurrency: 2 }))).resolves.toBe(2);
    await expect(peak(executor())).resolves.toBe(4);
    await expect(peak(executor({ maxConcurrency: 1 }))).resolves.toBe(1);
  });

  it("applies precedence: run option > constructor option > config > default", async () => {
    const config = (graph?: object) =>
      parseConfig(
        {
          defaultModel: "m",
          providers: { p: { type: "ollama" } },
          models: { m: { provider: "p", model: "x" } },
          ...(graph && { graph }),
        },
        {},
      );
    const fromConfig = (graph: object | undefined, options = {}) =>
      WorkflowExecutor.fromConfig(config(graph), options, { now: () => 0, newId: () => "r" });

    await expect(peak(fromConfig({ maxConcurrency: 1 }))).resolves.toBe(1);
    await expect(peak(fromConfig(undefined))).resolves.toBe(4);
    await expect(peak(fromConfig({ maxConcurrency: 1 }, { maxConcurrency: 3 }))).resolves.toBe(3);
    await expect(
      peak(fromConfig({ maxConcurrency: 1 }, { maxConcurrency: 3 }), { maxConcurrency: 2 }),
    ).resolves.toBe(2);
    // An explicitly undefined option does not erase the config value.
    await expect(
      peak(fromConfig({ maxConcurrency: 1 }, { maxConcurrency: undefined })),
    ).resolves.toBe(1);
  });

  it("validates the config section strictly", () => {
    expect(() =>
      parseConfig(
        {
          defaultModel: "m",
          providers: { p: { type: "ollama" } },
          models: { m: { provider: "p", model: "x" } },
          graph: { maxConcurency: 1 },
        },
        {},
      ),
    ).toThrow(/maxConcurency/);
  });
});

describe("failure while nodes run concurrently", () => {
  it("aborts running siblings, records them cancelled, and starts nothing new", async () => {
    const g = gates();
    const after = vi.fn(noop);
    const def = definition(
      {
        entry: ["good", "bad"],
        nodes: [node("good"), node("bad"), node("after")],
        edges: [{ from: "good", to: "after" }],
      },
      {
        good: g.handler("good"),
        bad: async () => {
          await vi.waitFor(() => expect(g.running()).toContain("good"));
          throw new Error("broken");
        },
        after,
      },
    );

    const record = await executor().run(def, null);

    expect(record.status).toBe("failed");
    expect(record.error).toEqual({ code: "handler-error", message: "broken", nodeId: "bad" });
    expect(record.nodes.bad?.status).toBe("failed");
    expect(record.nodes.good?.status).toBe("cancelled");
    expect(record.nodes.after?.status).toBe("pending");
    expect(after).not.toHaveBeenCalled();
  });
});

describe("output limits", () => {
  const big = "x".repeat(300_000);

  it("parks oversized output as uncertain (invalid-output), with configurable limits", async () => {
    const single = (spec = {}) =>
      definition({ entry: ["a"], nodes: [node("a", spec)], edges: [] }, { a: async () => big });

    const tooBig = await executor().run(single(), null);
    expect(tooBig.status).toBe("needs-recovery");
    expect(tooBig.nodes.a).toMatchObject({
      status: "uncertain",
      uncertainReason: "invalid-output",
    });
    expect(tooBig.nodes.a?.error).toMatchObject({ code: "output-too-large", retryable: false });
    expect(tooBig.nodes.a?.error?.message).toMatch(
      /300002 bytes, over the 262144-byte limit.*ArtifactRef/,
    );
    expect(tooBig.nodes.a?.output).toBeUndefined();

    expect((await executor({ maxOutputBytes: 400_000 }).run(single(), null)).status).toBe(
      "completed",
    );
    expect((await executor().run(single({ maxOutputBytes: 400_000 }), null)).status).toBe(
      "completed",
    );
  });

  it("measures UTF-8 bytes, not characters, and exposes the limit to handlers", async () => {
    let limit = 0;
    const record = await executor({ maxOutputBytes: 10 }).run(
      definition(
        { entry: ["a"], nodes: [node("a")], edges: [] },
        {
          a: async (context) => {
            limit = context.limits.maxOutputBytes;
            return "한글한글"; // 4 characters, 12 bytes + 2 quotes
          },
        },
      ),
      null,
    );
    expect(limit).toBe(10);
    expect(record.nodes.a?.error?.code).toBe("output-too-large");
  });
});

describe("artifact references", () => {
  const ref = { $artifact: { uri: "file:///tmp/a.md", sha256: "a".repeat(64), bytes: 10 } };

  it("recognizes valid references only", () => {
    expect(isArtifactRef(ref)).toBe(true);
    expect(isArtifactRef({ $artifact: { ...ref.$artifact, mediaType: "text/markdown" } })).toBe(
      true,
    );
    expect(isArtifactRef({ $artifact: { ...ref.$artifact, sha256: "short" } })).toBe(false);
    expect(isArtifactRef({ $artifact: { ...ref.$artifact, bytes: -1 } })).toBe(false);
    expect(isArtifactRef({ $artifact: { uri: "", sha256: "a".repeat(64), bytes: 1 } })).toBe(false);
    expect(isArtifactRef({ uri: "x" })).toBe(false);
  });

  it("collects references from node outputs", async () => {
    const record = await executor().run(
      definition(
        { entry: ["a", "b"], nodes: [node("a"), node("b")], edges: [] },
        {
          a: async () => ({ report: ref, notes: [ref] }),
          b: async () => "plain",
        },
      ),
      null,
    );
    expect(collectArtifactRefs(record)).toEqual([ref, ref]);
  });
});

describe("agentNode", () => {
  const reply = (text: string): GenerateResult => ({
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2 },
    model: "fake",
    raw: {},
  });

  it("runs the agent on the default task and returns { text, usage }", async () => {
    const tasks: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const llm: ModelClient = {
      generate: async (request) => {
        tasks.push(String(request.messages[0]?.content));
        signals.push(request.signal);
        return reply(`answer ${tasks.length}`);
      },
      stream: () => {
        throw new Error("unused");
      },
    };
    const events: NodeEvent[] = [];
    const writer = new Agent({ name: "Writer", role: "Writes." });
    const def = definition(
      {
        entry: ["draft"],
        nodes: [node("draft"), node("polish")],
        edges: [{ from: "draft", to: "polish" }],
      },
      {
        draft: agentNode(writer, { llm, adr: false }),
        polish: agentNode(writer, { llm, adr: false }),
      },
    );

    const record = await executor().run(def, "Write about caching.", {
      observer: {
        emit: (event) => {
          if (event.type === "node-event") events.push(event.event);
        },
      },
    });

    expect(record.status).toBe("completed");
    expect(record.nodes.polish?.output).toEqual({
      text: "answer 2",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(tasks[0]).toBe("Write about caching.");
    expect(tasks[1]).toBe(
      'Write about caching.\n\nResults from previous steps:\n\n<result node="draft">\nanswer 1\n</result>',
    );
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(events.some((e) => e.type === "agent-event" && e.agent === "Writer")).toBe(true);
  });

  it("accepts a custom task builder", async () => {
    const llm: ModelClient = {
      generate: async (request) => reply(`got: ${request.messages[0]?.content}`),
      stream: () => {
        throw new Error("unused");
      },
    };
    const record = await executor().run(
      definition(
        { entry: ["a"], nodes: [node("a")], edges: [] },
        {
          a: agentNode(new Agent({ name: "A", role: "r" }), {
            llm,
            adr: false,
            task: (context) => `task for ${context.nodeId}`,
          }),
        },
      ),
      null,
    );
    expect(record.nodes.a?.output).toMatchObject({ text: "got: task for a" });
  });

  it("formats non-agent predecessor outputs as JSON in the default task", () => {
    const context = {
      input: { topic: "x" },
      predecessors: { data: { rows: 2 }, agent: { text: "hello", usage: {} } },
    } as unknown as NodeContext;
    expect(defaultTask(context)).toBe(
      '{\n  "topic": "x"\n}\n\nResults from previous steps:\n\n<result node="data">\n{\n  "rows": 2\n}\n</result>\n\n<result node="agent">\nhello\n</result>',
    );
  });
});
