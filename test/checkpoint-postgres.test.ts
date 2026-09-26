import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCheckpointStore, postgresSchemaSql, type WorkflowRun } from "../src/index.js";
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
});
