import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStoreLockedError, FileCheckpointStore, type WorkflowRun } from "../src/index.js";
import { checkpointStoreContract } from "./checkpoint-contract.js";

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
