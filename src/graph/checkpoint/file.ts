import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { UmioError } from "../../errors.js";
import {
  CheckpointConflictError,
  CheckpointStoreLockedError,
  RunNotFoundError,
} from "../errors.js";
import type { ApprovalDecision, WorkflowRun } from "../types.js";
import {
  assertCheckpointSchema,
  type CasResult,
  type CheckpointStore,
  type DecisionResult,
  type Lease,
} from "./store.js";

/** One file per run: the record plus its lease state and control record. */
interface Entry {
  record: WorkflowRun;
  token: number;
  lease?: { ownerId: string; token: number; expiresAt: number };
  cancelRequested: boolean;
  /** Random per `create()`: tells a run from a later one that reuses its ID. */
  instance?: string;
}

export interface FileCheckpointStoreOptions {
  /** Directory for run files; created if missing. */
  dir: string;
  /** The store's clock for lease expiry. Default `Date.now`. */
  now?(): number;
}

/** A read-only view of one stored run: the record plus its lease and control state. */
export interface StoredRunSnapshot {
  readonly record: WorkflowRun;
  readonly cancelRequested: boolean;
  /** The lease as last written; compare `expiresAt` with the current time. */
  readonly lease?: { readonly ownerId: string; readonly expiresAt: number };
  /** Identifies this run as opposed to an earlier or later run with the same ID. */
  readonly instance: string;
  /**
   * A cancel request submitted from outside the owning process
   * ({@link FileCheckpointStore.submitCancelRequest}) that the store holder has
   * not picked up yet. Only reported while the run is not terminal.
   */
  readonly pendingCancelRequest?: { readonly requestedAt: number; readonly pid: number };
  /** Approval decisions recorded for this run instance (applied or not). */
  readonly decisions: readonly ApprovalDecision[];
}

/** What {@link FileCheckpointStore.submitCancelRequest} did. */
export type CancelRequestReceipt =
  /** The request file was written; the store holder applies it on its next cancel check. */
  | { readonly outcome: "recorded"; readonly instance: string; readonly requestedAt: number }
  /** A request is already recorded (in the run, or as a pending request file). */
  | { readonly outcome: "already-requested"; readonly instance: string }
  | { readonly outcome: "already-terminal"; readonly status: WorkflowRun["status"] }
  /** No such run, or not the run instance the caller expected. */
  | { readonly outcome: "not-found" };

/** The control file a requester writes; never read as a checkpoint. */
interface CancelRequestFile {
  readonly version: 1;
  readonly runId: string;
  readonly instance: string;
  readonly requestedAt: number;
  readonly pid: number;
}

/** An approval decision file: created once (never replaced), so the first decision wins. */
interface DecisionFile {
  readonly version: 1;
  readonly runId: string;
  readonly instance: string;
  readonly decision: ApprovalDecision;
}

/** What {@link FileCheckpointStore.submitDecision} did. */
export type DecisionReceipt =
  | DecisionResult
  /** No such run, or not the run instance the caller expected. */
  | { readonly outcome: "not-found" }
  | { readonly outcome: "already-terminal"; readonly status: WorkflowRun["status"] };

const CONTROL_DIR = "control";
/** Temporary control files older than this are leftovers of a crashed requester. */
const STALE_TEMP_MS = 60_000;

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
 * - Other processes may only **ask** for a cancel, with the static
 *   {@link FileCheckpointStore.submitCancelRequest}. It writes a separate
 *   control file (`control/<run>.cancel.json`, atomically) and never touches
 *   run files or leases. The holder reads it in `isCancelRequested` (which the
 *   executor polls every `cancelPollIntervalMs`, on its own timer) and records
 *   it in the run under its own mutex, so the run is still only written by
 *   one process and the cancel goes through the executor's normal, fenced path.
 * - Approval decisions work the same way: {@link FileCheckpointStore.submitDecision}
 *   (or `recordDecision` in the holder) creates
 *   `control/<run>.<request>.decision.json` exclusively (hard link of a
 *   flushed temporary file), so the first decision per request wins across
 *   processes; the executor reads them and applies them under its lease.
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
      await store.sweepControlFiles();
    } catch (error) {
      openDirs.delete(store.dir);
      throw error;
    }
    return store;
  }

  /**
   * Asks the process holding `dir` to cancel a run, without opening the store.
   * Safe to call while another process holds it: it only writes an atomic
   * control file, never the run file or its lease. `instance` (from a
   * snapshot) pins the request to the run the caller saw.
   *
   * - The holder applies it on its next cancel check (within about
   *   `cancelPollIntervalMs` while it drives the run). If nobody drives the
   *   run, the request stays pending and is applied by the next `open()`er
   *   when it resumes, recovers or cancels the run.
   * - Idempotent: a second request for the same run instance is
   *   `already-requested`. A request for a run that is terminal (or ends
   *   before it is applied) is discarded, and one for an earlier run with the
   *   same ID never matches a later one.
   */
  static async submitCancelRequest(
    dir: string,
    runId: string,
    options: { instance?: string; now?: () => number } = {},
  ): Promise<CancelRequestReceipt> {
    const root = resolve(dir);
    const entry = await readEntry(join(root, fileName(runId)));
    if (!entry) return { outcome: "not-found" };
    const instance = instanceOf(entry);
    if (options.instance !== undefined && options.instance !== instance)
      return { outcome: "not-found" };
    if (isTerminal(entry.record.status)) {
      return { outcome: "already-terminal", status: entry.record.status };
    }
    const file = controlFile(root, runId);
    if (entry.cancelRequested || (await readControl(file))?.instance === instance) {
      return { outcome: "already-requested", instance };
    }
    const requestedAt = (options.now ?? Date.now)();
    const request: CancelRequestFile = {
      version: 1,
      runId,
      instance,
      requestedAt,
      pid: process.pid,
    };
    await mkdir(join(root, CONTROL_DIR), { recursive: true });
    await atomicWrite(file, JSON.stringify(request));
    return { outcome: "recorded", instance, requestedAt };
  }

  /**
   * Records an approval decision without opening the store, like
   * {@link FileCheckpointStore.submitCancelRequest}: safe while another
   * process holds the directory, never touches the run file. The first
   * decision per request wins (`already-decided` returns it).
   */
  static async submitDecision(
    dir: string,
    runId: string,
    decision: ApprovalDecision,
    options: { instance?: string } = {},
  ): Promise<DecisionReceipt> {
    const root = resolve(dir);
    const entry = await readEntry(join(root, fileName(runId)));
    if (!entry) return { outcome: "not-found" };
    const instance = instanceOf(entry);
    if (options.instance !== undefined && options.instance !== instance) {
      return { outcome: "not-found" };
    }
    if (isTerminal(entry.record.status)) {
      return { outcome: "already-terminal", status: entry.record.status };
    }
    return createDecision(root, runId, instance, decision);
  }

  /**
   * Reads one run without opening the store, so it works while another
   * process holds the directory (writes are atomic renames, so a read sees a
   * whole file). For inspection only: it takes no lease and never writes.
   */
  static async snapshot(dir: string, runId: string): Promise<StoredRunSnapshot | undefined> {
    return readSnapshot(resolve(dir), fileName(runId));
  }

  /** Every run in the directory, read as by {@link FileCheckpointStore.snapshot}. */
  static async snapshots(dir: string): Promise<StoredRunSnapshot[]> {
    let names: string[];
    try {
      names = await readdir(resolve(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: StoredRunSnapshot[] = [];
    for (const name of names.filter((item) => item.endsWith(".run.json")).sort()) {
      const run = await readSnapshot(resolve(dir), name);
      if (run) runs.push(run);
    }
    return runs;
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
        instance: randomUUID(),
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

  /**
   * Also picks up a request another process submitted with
   * {@link FileCheckpointStore.submitCancelRequest}: a request for this run
   * instance is recorded in the run (so it survives a crash) and its file
   * removed; a stale one (another instance, or a terminal run) is removed.
   */
  isCancelRequested(runId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const entry = await this.read(runId);
      const file = controlFile(this.dir, runId);
      const request = await readControl(file);
      if (!entry) {
        if (request) await rm(file, { force: true });
        return false;
      }
      if (!request) return entry.cancelRequested;
      const applies = request.instance === instanceOf(entry) && !isTerminal(entry.record.status);
      if (applies && !entry.cancelRequested) await this.write({ ...entry, cancelRequested: true });
      await rm(file, { force: true });
      return entry.cancelRequested || applies;
    });
  }

  recordDecision(runId: string, decision: ApprovalDecision): Promise<DecisionResult> {
    return this.exclusive(async () => {
      const entry = await this.require(runId);
      return createDecision(this.dir, runId, instanceOf(entry), decision);
    });
  }

  loadDecisions(runId: string): Promise<ApprovalDecision[]> {
    return this.exclusive(async () => {
      const entry = await this.read(runId);
      return entry ? readDecisions(this.dir, runId, instanceOf(entry)) : [];
    });
  }

  delete(runId: string): Promise<void> {
    return this.exclusive(async () => {
      await rm(this.fileFor(runId), { force: true });
      await rm(controlFile(this.dir, runId), { force: true });
      for (const file of await decisionFiles(this.dir, runId)) {
        await rm(file.path, { force: true });
      }
    });
  }

  /**
   * On open: removes request files that can no longer apply (run gone,
   * another instance, or terminal) and temporary files a crashed requester
   * left behind. Requests for live runs stay until they are applied.
   */
  private async sweepControlFiles(): Promise<void> {
    const dir = join(this.dir, CONTROL_DIR);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(dir, name);
      if (name.endsWith(".tmp")) {
        const info = await stat(path).catch(() => undefined);
        if (info && this.now() - info.mtimeMs > STALE_TEMP_MS) await rm(path, { force: true });
        continue;
      }
      const request = name.endsWith(".decision.json")
        ? await readDecisionFile(path)
        : await readControl(path);
      const entry = request ? await this.read(request.runId) : undefined;
      if (
        !request ||
        !entry ||
        request.instance !== instanceOf(entry) ||
        isTerminal(entry.record.status)
      ) {
        await rm(path, { force: true });
      }
    }
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
    await atomicWrite(this.fileFor(entry.record.runId), JSON.stringify(entry));
  }

  private fileFor(runId: string): string {
    return join(this.dir, fileName(runId));
  }

  private isCurrent(entry: Entry, lease: Lease): boolean {
    return (
      entry.lease?.token === lease.token &&
      entry.lease.ownerId === lease.ownerId &&
      entry.lease.expiresAt > this.now()
    );
  }
}

function fileName(runId: string): string {
  // encodeURIComponent leaves no path separators; the suffix keeps "." and ".." ordinary names.
  return `${encodeURIComponent(runId)}.run.json`;
}

async function readEntry(file: string): Promise<Entry | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const entry = JSON.parse(text) as Entry;
  assertCheckpointSchema(entry.record);
  return entry;
}

async function readSnapshot(root: string, name: string): Promise<StoredRunSnapshot | undefined> {
  const entry = await readEntry(join(root, name));
  if (!entry) return undefined;
  const instance = instanceOf(entry);
  const request = await readControl(controlFile(root, entry.record.runId));
  const pending =
    request?.instance === instance && !entry.cancelRequested && !isTerminal(entry.record.status);
  return {
    record: entry.record,
    cancelRequested: entry.cancelRequested,
    ...(entry.lease && {
      lease: { ownerId: entry.lease.ownerId, expiresAt: entry.lease.expiresAt },
    }),
    instance,
    ...(pending && {
      pendingCancelRequest: { requestedAt: request.requestedAt, pid: request.pid },
    }),
    decisions: await readDecisions(root, entry.record.runId, instance),
  };
}

function decisionFile(root: string, runId: string, requestId: string): string {
  return join(
    root,
    CONTROL_DIR,
    `${encodeURIComponent(runId)}.${encodeURIComponent(requestId)}.decision.json`,
  );
}

/**
 * Creates a decision file unless one exists for the request: the content is
 * written and flushed to a temporary file, then hard-linked into place, which
 * fails if the name exists. The first decision wins, across processes.
 */
async function createDecision(
  root: string,
  runId: string,
  instance: string,
  decision: ApprovalDecision,
): Promise<DecisionResult> {
  const file = decisionFile(root, runId, decision.requestId);
  const existing = await readDecisionFile(file);
  if (existing?.instance === instance) {
    return { outcome: "already-decided", decision: existing.decision };
  }
  await mkdir(join(root, CONTROL_DIR), { recursive: true });
  const content: DecisionFile = { version: 1, runId, instance, decision };
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(JSON.stringify(content));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readDecisionFile(file);
    if (!winner || winner.instance !== instance) throw error;
    return { outcome: "already-decided", decision: winner.decision };
  } finally {
    await rm(temp, { force: true });
  }
  return { outcome: "recorded", decision };
}

async function readDecisionFile(file: string): Promise<DecisionFile | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<DecisionFile>;
    return value.version === 1 &&
      typeof value.runId === "string" &&
      typeof value.instance === "string" &&
      typeof value.decision?.requestId === "string"
      ? (value as DecisionFile)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Decision files that may belong to the run (their content says for sure). */
async function decisionFiles(
  root: string,
  runId: string,
): Promise<{ path: string; content?: DecisionFile }[]> {
  const prefix = `${encodeURIComponent(runId)}.`;
  const names = await readdir(join(root, CONTROL_DIR)).catch(() => [] as string[]);
  const files: { path: string; content?: DecisionFile }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".decision.json")) continue;
    const path = join(root, CONTROL_DIR, name);
    const content = await readDecisionFile(path);
    if (content && content.runId !== runId) continue;
    files.push({ path, ...(content && { content }) });
  }
  return files;
}

async function readDecisions(
  root: string,
  runId: string,
  instance: string,
): Promise<ApprovalDecision[]> {
  return (await decisionFiles(root, runId))
    .filter((file) => file.content?.instance === instance)
    .map((file) => (file.content as DecisionFile).decision);
}

/** Runs created before instances existed are told apart by their creation time. */
function instanceOf(entry: Entry): string {
  return entry.instance ?? `created-${entry.record.createdAt}`;
}

function isTerminal(status: WorkflowRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function controlFile(root: string, runId: string): string {
  return join(root, CONTROL_DIR, `${encodeURIComponent(runId)}.cancel.json`);
}

/** A valid request file, or undefined (missing, or unreadable: treated as absent). */
async function readControl(file: string): Promise<CancelRequestFile | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<CancelRequestFile>;
    return value.version === 1 &&
      typeof value.runId === "string" &&
      typeof value.instance === "string"
      ? (value as CancelRequestFile)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Writes and flushes a temporary file, then renames it over `file`. */
async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(text);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
