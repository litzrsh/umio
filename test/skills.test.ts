/**
 * Skill catalogs, parsing, selection and bounded resource reads.
 */
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSkillCatalog,
  type PreparedSkills,
  SkillCatalogError,
  SkillChangedError,
  SkillLimitError,
  SkillSelectionError,
  type Tool,
} from "../src/index.js";
import { cleanup, skillDocument, tempRoot, writeTree } from "./support/skills.js";

afterEach(cleanup);

const context = { toolCallId: "c1", messages: [] };

/** Runs a prepared tool the way the tool loop would: errors thrown become error results. */
async function invoke(prepared: PreparedSkills, name: string, input: unknown) {
  const found = prepared.tools.find((item) => item.name === name) as Tool | undefined;
  if (!found) throw new Error(`no tool ${name}`);
  const parsed = found.parseInput(input);
  if (!parsed.success) return { error: parsed.error };
  try {
    return { value: (await found.execute(parsed.data, context)) as string };
  } catch (error) {
    return { error: (error as Error).message, errorType: (error as Error).constructor.name };
  }
}

async function reviewSkills() {
  const root = await tempRoot();
  await writeTree(root, {
    "skills/code-review/SKILL.md": skillDocument(
      "code-review",
      "Inspect callers first.\nRead references/checklist.md when checking tests.",
    ),
    "skills/code-review/references/checklist.md": "- regression test\n- failure scenario\n",
    "skills/code-review/scripts/check.sh": "#!/bin/sh\necho check\n",
    "skills/test-design/SKILL.md": skillDocument("test-design", "Prefer fake clocks."),
    "skills/notes/README.md": "not a skill: no SKILL.md",
  });
  return root;
}

describe("catalog", () => {
  it("lists valid skills in name order with digests, scanning roots one level deep", async () => {
    const root = await reviewSkills();
    await writeTree(root, {
      "skills/code-review/nested/deeper/SKILL.md": skillDocument("deeper", "x"),
    });
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.list()).toEqual([
      {
        name: "code-review",
        description: "code-review guidance for tests.",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        name: "test-design",
        description: "test-design guidance for tests.",
        digest: expect.any(String),
      },
    ]);
    const loaded = await catalog.load("code-review");
    expect(loaded.body).toBe(
      "Inspect callers first.\nRead references/checklist.md when checking tests.",
    );
  });

  it("reports every invalid package with its file and field, and prepare() refuses the catalog", async () => {
    const root = await tempRoot();
    await writeTree(root, {
      "a/no-frontmatter/SKILL.md": "Just text.",
      "a/bad-yaml/SKILL.md": "---\nname: [bad-yaml\n---\nbody",
      "a/dup-keys/SKILL.md": "---\nname: dup-keys\nname: dup-keys\ndescription: d\n---\nbody",
      "a/unknown-field/SKILL.md": skillDocument("unknown-field", "body", "version: 2\n"),
      "a/Bad_Name/SKILL.md": skillDocument("Bad_Name", "body"),
      "a/mismatch/SKILL.md": skillDocument("other-name", "body"),
      "a/empty-body/SKILL.md": skillDocument("empty-body", "   "),
      "a/no-description/SKILL.md": "---\nname: no-description\n---\nbody",
      "a/long-description/SKILL.md": `---\nname: long-description\ndescription: ${"x".repeat(1_025)}\n---\nbody`,
      "a/aliases/SKILL.md": "---\nname: &n aliases\ndescription: *n\n---\nbody",
      "a/tagged/SKILL.md": "---\nname: !custom tagged\ndescription: d\n---\nbody",
      "a/binary/SKILL.md": Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x00]),
      "a/good/SKILL.md": skillDocument("good", "fine"),
      "b/good/SKILL.md": skillDocument("good", "a second one"),
    });
    const catalog = await loadSkillCatalog({ roots: ["a", "b", "missing"], baseDir: root });
    const found = catalog.diagnostics.map((item) => [
      item.path.slice(root.length + 1),
      item.field ?? "",
      item.message,
    ]);
    expect(found).toEqual(
      expect.arrayContaining([
        ["a/no-frontmatter/SKILL.md", "", "must start with YAML frontmatter between --- lines"],
        ["a/bad-yaml/SKILL.md", "", expect.stringMatching(/^invalid frontmatter/)],
        ["a/dup-keys/SKILL.md", "", expect.stringMatching(/Map keys must be unique/)],
        ["a/unknown-field/SKILL.md", "version", "is not a supported field"],
        ["a/Bad_Name/SKILL.md", "name", expect.stringMatching(/lowercase letters/)],
        ["a/mismatch/SKILL.md", "name", '"other-name" must match its directory name "mismatch"'],
        ["a/empty-body/SKILL.md", "", "has no instructions after the frontmatter"],
        ["a/no-description/SKILL.md", "description", "is required and must be a nonempty string"],
        ["a/long-description/SKILL.md", "description", "is 1025 characters; the limit is 1024"],
        ["a/aliases/SKILL.md", "", "invalid frontmatter: anchors and aliases are not allowed"],
        ["a/tagged/SKILL.md", "", expect.stringMatching(/^invalid frontmatter/)],
        ["a/binary/SKILL.md", "", "is not UTF-8 text"],
        ["b/good/SKILL.md", "name", expect.stringMatching(/^duplicate skill "good"/)],
        ["missing", "", "skill root does not exist"],
      ]),
    );
    // A duplicated name is not silently resolved in favor of either package.
    expect(catalog.list()).toEqual([]);
    await expect(catalog.prepare({ include: [] })).rejects.toBeInstanceOf(SkillCatalogError);
  });

  it("enforces the document size and catalog entry limits, and never follows linked skill directories", async () => {
    const root = await tempRoot();
    await writeTree(root, {
      "s/big/SKILL.md": skillDocument("big", "x".repeat(500)),
      "s/one/SKILL.md": skillDocument("one", "1"),
      "s/two/SKILL.md": skillDocument("two", "2"),
      "elsewhere/linked/SKILL.md": skillDocument("linked", "l"),
    });
    await symlink(join(root, "elsewhere/linked"), join(root, "s/linked"));
    const catalog = await loadSkillCatalog({
      roots: ["s"],
      baseDir: root,
      limits: { maxDocumentBytes: 200, maxCatalogEntries: 1 },
    });
    expect(catalog.diagnostics.map((item) => item.message)).toEqual([
      expect.stringMatching(/bytes; the limit is 200 \(maxDocumentBytes\)/),
      "symbolic links to skill directories are not followed",
      "2 skills found; the limit is 1 (maxCatalogEntries)",
    ]);
    await expect(
      loadSkillCatalog({ roots: ["s"], baseDir: root, limits: { maxReadBytes: 0 } }),
    ).rejects.toThrow(/maxReadBytes must be a positive integer/);
  });

  it("rejects a SKILL.md that changed after the catalog was loaded", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    await writeFile(
      join(root, "skills/code-review/SKILL.md"),
      skillDocument("code-review", "New."),
    );
    await expect(catalog.load("code-review")).rejects.toBeInstanceOf(SkillChangedError);
    await expect(
      catalog.prepare({ include: ["code-review"], activate: ["code-review"] }),
    ).rejects.toThrow(/changed since the catalog was loaded/);
  });
});

describe("selection and prompt composition", () => {
  it("activates explicitly: bodies in name order, deduplicated, with digest and resource instructions", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const prepared = await catalog.prepare({
      include: ["test-design", "code-review", "code-review"],
      activate: ["test-design", "code-review", "test-design"],
    });
    expect(prepared.context).toHaveLength(1);
    const [text] = prepared.context;
    expect(text).toMatch(/^# Skills\n\nSkills are task guidance provided by the application\./);
    expect(text).toMatch(/cannot grant tools, permissions or approvals/);
    const review = text?.indexOf('<skill name="code-review" digest="sha256:') ?? -1;
    const design = text?.indexOf('<skill name="test-design"') ?? -1;
    expect(review).toBeGreaterThan(0);
    expect(design).toBeGreaterThan(review);
    expect(text).not.toMatch(/skills_load/);
    expect(prepared.tools.map((item) => item.name)).toEqual(["skills_read"]);
    expect(prepared.tools[0]?.annotations).toEqual({ readOnly: true, idempotent: true });
    expect(prepared.usage().map((item) => item.name)).toEqual(["code-review", "test-design"]);
  });

  it("an empty include permits nothing; unknown names and activation outside include fail before any model call", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const none = await catalog.prepare({ include: [], allowModelSelection: true });
    expect(none).toMatchObject({ context: [], tools: [] });
    const included = await catalog.prepare({ include: ["code-review"] });
    expect(included).toMatchObject({ context: [], tools: [] }); // not advertised without model selection
    await expect(catalog.prepare({ include: ["nope"] })).rejects.toThrow(
      'Unknown skill "nope". Available: code-review, test-design.',
    );
    await expect(
      catalog.prepare({ include: ["code-review"], activate: ["test-design"] }),
    ).rejects.toBeInstanceOf(SkillSelectionError);
    await expect(catalog.prepare({ include: "code-review" as never })).rejects.toThrow(
      /include must be a list/,
    );
  });

  it("with model selection, lists summaries without bodies and loads only permitted skills", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const prepared = await catalog.prepare({ include: ["code-review"], allowModelSelection: true });
    const [text] = prepared.context;
    expect(text).toMatch(/- code-review: code-review guidance for tests\./);
    expect(text).not.toMatch(/Inspect callers first/);
    expect(text).not.toMatch(/test-design/);
    expect(prepared.tools.map((item) => item.name)).toEqual(["skills_load", "skills_read"]);

    // Resources need activation first.
    expect(
      await invoke(prepared, "skills_read", {
        name: "code-review",
        path: "references/checklist.md",
      }),
    ).toEqual({
      error:
        'Skill "code-review" is not active yet: load it with skills_load first, then read its files.',
      errorType: "SkillError",
    });
    expect(await invoke(prepared, "skills_load", { name: "test-design" })).toMatchObject({
      error: 'Skill "test-design" is not available here. Available: code-review.',
    });
    const loaded = await invoke(prepared, "skills_load", { name: "code-review" });
    expect(loaded.value).toMatch(
      /^<skill name="code-review" digest="sha256:[0-9a-f]{64}">\nInspect callers first\./,
    );
    expect(
      await invoke(prepared, "skills_read", {
        name: "code-review",
        path: "references/checklist.md",
      }),
    ).toEqual({
      value: "- regression test\n- failure scenario\n",
    });
    const usage = prepared.usage();
    expect(usage).toEqual([
      {
        name: "code-review",
        documentDigest: catalog.list()[0]?.digest,
        resources: [
          { path: "references/checklist.md", digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
        ],
      },
    ]);
    // Snapshots are immutable.
    expect(() => (usage as unknown as unknown[]).push(1)).toThrow();
    expect(Object.isFrozen(usage[0]?.resources)).toBe(true);
  });

  it("keeps activation, budgets and usage per preparation", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const selection = { include: ["code-review"], allowModelSelection: true };
    const [first, second] = [await catalog.prepare(selection), await catalog.prepare(selection)];
    await invoke(first, "skills_load", { name: "code-review" });
    expect(
      (await invoke(second, "skills_read", { name: "code-review", path: "scripts/check.sh" }))
        .error,
    ).toMatch(/not active yet/);
    expect(second.usage()).toEqual([]);
    expect(first.usage()).toHaveLength(1);
  });

  it("rejects a preparation over maxContextBytes instead of truncating", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({
      roots: ["skills"],
      baseDir: root,
      limits: { maxContextBytes: 100 },
    });
    await expect(
      catalog.prepare({ include: ["code-review"], activate: ["code-review"] }),
    ).rejects.toBeInstanceOf(SkillLimitError);
  });

  it("honors cancellation during preparation", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      catalog.prepare(
        { include: ["code-review"], activate: ["code-review"] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("stop");
  });
});

describe("resources", () => {
  async function active(limits = {}) {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root, limits });
    const events: unknown[] = [];
    const prepared = await catalog.prepare(
      { include: ["code-review"], activate: ["code-review"] },
      { onEvent: (event) => events.push(event) },
    );
    const read = (path: unknown) => invoke(prepared, "skills_read", { name: "code-review", path });
    return { root, catalog, prepared, read, events };
  }

  it("reads text relative to the skill directory, never the working directory", async () => {
    const { read } = await active();
    expect(await read("scripts/check.sh")).toEqual({ value: "#!/bin/sh\necho check\n" });
    expect(await read("references\\checklist.md")).toEqual({
      value: "- regression test\n- failure scenario\n",
    });
    expect((await read("package.json")).error).toBe('"package.json" does not exist in this skill.');
  });

  it("rejects traversal, absolute paths, symbolic links, directories and binary files", async () => {
    const { root, read } = await active();
    await writeFile(join(root, "secret.txt"), "top secret");
    await symlink(join(root, "secret.txt"), join(root, "skills/code-review/references/link.md"));
    await symlink(join(root, "skills/test-design"), join(root, "skills/code-review/linked-dir"));
    await writeFile(
      join(root, "skills/code-review/assets.bin"),
      Buffer.from([0x89, 0x50, 0x00, 0x01]),
    );
    await mkdir(join(root, "skills/code-review/empty-dir"));
    for (const [path, message] of [
      ["../../secret.txt", /must not contain empty, "\." or "\.\." segments/],
      ["references/../../secret.txt", /must not contain/],
      [join(root, "secret.txt"), /is not a relative path/],
      ["C:\\secret.txt", /is not a relative path/],
      ["references/link.md", /goes through a symbolic link/],
      ["linked-dir/SKILL.md", /goes through a symbolic link/],
      ["empty-dir", /is not a regular file/],
      ["assets.bin", /is not UTF-8 text/],
      ["", /nonempty relative path/],
    ] as const) {
      const result = await read(path);
      expect(result.error, path).toMatch(message);
      expect(JSON.stringify(result)).not.toContain("top secret");
    }
  });

  it("enforces per-file and per-invocation byte limits without truncating; failed reads cost nothing", async () => {
    const { root, read, prepared } = await active({ maxResourceBytes: 50, maxReadBytes: 80 });
    await writeFile(join(root, "skills/code-review/big.md"), "x".repeat(51));
    await writeFile(join(root, "skills/code-review/a.md"), "a".repeat(40));
    expect((await read("big.md")).error).toMatch(
      /is 51 bytes; skill files are limited to 50 bytes/,
    );
    expect(await read("a.md")).toEqual({ value: "a".repeat(40) });
    // Repeats count: 40 + 40 = 80 fits, a third does not.
    expect(await read("a.md")).toEqual({ value: "a".repeat(40) });
    expect((await read("a.md")).error).toMatch(/would exceed this invocation's skill read budget/);
    expect(prepared.usage()[0]?.resources).toEqual([{ path: "a.md", digest: expect.any(String) }]);
  });

  it("reserves the budget before reading, so parallel reads cannot oversubscribe it", async () => {
    const { root, read } = await active({ maxReadBytes: 100 });
    for (let index = 0; index < 5; index++) {
      await writeFile(join(root, `skills/code-review/p${index}.md`), "p".repeat(40));
    }
    const results = await Promise.all([0, 1, 2, 3, 4].map((index) => read(`p${index}.md`)));
    expect(results.filter((item) => item.value !== undefined)).toHaveLength(2);
    expect(results.filter((item) => /read budget/.test(item.error ?? ""))).toHaveLength(3);
  });

  it("rejects a file that changed since it was first read in the invocation", async () => {
    const { root, read, events } = await active();
    expect((await read("scripts/check.sh")).value).toBeDefined();
    await writeFile(join(root, "skills/code-review/scripts/check.sh"), "changed");
    expect(await read("scripts/check.sh")).toMatchObject({
      error: "code-review/scripts/check.sh changed since it was first read in this task.",
      errorType: "SkillChangedError",
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "skills-prepared", include: ["code-review"] }),
      expect.objectContaining({
        type: "skill-resource-read",
        path: "scripts/check.sh",
        outcome: "ok",
        bytes: 21,
      }),
      expect.objectContaining({ type: "skill-resource-read", outcome: "error" }),
    ]);
    // Bodies never reach telemetry.
    expect(JSON.stringify(events)).not.toMatch(/Inspect callers/);
  });

  it("a throwing diagnostic callback does not change the outcome", async () => {
    const root = await reviewSkills();
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const prepared = await catalog.prepare(
      { include: ["code-review"], activate: ["code-review"] },
      {
        onEvent: () => {
          throw new Error("telemetry down");
        },
      },
    );
    expect(
      (await invoke(prepared, "skills_read", { name: "code-review", path: "scripts/check.sh" }))
        .value,
    ).toBeDefined();
  });
});

describe("SKILL.md through skills_read is pinned to the catalog version (fix 2026-09-27 01:22 #1)", () => {
  async function demo(selection: { activate?: readonly string[]; allowModelSelection?: boolean }) {
    const root = await tempRoot();
    await writeTree(root, {
      "skills/demo/SKILL.md": skillDocument("demo", "A"),
      "skills/demo/notes.md": "N",
    });
    const catalog = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const prepared = await catalog.prepare({ include: ["demo"], ...selection });
    if (selection.allowModelSelection) await invoke(prepared, "skills_load", { name: "demo" });
    const change = () =>
      writeFile(join(root, "skills/demo/SKILL.md"), skillDocument("demo", "CHANGED INSTRUCTIONS"));
    return { root, catalog, prepared, change };
  }

  for (const [label, selection] of [
    ["explicit activation", { activate: ["demo"] }],
    ["activation through skills_load", { allowModelSelection: true }],
  ] as const) {
    it(`refuses a changed document after ${label}, like catalog.load, and keeps usage consistent`, async () => {
      const { catalog, prepared, change } = await demo(selection);
      const before = prepared.usage();
      await change();
      await expect(catalog.load("demo")).rejects.toBeInstanceOf(SkillChangedError);
      const result = await invoke(prepared, "skills_read", { name: "demo", path: "SKILL.md" });
      expect(result).toMatchObject({ errorType: "SkillChangedError" });
      expect(JSON.stringify(result)).not.toContain("CHANGED INSTRUCTIONS");
      expect(prepared.usage()).toEqual(before);
      expect(prepared.usage()[0]).toMatchObject({
        documentDigest: catalog.list()[0]?.digest,
        resources: [],
      });
    });
  }

  it("returns an unchanged SKILL.md as the verified document, recorded as the document, not a resource", async () => {
    const { catalog, prepared } = await demo({ activate: ["demo"] });
    const result = await invoke(prepared, "skills_read", { name: "demo", path: "SKILL.md" });
    expect(result).toEqual({ value: skillDocument("demo", "A") });
    expect(prepared.usage()).toEqual([
      { name: "demo", documentDigest: catalog.list()[0]?.digest, resources: [] },
    ]);
  });

  it("recognizes the document under another name (a hard link), and still detects ordinary resource changes", async () => {
    const { root, prepared, change } = await demo({ activate: ["demo"] });
    await link(join(root, "skills/demo/SKILL.md"), join(root, "skills/demo/alias.md"));
    expect((await invoke(prepared, "skills_read", { name: "demo", path: "notes.md" })).value).toBe(
      "N",
    );
    await writeFile(join(root, "skills/demo/notes.md"), "N2");
    expect(
      (await invoke(prepared, "skills_read", { name: "demo", path: "notes.md" })).error,
    ).toMatch(/changed since it was first read/);
    await writeFile(
      join(root, "skills/demo/alias.md"),
      skillDocument("demo", "CHANGED INSTRUCTIONS"),
    );
    expect(await invoke(prepared, "skills_read", { name: "demo", path: "alias.md" })).toMatchObject(
      {
        errorType: "SkillChangedError",
      },
    );
    void change;
  });

  it("a new catalog and preparation accept the updated document", async () => {
    const { root, change } = await demo({ activate: ["demo"] });
    await change();
    const fresh = await loadSkillCatalog({ roots: ["skills"], baseDir: root });
    const prepared = await fresh.prepare({ include: ["demo"], activate: ["demo"] });
    expect(prepared.context[0]).toMatch(/CHANGED INSTRUCTIONS/);
    expect(
      (await invoke(prepared, "skills_read", { name: "demo", path: "SKILL.md" })).value,
    ).toMatch(/CHANGED INSTRUCTIONS/);
  });
});

describe("skills_load counts its whole response against maxReadBytes (fix 2026-09-27 01:22 #2)", () => {
  /** A catalog with one `demo` skill whose body has non-ASCII text, and a checklist file. */
  async function demoCatalog(maxReadBytes: number) {
    const root = await tempRoot();
    await writeTree(root, {
      "skills/demo/SKILL.md": skillDocument("demo", "Prüfe ✓ A"),
      "skills/demo/check.md": "0123456789",
    });
    return loadSkillCatalog({ roots: ["skills"], baseDir: root, limits: { maxReadBytes } });
  }
  const selection = { include: ["demo"], allowModelSelection: true };
  async function responseBytes(): Promise<number> {
    const prepared = await (await demoCatalog(1_000_000)).prepare(selection);
    const { value } = await invoke(prepared, "skills_load", { name: "demo" });
    return Buffer.byteLength(value ?? "", "utf8");
  }

  it("a one-byte budget refuses the load: nothing returned, activated, recorded or charged", async () => {
    // The request's reproduction: a one-byte body `A` under a one-byte budget.
    const root = await tempRoot();
    await writeTree(root, {
      "skills/demo/SKILL.md": skillDocument("demo", "A"),
      "skills/demo/check.md": "x",
    });
    const catalog = await loadSkillCatalog({
      roots: ["skills"],
      baseDir: root,
      limits: { maxReadBytes: 1 },
    });
    const events: { type: string; outcome?: string }[] = [];
    const prepared = await catalog.prepare(selection, { onEvent: (event) => events.push(event) });
    const result = await invoke(prepared, "skills_load", { name: "demo" });
    expect(result).toMatchObject({
      errorType: "SkillLimitError",
      error: expect.stringMatching(/read budget/),
    });
    expect(
      (await invoke(prepared, "skills_read", { name: "demo", path: "check.md" })).error,
    ).toMatch(/not active yet/);
    expect(prepared.usage()).toEqual([]);
    expect(events.filter((event) => event.type === "skill-loaded")).toEqual([
      expect.objectContaining({ outcome: "error" }),
    ]);
  });

  it("fits at the exact UTF-8 length of the complete response, and is refused one byte below", async () => {
    const bytes = await responseBytes();
    expect(bytes).toBeGreaterThan(100); // the wrapper and note are counted, not just the body
    const exact = await (await demoCatalog(bytes)).prepare(selection);
    const ok = await invoke(exact, "skills_load", { name: "demo" });
    expect(Buffer.byteLength(ok.value ?? "", "utf8")).toBe(bytes);
    const short = await (await demoCatalog(bytes - 1)).prepare(selection);
    expect((await invoke(short, "skills_load", { name: "demo" })).errorType).toBe(
      "SkillLimitError",
    );
  });

  it("repeated and parallel loads never return more than the budget", async () => {
    const bytes = await responseBytes();
    const prepared = await (await demoCatalog(bytes * 2 + bytes - 1)).prepare(selection);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => invoke(prepared, "skills_load", { name: "demo" })),
    );
    const returned = results.reduce(
      (total, item) => total + Buffer.byteLength(item.value ?? "", "utf8"),
      0,
    );
    expect(results.filter((item) => item.value !== undefined)).toHaveLength(2);
    expect(returned).toBeLessThanOrEqual(bytes * 3 - 1);
  });

  it("loads and reads share one budget; a refused call leaves the rest of it usable", async () => {
    const bytes = await responseBytes();
    const prepared = await (await demoCatalog(bytes + 10)).prepare(selection);
    expect((await invoke(prepared, "skills_load", { name: "demo" })).value).toBeDefined();
    // A second load does not fit (10 bytes left) and is refused without charge…
    expect((await invoke(prepared, "skills_load", { name: "demo" })).errorType).toBe(
      "SkillLimitError",
    );
    // …so the 10-byte file still fits exactly, and then nothing more does.
    expect(await invoke(prepared, "skills_read", { name: "demo", path: "check.md" })).toEqual({
      value: "0123456789",
    });
    expect(
      (await invoke(prepared, "skills_read", { name: "demo", path: "check.md" })).error,
    ).toMatch(/read budget/);
  });

  it("refuses an over-budget load from the file size, before reading its content", async () => {
    const root = await tempRoot();
    await writeTree(root, { "skills/demo/SKILL.md": skillDocument("demo", "A") });
    const catalog = await loadSkillCatalog({
      roots: ["skills"],
      baseDir: root,
      limits: { maxReadBytes: 1 },
    });
    const prepared = await catalog.prepare(selection);
    // The content changed too, but the budget check comes first: no content was read.
    await writeFile(join(root, "skills/demo/SKILL.md"), skillDocument("demo", "B"));
    expect((await invoke(prepared, "skills_load", { name: "demo" })).errorType).toBe(
      "SkillLimitError",
    );
  });
});
