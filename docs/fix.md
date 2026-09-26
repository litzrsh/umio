# Fix Tracking

Track required fixes and link their implementation results here. Pending findings belong in `docs/fix/`; completed-fix reports belong in `docs/fix_complete/`.

## Required Fixes

| Finding | Priority | Request | Status | Completion Report |
| --- | --- | --- | --- | --- |
| New tasks start after a loop becomes uncertain | P1 | [Details](fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#1-p1-new-tasks-start-after-a-loop-becomes-uncertain) | Completed | [Report](fix_complete/2026-09-27-003702-graph-scheduling-and-postgres-cli-issues.md#1-new-tasks-start-after-a-loop-becomes-uncertain-p1) |
| PostgreSQL passwords appear in CLI output | P1 | [Details](fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#2-p1-postgresql-passwords-appear-in-cli-output) | Completed | [Report](fix_complete/2026-09-27-003702-graph-scheduling-and-postgres-cli-issues.md#2-postgresql-passwords-appear-in-cli-output-p1) |
| Older pending approvals disappear from PostgreSQL listings | P2 | [Details](fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md#3-p2-older-pending-approvals-disappear-from-postgresql-listings) | Completed | [Report](fix_complete/2026-09-27-003702-graph-scheduling-and-postgres-cli-issues.md#3-older-pending-approvals-disappear-from-postgresql-listings-p2) |
| Resource reads bypass SKILL.md version validation | P2 | [Details](fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md#1-p2-resource-reads-bypass-skillmd-version-validation) | Completed | [Report](fix_complete/2026-09-27-012724-skill-document-integrity-and-read-budget.md#1-resource-reads-bypass-skillmd-version-validation-p2) |
| Skill load responses exceed the declared read budget | P2 | [Details](fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md#2-p2-skill-load-responses-exceed-the-declared-read-budget) | Completed | [Report](fix_complete/2026-09-27-012724-skill-document-integrity-and-read-budget.md#2-skill-load-responses-exceed-the-declared-read-budget-p2) |

Each request identifies the affected source files, reproduction steps, expected behavior, proposed changes, and regression coverage.

## Workflow

1. **Record the request.** Create an English Markdown document in `docs/fix/` named `{date}-{time}-{problem}.md`, using `YYYY-MM-DD-HHmmss-problem-slug.md`. Use KST (UTC+09:00) and a descriptive lowercase, hyphen-separated problem slug. Add a row here linking to the request or its specific finding.
2. **Track implementation.** Change the row's status from `Open` to `In progress` when implementation begins. Keep separate statuses for independent findings, even when they share one request document.
3. **Implement and validate.** Address the documented failure and add appropriate regression coverage. Record actual validation results, including failures, skipped checks, and environment limitations. A proposal or documentation update alone does not complete a code fix.
4. **Write the completion report.** After implementation and validation, create an English report in `docs/fix_complete/` using the same filename format, with the completion timestamp. Describe what actually changed, rather than copying the proposed solution as if it were implemented.
5. **Link the result.** Replace `Not yet available` with a relative link to the completion report and set the relevant row to `Completed`. Preserve the original request link. A shared report may cover multiple findings, but link each row to its corresponding report section.

## Completion Report Requirements

Every completion report must include:

- A link to the original request and the specific findings resolved.
- The completion date and the verified root cause.
- The source files changed, with relative links and a concise explanation of each change.
- The resulting behavior, including how the original reproduction now behaves.
- Regression tests added or updated, commands run, and observed results.
- Remaining limitations or follow-up work, with links to new requests where applicable.
- Commit or pull request references when available; do not invent references for uncommitted work.

Mark a finding `Completed` only when its acceptance criteria are met. If work resolves only part of a finding, keep it `In progress` and describe the remaining work. If a completed fix regresses, reopen the row and retain the previous report link as history.

## Completion Reports

- [Graph scheduling and PostgreSQL CLI fixes](fix_complete/2026-09-27-003702-graph-scheduling-and-postgres-cli-issues.md) — 2026-09-27 00:37:02 KST; findings 1–3 of the [2026-09-27 request](fix/2026-09-27-002407-graph-scheduling-and-postgres-cli-issues.md).
- [Skill document integrity and read budget fixes](fix_complete/2026-09-27-012724-skill-document-integrity-and-read-budget.md) — 2026-09-27 01:27:24 KST; findings 1–2 of the [2026-09-27 01:22 request](fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md).
