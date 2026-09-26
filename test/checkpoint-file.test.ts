import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CheckpointStoreLockedError,
  FileCheckpointStore,
  WorkflowExecutor,
  type WorkflowRun,
} from "../src/index.js";
import { checkpointStoreContract } from "./checkpoint-contract.js";
import { FakeClock } from "./support/fake-clock.js";
import { controlled, graph, nodes, recorder, track } from "./support/graph.js";

const dirs: string[] = [];
const stores: FileCheckpointStore[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "umio-checkpoints-"));
  dirs.push(dir);
  return dir;
}

async function openStore(dir: string, now?: () => number): Promise<FileCheckpointStore> {
  const store = await FileCheckpointStore.open({ dir, ...(now && { now }) });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

checkpointStoreContract("FileCheckpointStore", async (now) => openStore(await tempDir(), now));

const record: WorkflowRun = {
  schemaVersion: 1,
  runId: "../run/1",
  workflowId: "wf",
  definitionVersion: "1",
  definitionHash: "hash",
  status: "running",
  input: null,
  nodes: {},
  edges: {},
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
};

describe("FileCheckpointStore", () => {
  it("survives a restart: records, tokens and cancel requests are read back", async () => {
    const dir = await tempDir();
    let time = 0;
    const first = await openStore(dir, () => time);
    const lease = await first.create(record, "owner-a", 30_000);
    await first.compareAndSwap({ ...record, revision: 1 }, 0, lease);
    await first.requestCancel(record.runId);
    await first.close();

    const second = await openStore(dir, () => time);
    await expect(second.load(record.runId)).resolves.toEqual({ ...record, revision: 1 });
    await expect(second.isCancelRequested(record.runId)).resolves.toBe(true);
    // The old lease is still on disk: no takeover before it expires.
    await expect(second.acquireLease(record.runId, "owner-b", 30_000)).resolves.toBeUndefined();
    time = 30_000;
    const next = await second.acquireLease(record.runId, "owner-b", 30_000);
    expect(next?.token).toBe(2);
    await expect(second.compareAndSwap({ ...record, revision: 2 }, 1, lease)).resolves.toBe(
      "lease-lost",
    );
  });

  it("snapshots read runs without opening the store, while another instance holds it", async () => {
    const dir = await tempDir();
    const store = await openStore(dir, () => 1_000);
    const lease = await store.create(record, "owner-a", 30_000);
    await store.create({ ...record, runId: "other" }, "owner-a", 30_000);
    await store.releaseLease({ ...lease, runId: "other", token: 1 });
    await store.requestCancel(record.runId);

    await expect(FileCheckpointStore.snapshot(dir, record.runId)).resolves.toEqual({
      record,
      cancelRequested: true,
      lease: { ownerId: "owner-a", expiresAt: 31_000 },
      instance: expect.any(String),
    });
    const all = await FileCheckpointStore.snapshots(dir);
    expect(all.map((run) => [run.record.runId, run.lease?.ownerId])).toEqual([
      ["../run/1", "owner-a"],
      ["other", undefined],
    ]);
    await expect(FileCheckpointStore.snapshot(dir, "missing")).resolves.toBeUndefined();
    await expect(FileCheckpointStore.snapshots(join(dir, "nowhere"))).resolves.toEqual([]);
    // The holder is unaffected.
    await expect(store.load(record.runId)).resolves.toEqual(record);
  });

  it("keeps run IDs inside the directory and leaves no temporary files", async () => {
    const dir = await tempDir();
    const store = await openStore(dir);
    const lease = await store.create(record, "owner-a", 30_000);
    await store.compareAndSwap({ ...record, revision: 1 }, 0, lease);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["..%2Frun%2F1.run.json", "owner.pid"]);
  });

  it("serializes concurrent operations", async () => {
    const store = await openStore(await tempDir());
    const lease = await store.create(record, "owner-a", 30_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.compareAndSwap({ ...record, revision: 1 }, 0, lease)),
    );
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(results.filter((result) => result === "revision-conflict")).toHaveLength(4);
  });

  describe("directory guard", () => {
    it("rejects a second open instance in this process, until the first closes", async () => {
      const dir = await tempDir();
      const first = await openStore(dir);
      await expect(FileCheckpointStore.open({ dir })).rejects.toBeInstanceOf(
        CheckpointStoreLockedError,
      );
      await first.close();
      await expect(openStore(dir)).resolves.toBeInstanceOf(FileCheckpointStore);
    });

    it("rejects a directory claimed by another live process", async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "owner.pid"), String(process.ppid));
      await expect(FileCheckpointStore.open({ dir })).rejects.toBeInstanceOf(
        CheckpointStoreLockedError,
      );
    });

    it("takes over a directory left by a dead process", async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "owner.pid"), "2147483646");
      await openStore(dir);
      await expect(readFile(join(dir, "owner.pid"), "utf8")).resolves.toBe(String(process.pid));
    });

    it("refuses operations after close", async () => {
      const store = await openStore(await tempDir());
      await store.close();
      await expect(store.load("x")).rejects.toThrow(/closed/);
    });
  });
});

describe("cancel requests from another process", () => {
  const runFile = (dir: string) => join(dir, "..%2Frun%2F1.run.json");
  const controlFiles = async (dir: string) =>
    (await readdir(join(dir, "control")).catch(() => [])).sort();

  it("are written beside the run, never into it, and picked up by the holder's cancel check", async () => {
    const dir = await tempDir();
    const holder = await openStore(dir);
    await holder.create(record, "owner-a", 30_000);
    const before = await readFile(runFile(dir), "utf8");

    const receipt = await FileCheckpointStore.submitCancelRequest(dir, record.runId, {
      now: () => 5,
    });
    expect(receipt).toEqual({ outcome: "recorded", instance: expect.any(String), requestedAt: 5 });
    // The requester wrote only its control file: the run file (record, lease, flag) is untouched.
    await expect(readFile(runFile(dir), "utf8")).resolves.toBe(before);
    expect(await controlFiles(dir)).toEqual(["..%2Frun%2F1.cancel.json"]);
    await expect(FileCheckpointStore.snapshot(dir, record.runId)).resolves.toMatchObject({
      cancelRequested: false,
      pendingCancelRequest: { requestedAt: 5, pid: process.pid },
    });

    // The holder applies it under its own mutex: recorded in the run, request file consumed.
    await expect(holder.isCancelRequested(record.runId)).resolves.toBe(true);
    expect(await controlFiles(dir)).toEqual([]);
    const after = await FileCheckpointStore.snapshot(dir, record.runId);
    expect(after).toMatchObject({ cancelRequested: true, record });
    expect(after?.pendingCancelRequest).toBeUndefined();
    await expect(holder.isCancelRequested(record.runId)).resolves.toBe(true);
  });

  it("are idempotent: a second request is already-requested, before and after pickup", async () => {
    const dir = await tempDir();
    const holder = await openStore(dir);
    await holder.create(record, "owner-a", 30_000);
    expect((await FileCheckpointStore.submitCancelRequest(dir, record.runId)).outcome).toBe(
      "recorded",
    );
    expect((await FileCheckpointStore.submitCancelRequest(dir, record.runId)).outcome).toBe(
      "already-requested",
    );
    await holder.isCancelRequested(record.runId);
    expect((await FileCheckpointStore.submitCancelRequest(dir, record.runId)).outcome).toBe(
      "already-requested",
    );
    expect(await controlFiles(dir)).toEqual([]);
  });

  it("are refused for terminal and unknown runs, and for another instance than the caller saw", async () => {
    const dir = await tempDir();
    const holder = await openStore(dir);
    const lease = await holder.create(record, "owner-a", 30_000);
    await expect(FileCheckpointStore.submitCancelRequest(dir, "missing")).resolves.toEqual({
      outcome: "not-found",
    });
    await expect(
      FileCheckpointStore.submitCancelRequest(dir, record.runId, { instance: "someone-else" }),
    ).resolves.toEqual({ outcome: "not-found" });
    await holder.compareAndSwap({ ...record, status: "completed", revision: 1 }, 0, lease);
    await expect(FileCheckpointStore.submitCancelRequest(dir, record.runId)).resolves.toEqual({
      outcome: "already-terminal",
      status: "completed",
    });
    expect(await controlFiles(dir)).toEqual([]);
  });

  it("race: a run that completes after the request was written is not cancelled, and the request is discarded", async () => {
    const dir = await tempDir();
    const holder = await openStore(dir);
    const lease = await holder.create(record, "owner-a", 30_000);
    await FileCheckpointStore.submitCancelRequest(dir, record.runId); // arrives…
    await holder.compareAndSwap({ ...record, status: "completed", revision: 1 }, 0, lease); // …just too late
    const snapshot = await FileCheckpointStore.snapshot(dir, record.runId);
    expect(snapshot?.record.status).toBe("completed");
    expect(snapshot?.pendingCancelRequest).toBeUndefined();
    await expect(holder.isCancelRequested(record.runId)).resolves.toBe(false);
    expect(await controlFiles(dir)).toEqual([]);
  });

  it("a stale request never cancels a later run that reuses the ID", async () => {
    const dir = await tempDir();
    const holder = await openStore(dir);
    await holder.create(record, "owner-a", 30_000);
    const first = await FileCheckpointStore.snapshot(dir, record.runId);
    await FileCheckpointStore.submitCancelRequest(dir, record.runId, { instance: first?.instance });
    await holder.delete(record.runId); // removes the request with the run…
    await holder.create(record, "owner-a", 30_000);
    // …and even a request file written for the old instance afterwards does not match.
    await mkdir(join(dir, "control"), { recursive: true });
    await writeFile(
      join(dir, "control", "..%2Frun%2F1.cancel.json"),
      JSON.stringify({
        version: 1,
        runId: record.runId,
        instance: first?.instance,
        requestedAt: 1,
        pid: 1,
      }),
    );
    expect(
      (await FileCheckpointStore.snapshot(dir, record.runId))?.pendingCancelRequest,
    ).toBeUndefined();
    await expect(holder.isCancelRequested(record.runId)).resolves.toBe(false);
    expect(await controlFiles(dir)).toEqual([]);
    await expect(
      FileCheckpointStore.submitCancelRequest(dir, record.runId, { instance: first?.instance }),
    ).resolves.toEqual({ outcome: "not-found" });
  });

  it("survive the holder crashing before pickup; the next holder applies them", async () => {
    const dir = await tempDir();
    const first = await openStore(dir);
    await first.create(record, "owner-a", 30_000);
    await FileCheckpointStore.submitCancelRequest(dir, record.runId);
    await first.close(); // the holder is gone before its next cancel check
    const second = await openStore(dir);
    expect(await controlFiles(dir)).toEqual(["..%2Frun%2F1.cancel.json"]); // kept: the run is live
    await expect(second.isCancelRequested(record.runId)).resolves.toBe(true);
  });

  it("open() sweeps requests that can no longer apply and old temp files of crashed requesters", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "control"), { recursive: true });
    const orphan = join(dir, "control", "gone.cancel.json");
    await writeFile(
      orphan,
      JSON.stringify({ version: 1, runId: "gone", instance: "x", requestedAt: 1, pid: 1 }),
    );
    await writeFile(join(dir, "control", "garbage.cancel.json"), "{not json");
    const oldTemp = join(dir, "control", "a.cancel.json.1.tmp");
    const newTemp = join(dir, "control", "b.cancel.json.2.tmp");
    await writeFile(oldTemp, "");
    await writeFile(newTemp, "");
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(oldTemp, hourAgo, hourAgo);
    await openStore(dir);
    expect(await controlFiles(dir)).toEqual(["b.cancel.json.2.tmp"]); // may still be renamed by a live requester
  });
});

describe("cross-process cancel through the executor", () => {
  it("the owner notices a request within the poll interval while its handler is silent, and cancels through its normal path", async () => {
    const dir = await tempDir();
    const clock = new FakeClock(0);
    const store = await openStore(dir);
    const executor = new WorkflowExecutor({ store }, clock);
    const silent = controlled(); // a long local call: no output, no events
    const events = recorder();
    const run = track(
      executor.run(graph(nodes("a"), [], { a: silent.handler }), null, {
        runId: "r1",
        observer: events.observer,
      }),
    );
    await settleFs();

    const receipt = await FileCheckpointStore.submitCancelRequest(dir, "r1");
    expect(receipt.outcome).toBe("recorded");
    await clock.advance(1_999);
    await settleFs();
    expect(silent.aborted()).toBe(false);
    await clock.advance(1); // the 2 s cancel poll, independent of output and lease renewal
    await settleFs();
    expect(silent.aborted()).toBe(true);
    await vi.waitFor(() => expect(run.settled).toBe(true));
    expect(run.value?.status).toBe("cancelled");
    expect(events.summary()).toContain("run-cancel-requested");
    const persisted = await FileCheckpointStore.snapshot(dir, "r1");
    expect(persisted).toMatchObject({ record: { status: "cancelled" }, cancelRequested: true });
    expect(persisted?.lease).toBeUndefined(); // released after the terminal write
  });

  it("a request pending when the owner dies is honored by the next resume (W7)", async () => {
    const dir = await tempDir();
    let time = 0;
    const clock = new FakeClock(0);
    const first = await openStore(dir, () => time);
    void new WorkflowExecutor({ store: first }, clock).run(
      graph(nodes("a"), [], { a: controlled().handler }),
      null,
      { runId: "r1" },
    );
    await settleFs();
    await FileCheckpointStore.submitCancelRequest(dir, "r1");
    stores.splice(stores.indexOf(first), 1);
    await first.close(); // the owner process is gone before its next poll
    time = 31_000; // its lease has expired

    const second = await openStore(dir, () => time);
    const resumed = await new WorkflowExecutor({ store: second }, new FakeClock(0)).resume(
      graph(nodes("a"), [], { a: controlled().handler }),
      "r1",
    );
    expect(resumed.status).toBe("cancelled");
    expect(resumed.nodes.a).toMatchObject({ status: "uncertain", uncertainReason: "process-lost" });
  });
});

/** Lets real file I/O and the promise chains after it complete. */
async function settleFs() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}
