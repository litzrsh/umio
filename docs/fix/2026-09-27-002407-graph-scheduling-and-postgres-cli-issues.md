# Graph Scheduling and PostgreSQL CLI Fixes

- Recorded: 2026-09-27 00:24:07 KST (UTC+09:00).
- Reviewed commit: `0332c2e` (`Graph update`).
- Status: Confirmed findings; fixes have not been implemented.
- Scope: Loop scheduling, PostgreSQL credential redaction, and checkpoint listing.

## 1. P1: New Tasks Start After a Loop Becomes Uncertain

### Affected code

- `src/graph/executor.ts`: `advanceLoops()` and the scheduling block following its invocation, around lines 910–987 and 1057–1107.

### Problem and impact

When a loop's aggregate output exceeds its output limit, `advanceLoops()` marks the loop node `uncertain`. The scheduler then continues to start ready nodes without checking the updated uncertainty state. This violates the rule that no new attempts start while any node requires recovery. An independent task may perform external side effects before the run parks.

### Reproduction

1. Create a graph with two entry nodes: a loop followed in node order by an independent task.
2. Configure `maxConcurrency: 1`.
3. Give the loop a single body task that returns a 100-character string, an `until` predicate returning `true`, and `maxOutputBytes: 32` on the loop node.
4. Make the independent task record that it executed.
5. Run the graph.

Observed: the loop becomes `uncertain`, the independent task reaches `completed`, and the run eventually returns `needs-recovery`.

Expected: the independent task remains `pending` and has no side effects until recovery is completed and execution resumes.

### Required fix

Recheck uncertainty after advancing loops and before starting additional work. Also stop advancing other loops once one becomes uncertain, so subsequent iterations cannot be created after execution should park. Preserve the existing behavior for attempts already in flight: they must follow the normal settlement and parking rules.

### Regression coverage

- Reproduce the single-concurrency case and assert that the independent handler is never called before recovery.
- Exercise multiple ready loops and ensure an uncertain loop prevents another iteration from starting.
- Cover already-running parallel tasks to ensure the fix neither abandons them incorrectly nor stalls parking.
- Recover the loop with a valid output and resume; verify the pending task executes once.

## 2. P1: PostgreSQL Passwords Appear in CLI Output

### Affected code

- `src/cli/config.ts`: `maskedConfig()`, around lines 187–203.
- `src/cli/app.ts`: `showConfig()`, around lines 775–782.
- `src/cli/store.ts`: `redact()` and the PostgreSQL store location string, around lines 126 and 166–174.

### Problem and impact

Configuration masking recognizes sensitive property names such as `password` and `token`, but does not recognize `connectionString`. Consequently, `umio config --json` prints credentials embedded in PostgreSQL URLs.

The separate store-location redactor masks the URL user-info password but leaves a `password` query parameter untouched. The installed `pg` driver accepts this parameter as a database password. Output copied into logs or support reports can therefore disclose credentials.

### Reproduction

Use only synthetic credentials:

```text
postgres://review:REVIEW_FAKE_SECRET@localhost/review
postgres://review@localhost/review?password=REVIEW_FAKE_SECRET
```

Put the first URL in `graph.checkpoint.connectionString` and run:

```sh
umio config --config /path/to/test-config.json --json
```

Observed: `REVIEW_FAKE_SECRET` appears in the JSON configuration output. Passing the second URL to `redact()` also returns the secret unchanged; a `pg.Client` constructed with that URL recognizes the query password.

### Required fix

Use a shared connection-string sanitization policy for configuration output and displayed store locations. Mask both URL user-info passwords and all password query values. For unsupported or malformed connection strings, return a safe placeholder rather than the raw string. Keep the actual connection string unchanged for database connections.

Review other user-facing configuration and store-location output paths for the same omission. Avoid introducing a circular dependency between configuration and store modules; place the shared helper in an appropriate independent module.

### Regression coverage

- Verify that `umio config --json` never contains a synthetic database password, including when the URL was resolved from an environment variable.
- Cover user-info passwords, query passwords, percent-encoded values, repeated password parameters, and malformed input.
- Assert that displayed store locations contain no secrets while connection construction still receives the original credentials.
- Preserve existing masking of provider keys and other sensitive configuration values.

## 3. P2: Older Pending Approvals Disappear from PostgreSQL Listings

### Affected code

- `src/graph/checkpoint/postgres.ts`: `snapshots()`, around lines 292–325.
- `src/cli/store.ts`: PostgreSQL backend `list()`, around line 129.
- `src/cli/graph.ts`: `listApprovals()`, around lines 453–459.
- `src/cli/app.ts`: `graph-list` filtering, around lines 293–297.

### Problem and impact

`snapshots()` defaults to the latest 1,000 records. The CLI loads this bounded list and subsequently filters or extracts approval information. An older run awaiting approval can disappear from the global approval listing even though it still exists and is directly queryable. The same ordering of truncation and filtering can hide older runs from `graph list --needs-recovery`.

### Reproduction

1. Create an older paused run containing one waiting approval.
2. Insert 1,000 newer completed runs in the same PostgreSQL store.
3. Query all approvals and then query approvals for the older run directly.

Observed with PGlite:

```json
{
  "listed": 1000,
  "allApprovals": 0,
  "targetedApprovals": 1
}
```

Expected: the global approval query includes the outstanding request, or explicitly exposes pagination that allows callers to retrieve it. It must not report an empty result simply because unrelated newer runs consumed the limit.

### Required fix

Define explicit listing semantics across the CLI backend and checkpoint store. Either iterate through stable pages for commands promising complete results or push appropriate filters into the database and expose pagination. Filtering after fetching only the first unfiltered page is insufficient.

Approval queries must consider waiting nodes in running and recovery states as well as paused runs. Filtering only by `status = 'paused'` would miss valid requests. A database-side filter alone also does not solve more than 1,000 matching runs; pagination must address that case.

### Regression coverage

- Reproduce the older pending approval behind 1,000 completed runs.
- Add an equivalent test for `graph list --needs-recovery`.
- Verify approvals from running, paused, and recovery-needed runs.
- Cover more than one page of matching records, deterministic ordering, and duplicate-free traversal on a static dataset.
- Confirm direct run lookup and file-store behavior remain unchanged.

## Validation and Completion Criteria

At review time, the unrestricted test run passed 501 tests and skipped 35. Type checking, linting, and the build passed. The initial sandboxed run encountered local-network and subprocess failures; the unrestricted rerun resolved those failures. Real PostgreSQL server tests were not run. The listing reproduction used PGlite, and the credential reproduction required no database connection.

For the fixes, add focused regression tests and run:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Run the PostgreSQL server suite against a dedicated test database when validating database query or pagination changes. Each finding is complete only when its reproduction produces the expected behavior, its regression tests pass, and existing approval, cancellation, recovery, and loop tests remain passing.
