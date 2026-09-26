import { randomUUID } from "node:crypto";
import { UmioError } from "../../errors.js";
import { CheckpointConflictError, RunNotFoundError } from "../errors.js";
import type { ApprovalDecision, RunStatus, WorkflowRun } from "../types.js";
import {
  assertCheckpointSchema,
  type CasResult,
  type CheckpointStore,
  type DecisionResult,
  type Lease,
} from "./store.js";

/**
 * The query interface the store needs: parameterized queries (`$1`, `$2`, …)
 * returning rows. `pg`'s `Pool` and `Client` satisfy it as they are. Every
 * store operation is one statement, so a pool is safe: no operation needs
 * a transaction spanning several queries.
 */
export interface SqlClient {
  query(
    text: string,
    // biome-ignore lint/suspicious/noExplicitAny: matches pg's signature, whose values are `any[]`.
    values?: any[],
    // biome-ignore lint/suspicious/noExplicitAny: rows are read field by field below.
  ): Promise<{ rows: any[] }>;
}

export interface PostgresCheckpointStoreOptions {
  client: SqlClient;
  /** Schema holding the tables. Default: the connection's `search_path` (usually `public`). */
  schema?: string;
  /** Prefix of the table and sequence names. Default `umio_`. */
  tablePrefix?: string;
  /**
   * The store's clock for lease expiry. Default: the database clock
   * (`clock_timestamp()`), shared by every client, so lease expiry does not
   * depend on the clocks of the machines running executors. Override only in tests.
   */
  now?(): number;
}

/** A read-only view of one stored run, for inspection (CLI `status`, dashboards). */
export interface PostgresRunSnapshot {
  readonly record: WorkflowRun;
  readonly instance: string;
  readonly cancelRequested: boolean;
  readonly lease?: { readonly ownerId: string; readonly expiresAt: number };
  /** Whether the lease is unexpired by the store's clock. */
  readonly leaseActive: boolean;
  readonly decisions: readonly ApprovalDecision[];
}

/** The schema version `migrate()` brings the tables to. */
export const POSTGRES_STORE_SCHEMA_VERSION = 1;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * A `CheckpointStore` in PostgreSQL (10 or newer) for executors in several
 * processes or on several machines. Correctness rests on the database only:
 *
 * - Every write is a single `UPDATE … WHERE` whose conditions (lease token,
 *   owner, expiry by the database clock, revision) are checked by PostgreSQL
 *   on the row it locks, so concurrent writers serialize and at most one wins.
 * - Fencing tokens come from one sequence: every acquisition, by any client,
 *   issues a strictly higher token, even across deleted and re-created runs.
 * - Cancel requests are a flag and approval decisions a table with a primary
 *   key per request (`INSERT … ON CONFLICT DO NOTHING`), writable by anyone
 *   without a lease; only the lease holder turns them into run changes.
 *
 * Create the tables once with {@link PostgresCheckpointStore.migrate} (or run
 * {@link postgresSchemaSql} with your migration tool). The run record is kept
 * as `json`, verbatim; `status`, `revision` and the timestamps are also
 * columns, for queries.
 */
export class PostgresCheckpointStore implements CheckpointStore {
  private readonly client: SqlClient;
  private readonly runs: string;
  private readonly decisions: string;
  private readonly sequence: string;
  private readonly clock?: () => number;

  constructor(options: PostgresCheckpointStoreOptions) {
    this.client = options.client;
    const names = tableNames(options);
    this.runs = names.runs;
    this.decisions = names.decisions;
    this.sequence = names.sequence;
    if (options.now) this.clock = options.now;
  }

  /**
   * Creates or upgrades the tables. Idempotent and safe to run from several
   * processes at once (it holds a transaction-level advisory lock). Sends one
   * multi-statement script without parameters, which `pg` runs on a single
   * connection.
   */
  static async migrate(
    client: SqlClient,
    options: Pick<PostgresCheckpointStoreOptions, "schema" | "tablePrefix"> = {},
  ): Promise<void> {
    await client.query(postgresSchemaSql(options));
  }

  async create(run: WorkflowRun, ownerId: string, ttlMs: number): Promise<Lease> {
    assertCheckpointSchema(run);
    const { rows } = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now), token AS (SELECT nextval('${this.sequence}') AS value)
       INSERT INTO ${this.runs} (run_id, instance, record, schema_version, workflow_id, status, revision,
                                 lease_owner, lease_token, lease_expires_at, created_at, updated_at)
       SELECT $2, $3, $4::json, $5, $6, $7, $8, $9, token.value, clock.now + $10, $11, $12
       FROM clock, token
       ON CONFLICT (run_id) DO NOTHING
       RETURNING lease_token, lease_expires_at`,
      [
        this.now(),
        run.runId,
        randomUUID(),
        JSON.stringify(run),
        run.schemaVersion,
        run.workflowId,
        run.status,
        run.revision,
        ownerId,
        ttlMs,
        run.createdAt,
        run.updatedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new CheckpointConflictError(run.runId, `Run "${run.runId}" already exists.`);
    return {
      runId: run.runId,
      ownerId,
      token: Number(row.lease_token),
      expiresAt: Number(row.lease_expires_at),
    };
  }

  async load(runId: string): Promise<WorkflowRun | undefined> {
    const { rows } = await this.client.query(`SELECT record FROM ${this.runs} WHERE run_id = $1`, [
      runId,
    ]);
    if (!rows[0]) return undefined;
    const record = parseJson(rows[0].record) as WorkflowRun;
    assertCheckpointSchema(record);
    return record;
  }

  async compareAndSwap(
    run: WorkflowRun,
    expectedRevision: number,
    lease: Lease,
  ): Promise<CasResult> {
    assertCheckpointSchema(run);
    const { rows } = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now)
       UPDATE ${this.runs} SET record = $2::json, schema_version = $3, status = $4, revision = $5,
                               updated_at = $6
       FROM clock
       WHERE run_id = $7 AND lease_token = $8 AND lease_owner = $9 AND lease_expires_at > clock.now
         AND revision = $10
       RETURNING 1 AS ok`,
      [
        this.now(),
        JSON.stringify(run),
        run.schemaVersion,
        run.status,
        run.revision,
        run.updatedAt,
        run.runId,
        lease.token,
        lease.ownerId,
        expectedRevision,
      ],
    );
    if (rows[0]) return "ok";
    // Nothing was written; find out why (lease first, as the contract orders it).
    const state = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now)
       SELECT (lease_token IS NOT NULL AND lease_token = $2 AND lease_owner = $3
               AND lease_expires_at > clock.now) AS lease_ok
       FROM ${this.runs}, clock WHERE run_id = $4`,
      [this.now(), lease.token, lease.ownerId, run.runId],
    );
    const found = state.rows[0];
    if (!found) throw new RunNotFoundError(run.runId);
    return found.lease_ok ? "revision-conflict" : "lease-lost";
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<Lease | undefined> {
    const { rows } = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now), token AS (SELECT nextval('${this.sequence}') AS value)
       UPDATE ${this.runs} SET lease_owner = $2, lease_token = token.value,
                               lease_expires_at = clock.now + $3
       FROM clock, token
       WHERE run_id = $4 AND (lease_token IS NULL OR lease_expires_at <= clock.now)
       RETURNING lease_token, lease_expires_at`,
      [this.now(), ownerId, ttlMs, runId],
    );
    const row = rows[0];
    if (row) {
      return {
        runId,
        ownerId,
        token: Number(row.lease_token),
        expiresAt: Number(row.lease_expires_at),
      };
    }
    await this.requireRun(runId);
    return undefined;
  }

  async renewLease(lease: Lease, ttlMs: number): Promise<Lease | undefined> {
    const { rows } = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now)
       UPDATE ${this.runs} SET lease_expires_at = clock.now + $2
       FROM clock
       WHERE run_id = $3 AND lease_token = $4 AND lease_owner = $5 AND lease_expires_at > clock.now
       RETURNING lease_expires_at`,
      [this.now(), ttlMs, lease.runId, lease.token, lease.ownerId],
    );
    const row = rows[0];
    return row ? { ...lease, expiresAt: Number(row.lease_expires_at) } : undefined;
  }

  async releaseLease(lease: Lease): Promise<void> {
    await this.client.query(
      `UPDATE ${this.runs} SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE run_id = $1 AND lease_token = $2 AND lease_owner = $3`,
      [lease.runId, lease.token, lease.ownerId],
    );
  }

  async requestCancel(runId: string): Promise<void> {
    const { rows } = await this.client.query(
      `UPDATE ${this.runs} SET cancel_requested = true WHERE run_id = $1 RETURNING 1 AS ok`,
      [runId],
    );
    if (!rows[0]) throw new RunNotFoundError(runId);
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT cancel_requested FROM ${this.runs} WHERE run_id = $1`,
      [runId],
    );
    return rows[0]?.cancel_requested === true;
  }

  async delete(runId: string): Promise<void> {
    // Decisions go with it (ON DELETE CASCADE).
    await this.client.query(`DELETE FROM ${this.runs} WHERE run_id = $1`, [runId]);
  }

  async recordDecision(runId: string, decision: ApprovalDecision): Promise<DecisionResult> {
    let inserted: { rows: { decision: unknown }[] };
    try {
      inserted = await this.client.query(
        `INSERT INTO ${this.decisions} (run_id, request_id, decision, decided_at)
         SELECT $1, $2, $3::json, $4 WHERE EXISTS (SELECT 1 FROM ${this.runs} WHERE run_id = $1)
         ON CONFLICT (run_id, request_id) DO NOTHING
         RETURNING decision`,
        [runId, decision.requestId, JSON.stringify(decision), decision.decidedAt],
      );
    } catch (error) {
      // The run was deleted between the check and the insert.
      if ((error as { code?: string }).code === "23503") throw new RunNotFoundError(runId);
      throw error;
    }
    if (inserted.rows[0]) {
      return { outcome: "recorded", decision: parseJson(inserted.rows[0].decision) };
    }
    const { rows } = await this.client.query(
      `SELECT decision FROM ${this.decisions} WHERE run_id = $1 AND request_id = $2`,
      [runId, decision.requestId],
    );
    if (!rows[0]) throw new RunNotFoundError(runId);
    return { outcome: "already-decided", decision: parseJson(rows[0].decision) };
  }

  async loadDecisions(runId: string): Promise<ApprovalDecision[]> {
    const { rows } = await this.client.query(
      `SELECT decision FROM ${this.decisions} WHERE run_id = $1 ORDER BY decided_at, request_id`,
      [runId],
    );
    return rows.map((row) => parseJson(row.decision) as ApprovalDecision);
  }

  /** One run with its lease, control state and decisions; for inspection only. */
  async snapshot(runId: string): Promise<PostgresRunSnapshot | undefined> {
    return (await this.snapshots({ runId }))[0];
  }

  /** Runs, most recently updated first, optionally filtered by status. For inspection only. */
  async snapshots(
    filter: { runId?: string; status?: RunStatus; limit?: number } = {},
  ): Promise<PostgresRunSnapshot[]> {
    const { rows } = await this.client.query(
      `WITH clock AS (SELECT ${NOW} AS now)
       SELECT r.record, r.instance, r.cancel_requested, r.lease_owner, r.lease_expires_at,
              (r.lease_token IS NOT NULL AND r.lease_expires_at > clock.now) AS lease_active,
              coalesce((SELECT json_agg(d.decision ORDER BY d.decided_at, d.request_id)
                        FROM ${this.decisions} d WHERE d.run_id = r.run_id), '[]'::json) AS decisions
       FROM ${this.runs} r, clock
       WHERE ($2::text IS NULL OR r.run_id = $2) AND ($3::text IS NULL OR r.status = $3)
       ORDER BY r.updated_at DESC, r.run_id
       LIMIT $4`,
      [this.now(), filter.runId ?? null, filter.status ?? null, filter.limit ?? 1_000],
    );
    return rows.map((row) => {
      const record = parseJson(row.record) as WorkflowRun;
      assertCheckpointSchema(record);
      return {
        record,
        instance: String(row.instance),
        cancelRequested: row.cancel_requested === true,
        ...(row.lease_owner !== null && {
          lease: { ownerId: String(row.lease_owner), expiresAt: Number(row.lease_expires_at) },
        }),
        leaseActive: row.lease_active === true,
        decisions: parseJson(row.decisions) as ApprovalDecision[],
      };
    });
  }

  private now(): number | null {
    return this.clock ? this.clock() : null;
  }

  private async requireRun(runId: string): Promise<void> {
    const { rows } = await this.client.query(`SELECT 1 AS ok FROM ${this.runs} WHERE run_id = $1`, [
      runId,
    ]);
    if (!rows[0]) throw new RunNotFoundError(runId);
  }
}

/** `$1` when the store has an injected clock, else the database clock, in epoch milliseconds. */
const NOW = "coalesce($1::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint)";

/**
 * The DDL `migrate()` runs, for use with your own migration tool: tables for
 * runs and decisions, the fencing-token sequence and a migrations table, in
 * one transaction under an advisory lock. Idempotent.
 */
export function postgresSchemaSql(
  options: Pick<PostgresCheckpointStoreOptions, "schema" | "tablePrefix"> = {},
): string {
  const { runs, decisions, sequence, migrations, prefix } = tableNames(options);
  const createSchema = options.schema ? `CREATE SCHEMA IF NOT EXISTS ${options.schema};\n` : "";
  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('umio checkpoint schema ${options.schema ?? ""}.${prefix}'));
${createSchema}CREATE SEQUENCE IF NOT EXISTS ${sequence};
CREATE TABLE IF NOT EXISTS ${runs} (
  run_id text PRIMARY KEY,
  instance text NOT NULL,
  record json NOT NULL,
  schema_version integer NOT NULL,
  workflow_id text NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL,
  lease_owner text,
  lease_token bigint,
  lease_expires_at bigint,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ${prefix}runs_status_idx ON ${runs} (status, updated_at);
CREATE TABLE IF NOT EXISTS ${decisions} (
  run_id text NOT NULL REFERENCES ${runs} (run_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  decision json NOT NULL,
  decided_at bigint NOT NULL,
  PRIMARY KEY (run_id, request_id)
);
CREATE TABLE IF NOT EXISTS ${migrations} (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ${migrations} (version) VALUES (${POSTGRES_STORE_SCHEMA_VERSION}) ON CONFLICT DO NOTHING;
COMMIT;`;
}

function tableNames(options: Pick<PostgresCheckpointStoreOptions, "schema" | "tablePrefix">) {
  const prefix = options.tablePrefix ?? "umio_";
  if (!IDENTIFIER.test(prefix)) {
    throw new UmioError(`tablePrefix "${prefix}" must match ${IDENTIFIER} (lower case).`);
  }
  if (options.schema !== undefined && !IDENTIFIER.test(options.schema)) {
    throw new UmioError(`schema "${options.schema}" must match ${IDENTIFIER} (lower case).`);
  }
  const qualify = (name: string) => (options.schema ? `${options.schema}.${name}` : name);
  return {
    prefix,
    runs: qualify(`${prefix}runs`),
    decisions: qualify(`${prefix}decisions`),
    sequence: qualify(`${prefix}lease_token_seq`),
    migrations: qualify(`${prefix}schema_migrations`),
  };
}

/** `pg` parses `json` columns; other drivers may return text. */
// biome-ignore lint/suspicious/noExplicitAny: a parsed JSON value of any shape.
function parseJson(value: unknown): any {
  return typeof value === "string" ? JSON.parse(value) : value;
}
