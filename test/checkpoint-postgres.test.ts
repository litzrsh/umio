import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresCheckpointStore,
  postgresSchemaSql,
  type RunListCursor,
  type WorkflowRun,
} from "../src/index.js";
import { checkpointStoreContract } from "./checkpoint-contract.js";
import { pglite, uniquePrefix } from "./support/postgres.js";

let db: Awaited<ReturnType<typeof pglite>>;

beforeAll(async () => {
  db = await pglite();
});
afterAll(async () => {
  await db?.close();
});

checkpointStoreContract("PostgresCheckpointStore (PGlite)", async (now) => {
  const tablePrefix = uniquePrefix();
  await PostgresCheckpointStore.migrate(db, { tablePrefix });
  return new PostgresCheckpointStore({ client: db, tablePrefix, now });
});

const run: WorkflowRun = {
  schemaVersion: 1,
  runId: "r",
  workflowId: "wf",
  definitionVersion: "1",
  definitionHash: "h",
  status: "running",
  input: null,
  nodes: {},
  edges: {},
  revision: 0,
  createdAt: 5,
  updatedAt: 5,
};

describe("PostgresCheckpointStore (PGlite)", () => {
  it("migrates idempotently, into a named schema", async () => {
    const options = { schema: "umio_test", tablePrefix: uniquePrefix() };
    await PostgresCheckpointStore.migrate(db, options);
    await PostgresCheckpointStore.migrate(db, options);
    const store = new PostgresCheckpointStore({ client: db, ...options });
    await store.create(run, "a", 30_000);
    await expect(store.load("r")).resolves.toEqual(run);
    const { rows } = await db.query(
      `SELECT version FROM umio_test.${options.tablePrefix}schema_migrations`,
    );
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("uses the database clock by default", async () => {
    const tablePrefix = uniquePrefix();
    await PostgresCheckpointStore.migrate(db, { tablePrefix });
    const store = new PostgresCheckpointStore({ client: db, tablePrefix });
    const before = Date.now();
    const lease = await store.create(run, "a", 30_000);
    expect(lease.expiresAt).toBeGreaterThanOrEqual(before + 30_000 - 1_000);
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000 + 1_000);
    const renewed = await store.renewLease(lease, 60_000);
    expect(renewed?.expiresAt).toBeGreaterThan(lease.expiresAt);
  });

  it("keeps records verbatim (json, not jsonb): key order, NUL characters", async () => {
    const tablePrefix = uniquePrefix();
    await PostgresCheckpointStore.migrate(db, { tablePrefix });
    const store = new PostgresCheckpointStore({ client: db, tablePrefix, now: () => 0 });
    const odd = { ...run, input: { z: 1, a: "nul\u0000byte", n: 1.5 } };
    await store.create(odd, "a", 30_000);
    const loaded = await store.load("r");
    expect(loaded).toEqual(odd);
    expect(Object.keys(loaded?.input as object)).toEqual(["z", "a", "n"]);
  });

  it("snapshots runs with lease, cancel and decision state", async () => {
    const tablePrefix = uniquePrefix();
    await PostgresCheckpointStore.migrate(db, { tablePrefix });
    let time = 1_000;
    const store = new PostgresCheckpointStore({ client: db, tablePrefix, now: () => time });
    await store.create(run, "owner", 30_000);
    await store.create({ ...run, runId: "s", status: "paused", schemaVersion: 2 }, "o", 1);
    await store.requestCancel("r");
    await store.recordDecision("s", { requestId: "q", nodeId: "n", approved: true, decidedAt: 3 });
    time = 2_000;
    const [paused, running] = [await store.snapshot("s"), await store.snapshot("r")];
    expect(running).toMatchObject({
      cancelRequested: true,
      leaseActive: true,
      lease: { ownerId: "owner", expiresAt: 31_000 },
      decisions: [],
    });
    expect(paused).toMatchObject({ leaseActive: false, decisions: [{ requestId: "q" }] });
    expect((await store.snapshots({ status: "paused" })).map((item) => item.record.runId)).toEqual([
      "s",
    ]);
    await expect(store.snapshot("missing")).resolves.toBeUndefined();
  });

  it("rejects unsafe identifiers", () => {
    expect(() => postgresSchemaSql({ tablePrefix: "x; drop table y" })).toThrow(/tablePrefix/);
    expect(() => new PostgresCheckpointStore({ client: db, schema: "A-B" })).toThrow(/schema/);
  });

  describe("listing is complete and paginated (fix 2026-09-27 #3)", () => {
    const waiting = (
      runId: string,
      status: WorkflowRun["status"],
      updatedAt: number,
    ): WorkflowRun => ({
      ...run,
      schemaVersion: 2,
      runId,
      status,
      updatedAt,
      nodes: {
        gate: {
          nodeId: "gate",
          status: "waiting",
          attempt: 0,
          approval: {
            requestId: `req-${runId}`,
            requestedAt: 1,
            title: "Go?",
            context: [],
            onReject: "fail",
          },
        },
      },
    });

    async function seeded(extra: WorkflowRun[], completed = 1_000) {
      const tablePrefix = uniquePrefix();
      await PostgresCheckpointStore.migrate(db, { tablePrefix });
      const store = new PostgresCheckpointStore({ client: db, tablePrefix, now: () => 0 });
      for (const item of extra) await store.create(item, "o", 1);
      // Newer, unrelated runs: more than a page, more than the old 1 000-row default.
      await db.query(
        `INSERT INTO ${tablePrefix}runs (run_id, instance, record, schema_version, workflow_id, status,
                                         revision, created_at, updated_at)
         SELECT 'done-' || lpad(i::text, 5, '0'), 'i', json_build_object(
                  'schemaVersion', 1, 'runId', 'done-' || lpad(i::text, 5, '0'), 'workflowId', 'wf',
                  'definitionVersion', '1', 'definitionHash', 'h', 'status', 'completed', 'input', null,
                  'nodes', '{}'::json, 'edges', '{}'::json, 'revision', 0, 'createdAt', 0,
                  'updatedAt', 10000 + i),
                1, 'wf', 'completed', 0, 0, 10000 + i
         FROM generate_series(1, $1::int) AS i`,
        [completed],
      );
      return store;
    }

    it("finds an old waiting approval behind 1 000 newer runs, in running, paused and recovery runs", async () => {
      const store = await seeded([
        waiting("old-paused", "paused", 5),
        waiting("old-running", "running", 6),
        waiting("old-recovery", "needs-recovery", 7),
        // A terminal run is never awaiting approval, whatever its nodes say.
        waiting("old-cancelled", "cancelled", 8),
      ]);
      expect((await store.snapshots()).length).toBe(1_004);
      const approvals = await store.snapshots({ awaitingApproval: true });
      expect(approvals.map((item) => item.record.runId)).toEqual([
        "old-recovery",
        "old-running",
        "old-paused",
      ]);
      const recovery = await store.snapshots({ status: "needs-recovery" });
      expect(recovery.map((item) => item.record.runId)).toEqual(["old-recovery"]);
      await expect(store.snapshot("old-paused")).resolves.toMatchObject({
        record: { runId: "old-paused" },
      });
    });

    it("pages deterministically, without duplicates or gaps, including runs with equal timestamps", async () => {
      // 30 matching runs, ten sharing each timestamp, behind 1 000 others.
      const extra = Array.from({ length: 30 }, (_, index) =>
        waiting(`w-${String(index).padStart(2, "0")}`, "paused", 100 + Math.floor(index / 10)),
      );
      const store = await seeded(extra);
      const seen: string[] = [];
      let after: RunListCursor | undefined;
      let pages = 0;
      do {
        const page = await store.listRuns({
          awaitingApproval: true,
          limit: 7,
          ...(after && { after }),
        });
        seen.push(...page.runs.map((item) => item.record.runId));
        after = page.next;
        pages += 1;
      } while (after);
      expect(pages).toBe(5);
      expect(new Set(seen).size).toBe(30);
      // Newest first, ties by run ID.
      const expected = [...extra]
        .sort((a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId))
        .map((item) => item.runId);
      expect(seen).toEqual(expected);
      // Traversing everything twice gives the same order.
      const all = (await store.snapshots({ pageSize: 13 })).map((item) => item.record.runId);
      expect(all).toHaveLength(1_030);
      expect(new Set(all).size).toBe(1_030);
      expect((await store.snapshots({ pageSize: 1_000 })).map((item) => item.record.runId)).toEqual(
        all,
      );
      await expect(store.listRuns({ limit: 0 })).rejects.toThrow(/limit/);
    });
  });
});
