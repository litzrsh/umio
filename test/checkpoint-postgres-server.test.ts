/**
 * PostgresCheckpointStore against a real server, with several clients (pools,
 * i.e. separate connections) and several processes racing on the same rows.
 * Skipped unless UMIO_TEST_POSTGRES_URL is set (see test/support/postgres.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  type Lease,
  PostgresCheckpointStore,
  WorkflowExecutor,
  type WorkflowRun,
} from "../src/index.js";
import { checkpointStoreContract } from "./checkpoint-contract.js";
import { POSTGRES_URL, pool, uniquePrefix } from "./support/postgres.js";

const pools: pg.Pool[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];
const client = (max = 4) => {
  const created = pool(max);
  pools.push(created);
  return created;
};

// Each test's clients are closed after it, so the server's connection limit is never reached.
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(pools.splice(0).map((item) => item.end()));
});
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fresh(options: { now?: () => number } = {}) {
  const tablePrefix = uniquePrefix();
  await PostgresCheckpointStore.migrate(client(1), { tablePrefix });
  const make = () => new PostgresCheckpointStore({ client: client(), tablePrefix, ...options });
  return { tablePrefix, make };
}

const record = (runId = "run", revision = 0): WorkflowRun => ({
  schemaVersion: 1,
  runId,
  workflowId: "wf",
  definitionVersion: "1",
  definitionHash: "h",
  status: "running",
  input: null,
  nodes: {},
  edges: {},
  revision,
  createdAt: 0,
  updatedAt: 0,
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe.skipIf(!POSTGRES_URL)("PostgresCheckpointStore on a server", () => {
  checkpointStoreContract("PostgresCheckpointStore (server)", async (now) => {
    const { make } = await fresh({ now });
    return make();
  });

  it("migrations race safely from several clients", async () => {
    const tablePrefix = uniquePrefix();
    await Promise.all(
      Array.from({ length: 6 }, () => PostgresCheckpointStore.migrate(client(1), { tablePrefix })),
    );
    const store = new PostgresCheckpointStore({ client: client(), tablePrefix });
    await store.create(record(), "a", 1_000);
    await expect(store.load("run")).resolves.toEqual(record());
  });

  it("exactly one of many clients acquires an expired lease, with a strictly higher token", async () => {
    const { make } = await fresh();
    const first = make();
    const initial = await first.create(record(), "owner-0", 50); // expires in 50 ms by the database clock
    await sleep(120);
    const stores = Array.from({ length: 12 }, make);
    const leases = await Promise.all(
      stores.map((store, index) => store.acquireLease("run", `owner-${index + 1}`, 30_000)),
    );
    const won = leases.filter((lease): lease is Lease => lease !== undefined);
    expect(won).toHaveLength(1);
    expect(won[0]?.token).toBeGreaterThan(initial.token);
    // The loser can neither write nor renew; the winner can.
    await expect(first.compareAndSwap(record("run", 1), 0, initial)).resolves.toBe("lease-lost");
    await expect(first.renewLease(initial, 30_000)).resolves.toBeUndefined();
    const winner = won[0] as Lease;
    await expect(make().compareAndSwap(record("run", 1), 0, winner)).resolves.toBe("ok");
  });

  it("exactly one of many concurrent compare-and-swaps on one revision wins", async () => {
    const { make } = await fresh();
    const lease = await make().create(record(), "owner", 30_000);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        make().compareAndSwap({ ...record("run", 1), input: index }, 0, lease),
      ),
    );
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(results.filter((result) => result === "revision-conflict")).toHaveLength(15);
    const stored = await make().load("run");
    expect(stored?.revision).toBe(1);
    expect(results[stored?.input as number]).toBe("ok");
  });

  it("a paused (zombie) owner is fenced off once its lease expired and another took over", async () => {
    const { make } = await fresh();
    const zombie = make();
    const old = await zombie.create(record(), "zombie", 100);
    await sleep(200); // the zombie's event loop "stalls" past its TTL
    const next = await make().acquireLease("run", "successor", 30_000);
    expect(next).toBeDefined();
    await expect(zombie.renewLease(old, 30_000)).resolves.toBeUndefined();
    await expect(zombie.compareAndSwap(record("run", 1), 0, old)).resolves.toBe("lease-lost");
    await expect(make().load("run")).resolves.toEqual(record());
  });

  it("fencing tokens stay monotonic across clients, releases and a deleted and re-created run", async () => {
    const { make } = await fresh();
    const tokens: number[] = [];
    let lease = await make().create(record(), "a", 30_000);
    tokens.push(lease.token);
    for (let index = 0; index < 5; index++) {
      await make().releaseLease(lease);
      lease = (await make().acquireLease("run", `o${index}`, 30_000)) as Lease;
      tokens.push(lease.token);
    }
    await make().delete("run");
    tokens.push((await make().create(record(), "b", 30_000)).token);
    for (let index = 1; index < tokens.length; index++) {
      expect(tokens[index]).toBeGreaterThan(tokens[index - 1] as number);
    }
    // The pre-delete lease cannot write the new run, even with a matching owner name.
    await expect(
      make().compareAndSwap(record("run", 1), 0, { ...lease, ownerId: "b" }),
    ).resolves.toBe("lease-lost");
  });

  it("exactly one of many concurrent decisions for a request is recorded", async () => {
    const { make } = await fresh();
    await make().create(record(), "owner", 30_000);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        make().recordDecision("run", {
          requestId: "req",
          nodeId: "approve",
          approved: index % 2 === 0,
          decidedAt: index,
          decidedBy: `client ${index}`,
        }),
      ),
    );
    const recorded = results.filter((result) => result.outcome === "recorded");
    expect(recorded).toHaveLength(1);
    for (const result of results) expect(result.decision).toEqual(recorded[0]?.decision);
    await expect(make().loadDecisions("run")).resolves.toEqual([recorded[0]?.decision]);
  });

  it("lists every matching run in stable pages behind many newer runs (fix 2026-09-27 #3)", async () => {
    const { tablePrefix, make } = await fresh();
    const db = client(1);
    // 450 paused runs waiting for approval (150 per timestamp), then 1 000 newer completed runs.
    await db.query(
      `INSERT INTO ${tablePrefix}runs (run_id, instance, record, schema_version, workflow_id, status,
                                       revision, created_at, updated_at)
       SELECT 'w-' || lpad(i::text, 4, '0'), 'i', json_build_object('schemaVersion', 2,
                'runId', 'w-' || lpad(i::text, 4, '0'), 'workflowId', 'wf', 'definitionVersion', '1',
                'definitionHash', 'h', 'status', 'paused', 'input', null,
                'nodes', json_build_object('gate', json_build_object('nodeId', 'gate',
                  'status', 'waiting', 'attempt', 0)),
                'edges', '{}'::json, 'revision', 0, 'createdAt', 0, 'updatedAt', i / 150),
              2, 'wf', 'paused', 0, 0, i / 150
       FROM generate_series(0, 449) AS i
       UNION ALL
       SELECT 'd-' || i, 'i', json_build_object('schemaVersion', 1, 'runId', 'd-' || i,
                'workflowId', 'wf', 'definitionVersion', '1', 'definitionHash', 'h',
                'status', 'completed', 'input', null, 'nodes', '{}'::json, 'edges', '{}'::json,
                'revision', 0, 'createdAt', 0, 'updatedAt', 100 + i),
              1, 'wf', 'completed', 0, 0, 100 + i
       FROM generate_series(1, 1000) AS i`,
    );
    const store = make();
    const first = (await store.snapshots({ awaitingApproval: true, pageSize: 100 })).map(
      (item) => item.record.runId,
    );
    expect(first).toHaveLength(450);
    expect(new Set(first).size).toBe(450);
    const again = (await store.snapshots({ awaitingApproval: true, pageSize: 37 })).map(
      (item) => item.record.runId,
    );
    expect(again).toEqual(first);
    expect(await store.snapshots({ status: "completed" })).toHaveLength(1_000);
  });

  it("a cancel from another client reaches the owner through the flag, and cancel() finalizes an unowned run", async () => {
    const { make } = await fresh();
    await make().create(record(), "owner", 100);
    await make().requestCancel("run");
    await expect(make().isCancelRequested("run")).resolves.toBe(true);
    await sleep(200);
    const ack = await new WorkflowExecutor({ store: make() }).cancel("run");
    expect(ack).toEqual({ runId: "run", outcome: "cancelled", status: "cancelled" });
  });
});

describe.skipIf(!POSTGRES_URL)("PostgresCheckpointStore across processes", () => {
  const MAIN = resolve(__dirname, "fixtures/pg-worker.ts");
  const TSX = pathToFileURL(resolve(__dirname, "../node_modules/tsx/dist/loader.mjs")).href;

  function worker(args: string[]): {
    child: ChildProcess;
    result: Promise<Record<string, unknown>>;
  } {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk;
    });
    // A killed worker prints nothing: its result says so instead of rejecting.
    const result = new Promise<Record<string, unknown>>((done) =>
      child.on("exit", (code, signal) => {
        const line = out.trim().split("\n").at(-1);
        done(
          line
            ? (JSON.parse(line) as Record<string, unknown>)
            : { error: "no-output", code, signal, stderr: err },
        );
      }),
    );
    return { child, result };
  }

  async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== undefined) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  it("the owning process notices another client's cancel within the ~2 s poll, during a silent node", async () => {
    const { tablePrefix, make } = await fresh();
    const owner = worker(["run-silent", tablePrefix, "x1"]);
    const store = make();
    await until(
      async () => ((await store.load("x1"))?.nodes.think?.status === "running" ? true : undefined),
      "the node to start",
    );
    const started = Date.now();
    const ack = await new WorkflowExecutor({ store }).cancel("x1");
    expect(ack.outcome).toBe("requested");
    const result = (await owner.result).value as WorkflowRun;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe("cancelled");
    expect((await store.snapshot("x1"))?.lease).toBeUndefined();
  }, 60_000);

  it("after an owner is killed, exactly one of two racing processes takes the run over", async () => {
    const { tablePrefix, make } = await fresh();
    const owner = worker(["run-silent", tablePrefix, "x2"]);
    const store = make();
    await until(
      async () => ((await store.load("x2"))?.nodes.think?.status === "running" ? true : undefined),
      "the node to start",
    );
    owner.child.kill("SIGKILL");
    await until(
      async () => ((await store.snapshot("x2"))?.leaseActive === false ? true : undefined),
      "the dead owner's lease to expire",
    );
    const [a, b] = [
      worker(["resume-silent", tablePrefix, "x2"]),
      worker(["resume-silent", tablePrefix, "x2"]),
    ];
    const results = await Promise.all([a.result, b.result]);
    const winners = results.filter((result) => result.value !== undefined);
    const losers = results.filter((result) => result.error !== undefined);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.error).toMatch(/LeaseUnavailableError|RunNotResumableError/);
    const final = (await store.load("x2")) as WorkflowRun;
    expect(final.status).toBe("completed");
    // The orphaned attempt was recovered exactly once (recovery: "retry"): attempt 2 only.
    expect(final.nodes.think).toMatchObject({ status: "completed", attempt: 2 });
  }, 60_000);

  it("approval across processes: racing approve/reject, one wins, the resumed run applies it once", async () => {
    const { tablePrefix, make } = await fresh();
    const dir = await mkdtemp(join(tmpdir(), "umio-pg-"));
    dirs.push(dir);
    const effects = join(dir, "effects.log");
    const paused = await worker(["run-approval", tablePrefix, "x3", effects]).result;
    expect((paused.value as WorkflowRun).status).toBe("paused");
    const decisions = await Promise.all([
      worker(["approve", tablePrefix, "x3"]).result,
      worker(["reject", tablePrefix, "x3"]).result,
      worker(["approve", tablePrefix, "x3"]).result,
    ]);
    const acks = decisions.map(
      (item) => item.value as { outcome: string; decision: { approved: boolean } },
    );
    expect(acks.filter((ack) => ack.outcome === "recorded")).toHaveLength(1);
    const winner = acks.find((ack) => ack.outcome === "recorded")?.decision;
    for (const ack of acks) expect(ack.decision).toEqual(winner);
    // Two processes resume at once: one applies the decision, the other finds it owned or done.
    const resumed = await Promise.all([
      worker(["resume-approval", tablePrefix, "x3", effects]).result,
      worker(["resume-approval", tablePrefix, "x3", effects]).result,
    ]);
    expect(resumed.filter((item) => item.value !== undefined).length).toBeGreaterThanOrEqual(1);
    const final = (await make().load("x3")) as WorkflowRun;
    expect(final.status).toBe(winner?.approved ? "completed" : "failed");
    const log = (await worker(["effects", tablePrefix, "x3", effects]).result).value as string[];
    expect(log).toEqual(winner?.approved ? ["x3:deploy"] : []);
  }, 60_000);
});
