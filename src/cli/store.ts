/**
 * Where `umio graph …` keeps runs: the single-process file store (default) or
 * PostgreSQL (`graph.checkpoint` in the config, or `--store postgres://…`).
 * Both give the commands the same view of a run; only the file store needs
 * control files to reach a process that holds it.
 */
import { resolve } from "node:path";
import type { GraphConfig } from "../config/schema.js";
import { FileCheckpointStore } from "../graph/checkpoint/file.js";
import { PostgresCheckpointStore, type SqlClient } from "../graph/checkpoint/postgres.js";
import type { CheckpointStore } from "../graph/checkpoint/store.js";
import type { ApprovalDecision, WorkflowRun } from "../graph/types.js";
import { CliError } from "./explain.js";

/** One run as the commands see it, from either store. */
export interface RunView {
  readonly record: WorkflowRun;
  readonly cancelRequested: boolean;
  /** The lease as stored; compare `expiresAt` with the time, or use `leaseActive`. */
  readonly lease?: { readonly ownerId: string; readonly expiresAt: number };
  /** Postgres: the lease is unexpired by the database clock. */
  readonly leaseActive?: boolean;
  /** Identifies this run as opposed to another with the same ID. */
  readonly instance?: string;
  /** File store: a cancel request file its holder has not picked up yet. */
  readonly pendingCancelRequest?: { readonly requestedAt: number; readonly pid: number };
  readonly decisions: readonly ApprovalDecision[];
}

export type CliStore = FileCliStore | PostgresCliStore;

interface CliStoreBase {
  /** For messages: the directory, or the database with its credentials hidden. */
  readonly location: string;
  /** Runs `task` with a writable store (the file store is claimed for the duration). */
  withStore<T>(task: (store: CheckpointStore) => Promise<T>): Promise<T>;
  snapshot(runId: string): Promise<RunView | undefined>;
  list(): Promise<RunView[]>;
  close(): Promise<void>;
}

export interface FileCliStore extends CliStoreBase {
  readonly kind: "file";
  readonly dir: string;
}

export interface PostgresCliStore extends CliStoreBase {
  readonly kind: "postgres";
  migrate(): Promise<void>;
}

export interface StoreSelection {
  readonly cwd: string;
  /** Directory of the config file, if one was found. */
  readonly configDir?: string;
  /** `--store`: a directory, or a postgres:// URL. */
  readonly explicit?: string;
  readonly checkpoint?: GraphConfig["checkpoint"];
  /** Loads the `pg` module; injectable for tests. */
  readonly loadPg?: () => Promise<PgModule>;
}

/** The part of the `pg` package the CLI uses. */
export interface PgModule {
  Pool: new (options: {
    connectionString: string;
    max?: number;
  }) => SqlClient & {
    end(): Promise<void>;
  };
}

export async function openCliStore(selection: StoreSelection): Promise<CliStore> {
  const { cwd, configDir, explicit, checkpoint } = selection;
  if (explicit && /^postgres(ql)?:\/\//.test(explicit)) {
    return postgresStore({ connectionString: explicit }, selection);
  }
  if (explicit) return fileStore(resolve(cwd, explicit));
  if (checkpoint?.type === "postgres") return postgresStore(checkpoint, selection);
  const base = configDir ?? cwd;
  return fileStore(resolve(base, checkpoint?.dir ?? ".umio/runs"));
}

function fileStore(dir: string): FileCliStore {
  return {
    kind: "file",
    dir,
    location: dir,
    async withStore(task) {
      const store = await FileCheckpointStore.open({ dir });
      try {
        return await task(store);
      } finally {
        await store.close();
      }
    },
    snapshot: (runId) => FileCheckpointStore.snapshot(dir, runId),
    list: async () =>
      (await FileCheckpointStore.snapshots(dir)).sort(
        (a, b) => b.record.updatedAt - a.record.updatedAt,
      ),
    close: async () => {},
  };
}

async function postgresStore(
  options: { connectionString: string; schema?: string; tablePrefix?: string },
  selection: StoreSelection,
): Promise<PostgresCliStore> {
  const pg = await (selection.loadPg ?? importPg)();
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 4 });
  const names = {
    ...(options.schema && { schema: options.schema }),
    ...(options.tablePrefix && { tablePrefix: options.tablePrefix }),
  };
  const store = new PostgresCheckpointStore({ client: pool, ...names });
  const guard = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      throw explainPostgres(error);
    }
  };
  return {
    kind: "postgres",
    location: `postgres ${redact(options.connectionString)}${options.schema ? ` (schema ${options.schema})` : ""}`,
    withStore: (task) => guard(() => task(store)),
    snapshot: (runId) => guard(() => store.snapshot(runId)),
    list: () => guard(() => store.snapshots()),
    migrate: () => guard(() => PostgresCheckpointStore.migrate(pool, names)),
    close: () => pool.end(),
  };
}

async function importPg(): Promise<PgModule> {
  try {
    const module = (await import("pg")) as { default?: PgModule } & PgModule;
    return module.default ?? module;
  } catch (error) {
    throw new CliError("The PostgreSQL checkpoint store needs the `pg` package.", {
      hint: "Install it next to umio: npm install pg",
      cause: error,
    });
  }
}

/** Errors worth a hint: tables not created yet, or the server unreachable. */
function explainPostgres(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (code === "42P01") {
    return new CliError("The umio tables do not exist in this database yet.", {
      hint: "Create them once with: umio graph migrate",
      cause: error,
    });
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "28P01" || code === "3D000") {
    return new CliError(`Cannot use the PostgreSQL checkpoint store: ${(error as Error).message}`, {
      hint: "Check graph.checkpoint.connectionString in the config (or the --store URL), and that the server is running.",
      cause: error,
    });
  }
  return error;
}

/** A connection string without its password. */
export function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(connection string)";
  }
}
