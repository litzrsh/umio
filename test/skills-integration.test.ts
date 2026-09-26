/**
 * Skills composed into agents, sequential workflows and graph nodes, with a
 * scripted model (docs/design/umio-skills-design.md §4, §5, §8).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  agentNode,
  type GraphRunEvent,
  loadSkillCatalog,
  parseConfig,
  SkillChangedError,
  type SkillEvent,
  skillManifest,
  skillsFromConfig,
  tool,
  Workflow,
  WorkflowExecutor,
  withSkills,
} from "../src/index.js";
import {
  call,
  calls,
  cleanup,
  scripted,
  skillDocument,
  systemText,
  tempRoot,
  text,
  toolResults,
  writeTree,
} from "./support/skills.js";

afterEach(cleanup);

async function catalogWithReview() {
  const root = await tempRoot();
  await writeTree(root, {
    "skills/code-review/SKILL.md": skillDocument("code-review", "REVIEW-BODY: inspect callers."),
    "skills/code-review/references/checklist.md": "CHECKLIST",
    "skills/test-design/SKILL.md": skillDocument("test-design", "TEST-BODY: use fake clocks."),
  });
  return { root, catalog: await loadSkillCatalog({ roots: ["skills"], baseDir: root }) };
}

const reviewer = () =>
  new Agent({ name: "Reviewer", role: "Reviews changes.", instructions: "STANDING-INSTRUCTIONS" });

describe("agents", () => {
  it("puts skills after the caller's context (ADRs) and before the agent's own role and instructions", async () => {
    const { catalog } = await catalogWithReview();
    const { model, requests } = scripted(text("done"));
    const agent = reviewer();
    const { options } = await withSkills(
      agent,
      { llm: model, context: ["ADR-CONTEXT"] },
      { catalog, selection: { include: ["code-review"], activate: ["code-review"] } },
    );
    await agent.run("Review this", options);
    const system = systemText(requests[0]);
    const order = [
      "ADR-CONTEXT",
      "REVIEW-BODY",
      "You are Reviewer. Reviews changes.",
      "STANDING-INSTRUCTIONS",
    ].map((marker) => system.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(requests[0]?.tools?.map((item) => item.name)).toEqual(["skills_read"]);
  });

  it("changes nothing without a binding", async () => {
    const agent = reviewer();
    const options = { llm: scripted().model, context: ["x"] };
    const result = await withSkills(agent, options, undefined);
    expect(result.options).toBe(options);
    expect(result.prepared).toBeUndefined();
  });

  it("rejects agent tools that use a reserved skill tool name, before any model call", async () => {
    const { catalog } = await catalogWithReview();
    const clash = tool({
      name: "skills_read",
      description: "mine",
      parameters: z.object({}),
      execute: () => "x",
    });
    const agent = new Agent({ name: "A", role: "r", tools: [clash] });
    await expect(
      withSkills(agent, { llm: scripted().model }, { catalog, selection: { include: [] } }),
    ).rejects.toThrow(
      'Tool name "skills_read" is reserved for skills; rename that tool of agent "A".',
    );
  });

  it("lets the model load a permitted skill and read its files, through the normal hooks", async () => {
    const { catalog } = await catalogWithReview();
    const { model, requests } = scripted(
      calls(call("1", "skills_read", { name: "code-review", path: "references/checklist.md" })),
      calls(
        call("2", "skills_load", { name: "test-design" }),
        call("3", "skills_load", { name: "code-review" }),
      ),
      calls(call("4", "skills_read", { name: "code-review", path: "references/checklist.md" })),
      text("Reviewed."),
    );
    const seen: string[] = [];
    const agent = reviewer();
    const { options, prepared } = await withSkills(
      agent,
      {
        llm: model,
        hooks: {
          beforeToolCall: (toolCall) => {
            seen.push(toolCall.name);
            return undefined;
          },
        },
      },
      { catalog, selection: { include: ["code-review"], allowModelSelection: true } },
    );
    const result = await agent.run("Review", options);
    expect(result.text).toBe("Reviewed.");
    expect(seen).toEqual(["skills_read", "skills_load", "skills_load", "skills_read"]);
    // The first request advertises summaries, not bodies.
    expect(systemText(requests[0])).toMatch(/- code-review: code-review guidance for tests\./);
    expect(systemText(requests[0])).not.toMatch(/REVIEW-BODY/);
    // The system prompt never changes during the run; instructions arrive as tool results.
    expect(new Set(requests.map((request) => systemText(request))).size).toBe(1);
    const results = toolResults(requests[3]);
    expect(results["1"]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/load it with skills_load first/),
    });
    expect(results["2"]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/not available here/),
    });
    expect(results["3"]?.content).toMatch(/REVIEW-BODY/);
    expect(results["4"]).toEqual({ content: "CHECKLIST" });
    expect(prepared?.usage()).toEqual([
      expect.objectContaining({
        name: "code-review",
        resources: [expect.objectContaining({ path: "references/checklist.md" })],
      }),
    ]);
  });

  it("gives a delegated agent only its own skills", async () => {
    const { catalog } = await catalogWithReview();
    const { model, requests } = scripted(
      calls(call("1", "ask_helper", { task: "help" })),
      text("helper answer"),
      text("parent answer"),
    );
    const helper = new Agent({ name: "Helper", role: "Helps." });
    const parent = new Agent({
      name: "Parent",
      role: "Leads.",
      tools: [helper.asTool({ llm: model })],
    });
    const { options } = await withSkills(
      parent,
      { llm: model },
      {
        catalog,
        selection: { include: ["code-review"], activate: ["code-review"] },
      },
    );
    await parent.run("go", options);
    expect(systemText(requests[0])).toMatch(/REVIEW-BODY/);
    expect(systemText(requests[1])).not.toMatch(/REVIEW-BODY|Skills/);
    expect(requests[1]?.tools ?? []).toEqual([]);
  });
});

describe("workflows and graph nodes", () => {
  it("prepares per step: a default binding, a replacement, and false", async () => {
    const { catalog } = await catalogWithReview();
    const { model, requests } = scripted(text("one"), text("two"), text("three"));
    const workflow = new Workflow({
      llm: model,
      adr: false,
      skills: { catalog, selection: { include: ["code-review"], activate: ["code-review"] } },
    })
      .step(new Agent({ name: "First", role: "r" }))
      .step(new Agent({ name: "Second", role: "r" }), {
        skills: { catalog, selection: { include: ["test-design"], activate: ["test-design"] } },
      })
      .step(new Agent({ name: "Third", role: "r" }), { skills: false });
    const result = await workflow.run("task");
    expect(systemText(requests[0])).toMatch(/REVIEW-BODY/);
    expect(systemText(requests[0])).not.toMatch(/TEST-BODY/);
    // Selections are replaced, never merged.
    expect(systemText(requests[1])).toMatch(/TEST-BODY/);
    expect(systemText(requests[1])).not.toMatch(/REVIEW-BODY/);
    expect(systemText(requests[2])).not.toMatch(/Skills/);
    expect(result.steps.map((step) => step.skills?.skills.map((item) => item.name))).toEqual([
      ["code-review"],
      ["test-design"],
      undefined,
    ]);
  });

  it("a graph agent node emits skill events and records a manifest in its output", async () => {
    const { catalog } = await catalogWithReview();
    const { model } = scripted(
      calls(call("1", "skills_read", { name: "code-review", path: "references/checklist.md" })),
      text("ok"),
    );
    const own: SkillEvent[] = [];
    const events: GraphRunEvent[] = [];
    const run = await new WorkflowExecutor().run(
      {
        graph: {
          id: "g",
          version: "1",
          entry: ["review"],
          nodes: [{ id: "review", handler: "review" }],
          edges: [],
        },
        handlers: {
          review: agentNode(reviewer(), {
            llm: model,
            adr: false,
            skills: {
              catalog,
              selection: { include: ["code-review"], activate: ["code-review"] },
              onEvent: (event) => own.push(event),
            },
          }),
        },
        predicates: {},
      },
      null,
      { observer: { emit: (event) => void events.push(event) } },
    );
    expect(run.status).toBe("completed");
    const output = run.nodes.review?.output as { skills: unknown };
    expect(output.skills).toEqual({
      version: 1,
      skills: [
        {
          name: "code-review",
          documentDigest: catalog.list()[0]?.digest,
          resources: [{ path: "references/checklist.md", digest: expect.any(String) }],
        },
      ],
    });
    const skillEvents = events.flatMap((event) =>
      event.type === "node-event" && event.event.type === "custom" && event.event.name === "skill"
        ? [(event.event.data as { type: string }).type]
        : [],
    );
    expect(skillEvents).toEqual(["skills-prepared", "skill-resource-read"]);
    expect(own.map((event) => event.type)).toEqual(skillEvents);
  });

  it("manifests verify unchanged content and name what changed", async () => {
    const { root, catalog } = await catalogWithReview();
    const prepared = await catalog.prepare({ include: ["code-review"], activate: ["code-review"] });
    const read = prepared.tools.find((item) => item.name === "skills_read");
    await read?.execute(
      { name: "code-review", path: "references/checklist.md" },
      { toolCallId: "x", messages: [] },
    );
    const manifest = skillManifest(prepared.usage());
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    await expect(catalog.verify(manifest)).resolves.toBeUndefined();
    await writeFile(join(root, "skills/code-review/references/checklist.md"), "CHANGED");
    await expect(catalog.verify(manifest)).rejects.toBeInstanceOf(SkillChangedError);
    await expect(catalog.verify(manifest)).rejects.toThrow(
      /code-review": references\/checklist\.md changed/,
    );
  });
});

describe("configuration", () => {
  const base = {
    defaultModel: "m",
    providers: { p: { type: "ollama" } },
    models: { m: { provider: "p", model: "x" } },
  };

  it("validates the section: include required, activation within include, names and limits", () => {
    expect(() => parseConfig({ ...base, skills: { roots: ["s"] } }, {})).toThrow(/skills\.include/);
    expect(() =>
      parseConfig({ ...base, skills: { roots: ["s"], include: ["a"], activate: ["b"] } }, {}),
    ).toThrow(/skills\.activate\.0: "b" is not in skills\.include/);
    expect(() => parseConfig({ ...base, skills: { roots: ["s"], include: ["Bad"] } }, {})).toThrow(
      /must be a skill name/,
    );
    expect(() =>
      parseConfig(
        { ...base, skills: { roots: ["s"], include: [], limits: { maxReadBytes: 0 } } },
        {},
      ),
    ).toThrow(/limits\.maxReadBytes/);
    expect(() =>
      parseConfig({ ...base, skills: { roots: ["s"], include: [], extra: 1 } }, {}),
    ).toThrow();
  });

  it("resolves roots against the config directory; an explicit activation replaces the configured one within include", async () => {
    const { root } = await catalogWithReview();
    const config = {
      ...parseConfig(
        {
          ...base,
          skills: {
            roots: ["skills"],
            include: ["code-review", "test-design"],
            activate: ["code-review"],
          },
        },
        {},
      ),
      configDir: root,
    };
    const binding = await skillsFromConfig(config);
    expect(binding?.selection).toEqual({
      include: ["code-review", "test-design"],
      activate: ["code-review"],
    });
    const replaced = await skillsFromConfig(config, { activate: ["test-design"] });
    expect(replaced?.selection.activate).toEqual(["test-design"]);
    const outside = await skillsFromConfig(
      { ...config, skills: { roots: ["skills"], include: ["code-review"] } },
      { activate: ["test-design"] },
    );
    await expect(outside?.catalog.prepare(outside.selection)).rejects.toThrow(
      /not in the selection's include/,
    );
    await expect(skillsFromConfig({ ...config, configDir: undefined })).rejects.toThrow(
      /relative paths/,
    );
    await expect(skillsFromConfig(parseConfig(base, {}))).resolves.toBeUndefined();
  });
});

describe("chat turns", () => {
  it("prepare skills afresh each turn: a skill loaded earlier must be loaded again before reading", async () => {
    const { runChatTurn } = await import("../src/cli/chat.js");
    const { ChatSession } = await import("../src/cli/session.js");
    const { catalog } = await catalogWithReview();
    const { model, requests } = scripted(
      calls(call("1", "skills_load", { name: "code-review" })),
      text("loaded"),
      calls(call("2", "skills_read", { name: "code-review", path: "references/checklist.md" })),
      text("done"),
    );
    const session = new ChatSession("m", 0, "s");
    const view = {
      waiting() {},
      text() {},
      modelFinished() {},
      toolStarted() {},
      toolFinished() {},
    };
    const options = {
      llm: model,
      tools: [],
      signal: new AbortController().signal,
      view,
      autoApprove: false,
      skills: { catalog, selection: { include: ["code-review"], allowModelSelection: true } },
    };
    expect((await runChatTurn(session, "load it", options)).status).toBe("completed");
    expect((await runChatTurn(session, "now read", options)).status).toBe("completed");
    // The body loaded in turn 1 is still in the transcript, but activation is not.
    expect(JSON.stringify(requests[2]?.messages)).toMatch(/REVIEW-BODY/);
    expect(toolResults(requests[3])["2"]).toMatchObject({
      isError: true,
      content: expect.stringMatching(/not active yet/),
    });
  });
});
