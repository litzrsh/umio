import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdrStore, adrTools, executeToolCall, Toolset } from "../src/index.js";

async function storeWith(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "umio-adr-"));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return { store: new AdrStore(dir), dir };
}

const nygard = `# 1. Record architecture decisions

Date: 2026-01-10

## Status

Accepted

## Context

We need to record decisions.

## Decision

We will use ADRs.

## Consequences

More writing.
`;

const inlineStatus = `# ADR-0002: Use PostgreSQL
Status: Superseded by ADR-0003

Details.`;

const proposed = `# 3. Use SQLite for local mode

## Status

Proposed
`;

describe("AdrStore", () => {
  it("parses Nygard-style records and common variants", async () => {
    const { store } = await storeWith({
      "0001-record-architecture-decisions.md": nygard,
      "0002-use-postgresql.md": inlineStatus,
      "0003-use-sqlite.md": proposed,
      "README.md": "not an ADR",
    });
    const records = await store.list();
    expect(records.map(({ number, title, status }) => ({ number, title, status }))).toEqual([
      { number: 1, title: "Record architecture decisions", status: "Accepted" },
      { number: 2, title: "Use PostgreSQL", status: "Superseded by ADR-0003" },
      { number: 3, title: "Use SQLite for local mode", status: "Proposed" },
    ]);
    expect(records[0]?.date).toBe("2026-01-10");
  });

  it("treats a missing directory as empty", async () => {
    await expect(new AdrStore("/nonexistent/umio/adr").list()).resolves.toEqual([]);
  });

  it("builds binding context from accepted records only", async () => {
    const { store } = await storeWith({ "0001-a.md": nygard, "0003-b.md": proposed });
    const context = await store.context();
    expect(context).toContain("binding for this project");
    expect(context).toContain('<adr number="1" status="Accepted">');
    expect(context).not.toContain("SQLite");
    await expect(store.context(["Rejected"])).resolves.toBeUndefined();
  });

  it("proposes records with the next number and a Nygard template", async () => {
    const { store, dir } = await storeWith({ "0001-a.md": nygard });
    const adr = await store.propose(
      {
        title: "Cache responses per project",
        context: "Token costs are high.",
        decision: "We will store responses in .umio/cache.",
        consequences: "Stale answers are possible.",
        supersedes: 1,
      },
      new Date("2026-09-26T12:00:00Z"),
    );

    expect(adr).toMatchObject({
      number: 2,
      file: "0002-cache-responses-per-project.md",
      status: "Proposed (supersedes ADR-0001)",
    });
    const written = await readFile(join(dir, adr.file), "utf8");
    expect(written).toContain("# 2. Cache responses per project");
    expect(written).toContain("Date: 2026-09-26");
    expect(written).toContain("## Decision\n\nWe will store responses in .umio/cache.");
    await expect(store.get(2)).resolves.toMatchObject({ status: "Proposed (supersedes ADR-0001)" });
  });

  it("allocates distinct numbers for concurrent proposals", async () => {
    const { store } = await storeWith({});
    const proposal = { title: "T", context: "c", decision: "d", consequences: "q" };
    const results = await Promise.all([store.propose(proposal), store.propose(proposal)]);
    expect(results.map((adr) => adr.number).sort()).toEqual([1, 2]);
  });
});

describe("adrTools", () => {
  it("lists, reads and proposes through tool calls", async () => {
    const { store } = await storeWith({ "0001-a.md": nygard, "0003-b.md": proposed });
    const proposedAdrs: number[] = [];
    const tools = new Toolset(
      adrTools(store, { onPropose: (adr) => void proposedAdrs.push(adr.number) }),
    );
    const call = (name: string, input: unknown) =>
      executeToolCall({ type: "tool-call", id: "c", name, input }, tools, { messages: [] });

    expect((await call("list_adrs", { status: "Accepted" })).result.content).toBe(
      "ADR-1: Record architecture decisions [Accepted]",
    );
    expect((await call("read_adr", { number: 1 })).result.content).toBe(nygard);
    expect((await call("read_adr", { number: 9 })).result).toMatchObject({ isError: true });

    const created = await call("propose_adr", {
      title: "Adopt Zod",
      context: "c",
      decision: "d",
      consequences: "q",
    });
    expect(created.result.content).toMatch(/Created ADR-4 "Adopt Zod" with status Proposed/);
    expect(proposedAdrs).toEqual([4]);
    expect(tools.get("propose_adr")?.annotations?.readOnly).toBeUndefined();
    expect(tools.get("list_adrs")?.annotations?.readOnly).toBe(true);
  });
});
