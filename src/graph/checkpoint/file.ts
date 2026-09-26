import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UmioError } from "../../errors.js";
import {
  CheckpointConflictError,
  CheckpointStoreLockedError,
  RunNotFoundError,
} from "../errors.js";
import type { WorkflowRun } from "../types.js";
import {
  assertCheckpointSchema,
  type CasResult,
  type CheckpointStore,
  type Lease,
} from "./store.js";

/** One file per run: the record plus its lease state and control record. */
interface Entry {
  record: WorkflowRun;
  token: number;
  lease?: { ownerId: string; token: number; expiresAt: number };
  cancelRequested: boolean;
}

export interface FileCheckpointStoreOptions {
  /** Directory for run files; created if missing. */
  dir: string;
  /** The store's clock for lease expiry. Default `Date.now`. */
  now?(): number;
}

/** Directories held by open stores in this process. */
const openDirs = new Set<string>();

/**
 * **Experimental, single-process only.** Keeps each run in a JSON file so runs
 * survive a restart of the process.
 *
 * - Fencing and compare-and-swap are enforced by an in-process mutex: every
 *   operation reads, checks and writes its run file while holding it. Two
 *   processes sharing the directory would break this, so do not share it.
 * - Writes are atomic: a temporary file is written and flushed, then renamed
 *   over the run file.
 * - `open()` claims the directory with an `owner.pid` file and rejects while
 *   another open instance or live process holds it. This guard is a
 *   best-effort safety net, not a correctness mechanism.
 *
 * For several processes, use a store backed by a database with real CAS and
 * run the contract suite (`test/checkpoint-contract.ts`) against it.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly dir: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(options: FileCheckpointStoreOptions) {
    this.dir = resolve(options.dir);
    this.now = options.now ?? Date.now;
  }

  /** Opens the directory, claiming it for this instance (see the class notes). */
  static async open(options: FileCheckpointStoreOptions): Promise<FileCheckpointStore> {
    const store = new FileCheckpointStore(options);
    await mkdir(store.dir, { recursive: true });
    if (openDirs.has(store.dir)) throw new CheckpointStoreLockedError(store.dir, process.pid);
    openDirs.add(store.dir); // claimed before any await, so concurrent opens cannot both pass
    try {
      const pidFile = join(store.dir, "owner.pid");
      const holder = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10);
      if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) {
        throw new CheckpointStoreLockedError(store.dir, holder);
      }
      await writeFile(pidFile, String(process.pid));
    } catch (error) {
      openDirs.delete(store.dir);
      throw error;
    }
    return store;
  }

  /** Releases the directory claim. The instance cannot be used afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.exclusive(async () => {
      this.closed = true;
      openDirs.delete(this.dir);
      await rm(join(this.dir, "owner.pid"), { force: true });
    });
  }

  create(run: WorkflowRun, ownerId: string, ttlMs: number): Promise<Lease> {
    return this.exclusive(async () => {
      assertCheckpointSchema(run);
      if (await this.read(run.runId)) {
        throw new CheckpointConflictError(run.runId, `Run "${run.runId}" already exists.`);
      }
      const expiresAt = this.now() + ttlMs;
      await this.write({
        record: run,
        token: 1,
        lease: { ownerId, token: 1, expiresAt },
        cancelRequested: false,
      });
      return { runId: run.runId, ownerId, token: 1, expiresAt };
    });
  }

  load(runId: string): Promise<WorkflowRun | undefined> {
    return this.exclusive(async () => (await this.read(runId))?.record);
  }

  compareAndSwap(run: WorkflowRun, expectedRevision: number, lease: Lease): Promise<CasResult> {
    return this.exclusive(async () => {
      const entry = await this.require(run.runId);
      if (!this.isCurrent(entry, lease)) return "lease-lost";
      if (entry.record.revision !== expectedRevision) return "revision-conflict";
      assertCheckpointSchema(run);
      await this.write({ ...entry, record: run });
      return "ok";
    });
  }

  acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined> {
    return this.exclusive(async () => {
      const entry = await this.require(runId);
      const now = this.now();
      if (entry.lease && entry.lease.expiresAt > now) return undefined;
      const token = entry.token + 1;
      const lease = { ownerId, token, expiresAt: now + ttlMs };
      await this.write({ ...entry, token, lease });
      return { runId, ...lease };
    });
  }

  renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined> {
    return this.exclusive(async () => {
      const entry = await this.read(lease.runId);
      if (!entry || !this.isCurrent(entry, lease)) return undefined;
      const renewed = { ownerId: lease.ownerId, token: lease.token, expiresAt: this.now() + ttlMs };
      await this.write({ ...entry, lease: renewed });
      return { runId: lease.runId, ...renewed };
    });
  }

  releaseLease(lease: Lease): Promise<void> {
    return this.exclusive(async () => {
      const entry = await this.read(lease.runId);
      if (entry?.lease?.token === lease.token && entry.lease.ownerId === lease.ownerId) {
        const { lease: _, ...rest } = entry;
        await this.write(rest);
      }
    });
  }

  requestCancel(runId: string): Promise<void> {
    return this.exclusive(async () => {
      const entry = await this.require(runId);
      if (!entry.cancelRequested) await this.write({ ...entry, cancelRequested: true });
    });
  }

  isCancelRequested(runId: string): Promise<boolean> {
    return this.exclusive(async () => (await this.read(runId))?.cancelRequested ?? false);
  }

  delete(runId: string): Promise<void> {
    return this.exclusive(() => rm(this.fileFor(runId), { force: true }));
  }

  /** Runs `task` after every earlier operation of this instance has settled. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new UmioError(`FileCheckpointStore for ${this.dir} is closed.`);
      return task();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async read(runId: string): Promise<Entry | undefined> {
    let text: string;
    try {
      text = await readFile(this.fileFor(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const entry = JSON.parse(text) as Entry;
    assertCheckpointSchema(entry.record);
    return entry;
  }

  private async require(runId: string): Promise<Entry> {
    const entry = await this.read(runId);
    if (!entry) throw new RunNotFoundError(runId);
    return entry;
  }

  /** Writes and flushes a temporary file, then renames it over the run file. */
  private async write(entry: Entry): Promise<void> {
    const file = this.fileFor(entry.record.runId);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  private fileFor(runId: string): string {
    // encodeURIComponent leaves no path separators; the suffix keeps "." and ".." ordinary names.
    return join(this.dir, `${encodeURIComponent(runId)}.run.json`);
  }

  private isCurrent(entry: Entry, lease: Lease): boolean {
    return (
      entry.lease?.token === lease.token &&
      entry.lease.ownerId === lease.ownerId &&
      entry.lease.expiresAt > this.now()
    );
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
