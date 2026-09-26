# Skill Document Integrity and Read Budget Fixes

- Recorded: 2026-09-27 01:22:22 KST (UTC+09:00).
- Reviewed implementation: `674b362` (`Implements skills`), at repository HEAD `92d3e31`.
- Status: Confirmed findings; fixes have not been implemented.
- Tracking: [Fix Tracking](../fix.md).

## 1. P2: Resource Reads Bypass SKILL.md Version Validation

### Affected code

- [`src/skills/prepare.ts`](../../src/skills/prepare.ts): `skills_read` execution, around lines 183–226.
- [`src/skills/catalog.ts`](../../src/skills/catalog.ts): document reading and digest verification in `LocalSkillCatalog`.

### Problem and impact

The catalog pins each `SKILL.md` digest at discovery. Subsequent `catalog.load()` and `skills_load` calls reject changed documents. However, `skills_read` treats `SKILL.md` as an ordinary resource. Its first read compares no digest against the document already activated for this invocation.

An agent can therefore receive changed instructions while its system context and `documentDigest` still identify the earlier version. The usage manifest records the new document as a resource alongside the old document digest. This is a reproducible inconsistency after a normal file edit; it does not require a concurrent filesystem attack.

### Reproduction

1. Create `skills/demo/SKILL.md` with valid frontmatter (`name: demo`, `description: Test`) and body `A`.
2. Load the catalog and prepare `{ include: ["demo"], activate: ["demo"] }`.
3. Replace the body on disk with `CHANGED INSTRUCTIONS`.
4. Call `catalog.load("demo")`.
5. Execute the prepared `skills_read` tool with `{ name: "demo", path: "SKILL.md" }`.

Observed:

- Step 4 rejects with `SkillChangedError`.
- Step 5 returns the changed document successfully.
- `prepared.usage()` contains the original `documentDigest` and a different digest for the `SKILL.md` resource.

Expected: no skill-reading path returns a changed instruction document under an invocation pinned to the earlier version.

### Required fix

Apply the catalog's pinned document identity when reading `SKILL.md` through the resource tool. Either route this read through a shared verified-document implementation or reject it with an actionable message directing callers to the supported document-loading path. If the resource read remains supported, verify the digest of the exact bytes returned rather than checking one read and returning a separate, unchecked read.

Preserve existing resource behavior, path restrictions, cancellation, and invocation isolation. A rejected read must not add a contradictory resource entry to usage or alter the active document identity.

### Regression coverage and acceptance criteria

- Cover the reproduction above for explicit activation and activation through `skills_load`.
- Confirm changed documents are rejected consistently across catalog and tool access.
- Confirm rejected reads leave the usage manifest consistent.
- Verify unchanged `SKILL.md` follows the chosen documented behavior.
- Verify loading a new catalog and preparing a new invocation accepts the updated document.
- Preserve existing detection of ordinary resource changes between reads.

## 2. P2: Skill Load Responses Exceed the Declared Read Budget

### Affected code

- [`src/skills/prepare.ts`](../../src/skills/prepare.ts): `skills_load` execution, around lines 145–153, and response rendering.
- [`src/skills/types.ts`](../../src/skills/types.ts): `SkillLimits.maxReadBytes` contract.
- [`src/skills/catalog.ts`](../../src/skills/catalog.ts) and [`src/skills/files.ts`](../../src/skills/files.ts): document reading and pre-read reservation support.

### Problem and impact

`maxReadBytes` is documented as covering everything returned by `skills_load` and `skills_read`, including repeated reads. `skills_load` reserves only the Markdown body's UTF-8 byte length. Its actual response also includes the skill name, digest, wrapper, and activation message, none of which count toward the budget.

The document is also read before this reservation occurs. Consequently, a request that should be refused for budget exhaustion still performs the document read. The implementation needs a clear distinction between returned-content accounting and filesystem I/O limits.

### Reproduction

1. Create a valid `demo` skill with the one-byte body `A`.
2. Load its catalog with `limits: { maxReadBytes: 1 }`.
3. Prepare `{ include: ["demo"], allowModelSelection: true }`.
4. Execute `skills_load({ name: "demo" })` and measure the returned string with `Buffer.byteLength(result, "utf8")`.

Observed: the call succeeds and returns **152 bytes**, despite the one-byte budget. The precise wrapper length depends on the skill name; the exclusion of that wrapper is the underlying defect.

Expected: the successful response must fit within the remaining returned-content budget. Otherwise, loading must fail without activating the skill or recording successful usage.

### Required fix

Construct the final response and account for its complete UTF-8 byte length, including all generated text. Keep reservation atomic across concurrent tool executions and ensure repeated successful calls consume the full response size each time. A failed reservation must not activate a skill or emit a successful load event.

Document whether each limit controls filesystem reads, system-prompt text, or tool-returned text. If the cumulative budget is also intended to bound I/O, add pre-read reservation or another bounded strategy; do not claim that an output-only check prevents document reads. Preserve the existing per-file limit and define how failed reads release reservations.

### Regression coverage and acceptance criteria

- A one-byte budget rejects the reproduction rather than returning the wrapped document.
- Exact-boundary tests use the complete response's UTF-8 length, including non-ASCII text.
- Repeated and parallel loads cannot return more successful content than the invocation budget permits.
- Mixed `skills_load` and `skills_read` calls share the same returned-content budget.
- Failed loads preserve activation, usage, and accounting invariants.
- Existing resource-read budget, cancellation, and per-invocation isolation tests remain passing.

## Validation and Completion

At review time, the full test run passed **547 tests**, with **36 PostgreSQL server tests skipped**. Type checking, linting, and the build passed. Both findings above were reproduced independently using temporary local skill packages without a model or network connection.

Add regression coverage in [`test/skills.test.ts`](../../test/skills.test.ts) and, where needed, [`test/skills-integration.test.ts`](../../test/skills-integration.test.ts). Run the focused tests followed by `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.

After completing a fix, record the actual implementation and validation results in `docs/fix_complete/` and link that report from the corresponding row in [Fix Tracking](../fix.md). Automatic graph retry/resume manifest verification remains a separately documented deferred feature, not part of these two fixes.
