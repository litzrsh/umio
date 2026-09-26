/**
 * PostgreSQL for the store tests. The contract suite always runs on PGlite
 * (PostgreSQL compiled to WebAssembly, in process). The multi-client and
 * multi-process tests need a real server: set UMIO_TEST_POSTGRES_URL, e.g.
 *
 *   docker compose up -d --wait   (docker-compose.yml in the repository root)
 *   UMIO_TEST_POSTGRES_URL=postgres://umio:umio@localhost:55432/umio npm test
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { SqlClient } from "../../src/index.js";

export const POSTGRES_URL = process.env.UMIO_TEST_POSTGRES_URL;

/**
 * Timeout for tests and hooks that start PGlite. Loading PostgreSQL as
 * WebAssembly takes about a second locally but several on a shared CI runner,
 * well past Vitest's 5 s default for a test that also runs a dozen CLI calls.
 */
export const PGLITE_TIMEOUT_MS = 60_000;

/** A PGlite database as a `SqlClient`: parameterless multi-statement scripts go through `exec`. */
export async function pglite(): Promise<SqlClient & { close(): Promise<void> }> {
  const db = await PGlite.create();
  return {
    query: async (text, values) => {
      if (!values?.length && text.trim().includes(";\n")) {
        const results = await db.exec(text);
        return { rows: results.at(-1)?.rows ?? [] };
      }
      return db.query(text, values);
    },
    close: () => db.close(),
  };
}

/** A pool on the real server; each pool is a separate set of connections (a "client"). */
export function pool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: POSTGRES_URL, max });
}

let counter = 0;
/** A table prefix no other test uses, so tests never share rows. */
export function uniquePrefix(): string {
  counter += 1;
  return `t${process.pid}_${Date.now().toString(36)}_${counter}_`;
}
