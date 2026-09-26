# Completed: Graph Scheduling and PostgreSQL CLI Fixes

- Completed: 2026-09-27 00:37:02 KST (UTC+09:00).
- Request: [Graph Scheduling and PostgreSQL CLI Fixes](../fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md), findings
  [1](../fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#1-p1-new-tasks-start-after-a-loop-becomes-uncertain),
  [2](../fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#2-p1-postgresql-passwords-appear-in-cli-output) and
  [3](../fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#3-p2-older-pending-approvals-disappear-from-postgresql-listings).
- Base commit: `0332c2e` (`Graph update`). The fixes are uncommitted working-tree changes; no commit or pull request exists yet.

## 1. New tasks start after a loop becomes uncertain (P1)

**Root cause (verified).** In `drive()`, the gate `!halt && !hasUncertain(record)` was evaluated once per scheduling pass, *before* `advanceLoops()`. When `advanceLoops()` wrote W2′ (loop result over its `maxOutputBytes`, node `uncertain`), the same pass went on to start every ready node, because the start loop only checked `halt` and `cancelRequested`. `advanceLoops()` itself also kept going to the next loop after one became uncertain, so a second loop with a finished iteration could create its next iteration.

**Changes.**
- [`src/graph/executor.ts`](../../src/graph/executor.ts):
  - `advanceLoops()` stops (`break`) as soon as the run is halting or has an uncertain node. No further loop is decided or advanced in that pass.
  - After applying decisions and advancing loops, a `blocked()` check (`halt`, a pending cancel, or any uncertain node) guards both the readiness loop and each start. Attempts already running are untouched. They settle through the normal path, and the run parks with W5′ once nothing runs.

**Resulting behavior.** The reproduction (a loop and an independent task, `maxConcurrency: 1`, a 100-character body result over a 32-byte limit) now ends `needs-recovery` with the independent task `pending`, attempt 0, never called. After `recoverNode(…, "loop", { type: "complete", … })` and `resume()`, the task runs exactly once and the run completes.

**Regression tests** ([`test/graph-loop.test.ts`](../../test/graph-loop.test.ts), "a loop that becomes uncertain stops new work"):
- The single-concurrency reproduction, including recovery and resume. The task is called once, only after recovery.
- Two loops with finished, undecided iterations, from a crash fixture. The uncertain loop stops the other: no decision is recorded, no second iteration is created, and its body is never run.
- A task already running when the loop becomes uncertain. It is not aborted and completes normally, then the run parks. Its successor does not start.
- Without the executor change, the first two tests fail. The third guards against over-correction and passes both ways.

## 2. PostgreSQL passwords appear in CLI output (P1)

**Root cause (verified).**
- `maskedConfig()` masked values by key name only (`key|token|secret|password`). `graph.checkpoint.connectionString` is resolved from `${VAR}` at load, so `umio config --json` printed the full URL with its credentials.
- `redact()` in the CLI store masked only the URL's user-info password. It left `?password=` (read by `pg`) and similar parameters in place.

**Changes.**
- [`src/secrets.ts`](../../src/secrets.ts) (new, independent of the config and store modules). It holds one display-only policy:
  - `sanitizeConnectionString()` masks the user-info password and every credential query parameter (`password`, `sslpassword`, `pwd`, `token`, `api_key`, …). Names are matched case-insensitively after percent-decoding, and repeated values are all masked. A string that is not a parseable `scheme://` URL is replaced by `(connection string hidden)`.
  - `sanitizeUrl()` sanitizes URL values and leaves other strings alone.
  - `sanitizeText()` sanitizes URLs inside free text, such as error messages.
- [`src/cli/config.ts`](../../src/cli/config.ts): `maskedConfig()` keeps its secret-name masking. It also sanitizes `connectionString`/`connectionUri`/`dsn` keys, and credentials in any other URL value, such as a provider `baseURL` with a user-info password.
- [`src/cli/store.ts`](../../src/cli/store.ts):
  - The PostgreSQL store location uses `sanitizeConnectionString()`; `redact()` is removed.
  - Connection error messages go through `sanitizeText()`.
  - The pool still receives the original connection string.
- [`src/cli/app.ts`](../../src/cli/app.ts):
  - The text `umio config` output sanitizes provider base URLs.
  - It gains a "runs:" line that shows the checkpoint store, sanitized.

**Resulting behavior.** With `postgres://review:REVIEW_FAKE_SECRET@localhost/review?password=REVIEW_FAKE_SECRET` resolved from `DATABASE_URL`, `umio config --json` shows `postgres://review:***@localhost/review?password=***`. None of these outputs contain the secret:
- `umio config`, `graph migrate` and `graph list`;
- `graph approvals` and `graph status`;
- `--store` with a `?Password=` URL.

The driver receives the original strings.

**Regression tests:**
- [`test/secrets.test.ts`](../../test/secrets.test.ts) (new) covers user-info and query passwords, case, percent-encoding, repeated parameters, `sslpassword`, strings without credentials, malformed input and text sanitization.
- [`test/cli-app.test.ts`](../../test/cli-app.test.ts):
  - One test runs eight commands with an environment-resolved URL and a `--store` URL. It asserts that no output contains the secret and that the driver got the original credentials. It fails without the change.
  - One test checks that provider API keys and a credentialed provider `baseURL` stay masked.

## 3. Older pending approvals disappear from PostgreSQL listings (P2)

**Root cause (verified).** `PostgresCheckpointStore.snapshots()` silently applied `LIMIT 1000` (most recently updated first). The CLI then filtered that first page in memory, for `graph approvals` and `graph list --needs-recovery`. Matching runs older than the 1,000 newest runs were therefore dropped.

**Changes.**
- [`src/graph/checkpoint/postgres.ts`](../../src/graph/checkpoint/postgres.ts):
  - **`listRuns(query)`** returns one page (default 200, at most 1,000) with a `next` cursor. Ordering is `updated_at DESC, run_id ASC`, and pages use a keyset on those columns. Filters run in SQL:
    - `runId`;
    - `status`, one status or several;
    - `awaitingApproval`: a run in `running`, `paused` or `needs-recovery` with a node whose status is `waiting`, found through `json_each` over the record's nodes.
  - **`snapshots(filter)`** now reads every page, so it no longer truncates. `snapshot(runId)` uses `listRuns`.
  - The new types `RunListQuery`, `RunListCursor` and `RunPage` are exported from [`src/graph/index.ts`](../../src/graph/index.ts).
- [`src/cli/store.ts`](../../src/cli/store.ts): `CliStore.list(filter)` is documented as complete. The file store filters in memory (it reads every file, as before). The PostgreSQL store pushes the filter into `snapshots()`.
- [`src/cli/graph.ts`](../../src/cli/graph.ts): `listApprovals()` uses `list({ awaitingApproval: true })`.
- [`src/cli/app.ts`](../../src/cli/app.ts): `graph list --needs-recovery` uses `list({ status: "needs-recovery" })`.
- [`README.md`](../../README.md) documents the listing semantics.

**Resulting behavior.** The reproduction now returns every matching run:
- An old paused run behind 1,000 newer completed runs is listed by the global `graph approvals`, as are running and needs-recovery runs with waiting approvals.
- A cancelled run with a stale waiting node is excluded.
- `graph list --needs-recovery` lists the old recovery run, and `graph list` returns all 1,003 runs.
- Direct lookup is unchanged.

**Regression tests:**
- [`test/checkpoint-postgres.test.ts`](../../test/checkpoint-postgres.test.ts) (PGlite):
  - approvals from paused, running and needs-recovery runs behind 1,000 newer runs, with terminal runs excluded;
  - `status` filtering;
  - a five-page traversal (`limit: 7`) over 30 matching runs with equal timestamps: deterministic order, no duplicates or gaps;
  - full traversal at two page sizes giving identical results;
  - limit validation.
- [`test/cli-app.test.ts`](../../test/cli-app.test.ts): a PGlite-backed CLI test runs `graph approvals --json`, `graph list --needs-recovery --json`, `graph list --json` and a direct lookup behind 1,000 newer runs, plus the same filters on the file store. All three fix-3 tests fail against the previous code.
- [`test/checkpoint-postgres-server.test.ts`](../../test/checkpoint-postgres-server.test.ts): a real-server test checks 450 matching runs, 150 per timestamp, behind 1,000 others, read at two page sizes.

## Validation

All commands were run on 2026-09-27 against the final working tree.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed (exit 0). |
| `npm test` | 515 passed, 35 skipped. The skipped tests are the real-server suite, which needs `UMIO_TEST_POSTGRES_URL`. |
| `npm run build` | Passed. |
| `npm run test:postgres` (PostgreSQL 17 in Docker) | 36 passed. This includes the contract suite, client races, multi-process scenarios and the new pagination test. |

Each regression test was also run against the pre-fix source, by stashing the changed files. The tests described above as failing without their fix did fail.

## Remaining limitations

- Listing pages are stable only on data that does not change. A run updated during a traversal moves to the front and may be missed or seen twice in that traversal. This is documented on `listRuns`.
- The `awaitingApproval` filter scans the JSON nodes of non-terminal runs. There is no dedicated column or index, so a store with very many active runs pays that scan. A migration adding an indexed column would be follow-up work; no request has been filed.
- Masking is display-only and based on URL parsing. Credentials passed in other forms, such as libpq keyword strings or environment variables like `PGPASSWORD`, are never shown, because those strings are hidden whole or not displayed at all.
