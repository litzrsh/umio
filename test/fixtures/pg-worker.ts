/**
 * One "process" of the PostgreSQL multi-process tests. Usage:
 *   node --import tsx test/fixtures/pg-worker.ts <mode> <prefix> <runId> [arg]
 * Modes: run-silent | run-approval | resume-approval | resume-silent | approve | reject | effects.
 * Prints one JSON line with the result (or {"error": …}) and exits.
 */
import { appendFile, readFile } from "node:fs/promises";
import pg from "pg";
import {
  PostgresCheckpointStore,
  type WorkflowDefinition,
  WorkflowExecutor,
} from "../../src/index.js";

const [mode, tablePrefix, runId, arg] = process.argv.slice(2) as [string, string, string, string?];
const pool = new pg.Pool({ connectionString: process.env.UMIO_TEST_POSTGRES_URL, max: 2 });
const store = new PostgresCheckpointStore({ client: pool, tablePrefix });
const executor = new WorkflowExecutor({
  store,
  leaseTtlMs: 3_000,
  leaseRenewIntervalMs: 1_000,
  cancelPollIntervalMs: 2_000,
  cancelGraceMs: 1_000,
});

/** One node that stays silent until aborted, like a long local model call. */
const silent: WorkflowDefinition = {
  graph: {
    id: "silent",
    version: "1",
    entry: ["think"],
    nodes: [
      {
        id: "think",
        handler: "think",
        recovery: "retry",
        retry: { maxAttempts: 3, initialDelayMs: 0 },
      },
    ],
    edges: [],
  },
  handlers: {
    think: (context) =>
      context.attempt > 1
        ? Promise.resolve(`done by ${process.pid}`)
        : new Promise((_, reject) =>
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            }),
          ),
  },
  predicates: {},
};

/** plan → approve → deploy; deploy appends its idempotency key to the effects file (`arg`). */
const approval: WorkflowDefinition = {
  graph: {
    id: "release",
    version: "1",
    entry: ["plan"],
    nodes: [
      { id: "plan", handler: "plan" },
      { id: "approve", approval: { title: "Deploy?" } },
      { id: "deploy", handler: "deploy" },
    ],
    edges: [
      { from: "plan", to: "approve" },
      { from: "approve", to: "deploy" },
    ],
  },
  handlers: {
    plan: async () => "plan",
    deploy: async (context) => {
      await appendFile(arg as string, `${context.idempotencyKey}\n`);
      return "deployed";
    },
  },
  predicates: {},
};

async function main(): Promise<unknown> {
  switch (mode) {
    case "run-silent":
      return executor.run(silent, null, { runId });
    case "resume-silent":
      return executor.resume(silent, runId);
    case "run-approval":
      return executor.run(approval, null, { runId });
    case "resume-approval":
      return executor.resume(approval, runId);
    case "approve":
      return executor.approve(runId, "approve", { decidedBy: `pid ${process.pid}` });
    case "reject":
      return executor.reject(runId, "approve", { decidedBy: `pid ${process.pid}` });
    case "effects":
      return (await readFile(arg as string, "utf8").catch(() => "")).split("\n").filter(Boolean);
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

main()
  .then((value) => {
    process.stdout.write(`${JSON.stringify({ value })}\n`);
  })
  .catch((error: Error) => {
    process.stdout.write(`${JSON.stringify({ error: error.name, message: error.message })}\n`);
  })
  .finally(() => pool.end());
