# Documentation conventions

This directory provides a reusable documentation workflow for a project. Write all
documentation in English, including summaries of conversations held in other languages.
Preserve literal code, commands, identifiers, and diagnostic output when needed as evidence.

## Navigation

| Directory | Purpose |
| --- | --- |
| [adr](adr/README.md) | Significant architecture decisions and their consequences |
| [ad00](ad00/README.md) | User conversations, requirements, and decision evidence |
| [ad01](ad01/README.md) | Plans and designs organized by design code |
| [pm01](pm01/README.md) | Implementation phases, tasks, planned tests, and progress |
| [de01](de01/README.md) | Implementation work records |
| [te01](te01/README.md) | QA results and supporting evidence |
| [wiki](wiki/README.md) | Implemented features and usage guides |

[Releasing](releasing.md) is the project-specific release runbook.

## Start a new project

1. Copy this README and the directory READMEs. Do not copy project records, evidence,
   populated index rows, or the previous project's abbreviation registry.
2. Adapt or replace `releasing.md` for the new project's release process.
3. Record the initial user conversation in ad00. Ask the user for the project and
   area abbreviations before assigning design codes if they have not provided them.
4. Register the agreed abbreviations in ad01, linking to the ad00 decision.
5. Create a design, then its implementation tasks and planned tests before implementation.

This documentation setup is the bootstrap step; it does not require an invented design
code or retroactive implementation plan. Feature and design work follows the workflow below.

## Names and identifiers

Use these paths relative to the repository root:

```text
docs/adr/{number}-{topic}.md
docs/ad00/{date}/{sequence}-{topic}.md
docs/ad01/{code}/{date}-{sequence}.md
docs/pm01/{code}/phase{phase}/task{task}.md
docs/de01/{code}/phase{phase}/task{task}-{worker}-{sequence}.md
docs/te01/{code}/phase{phase}/task{task}-{worker}-{sequence}.md
docs/te01/{code}/phase{phase}/assets/{record-stem}/{artifact-name}
docs/wiki/{topic}.md
```

- `date`: `YYYYMMDD`, taken from the system clock when creating the record. No explicit
  timezone declaration is required. Keep the creation date in the filename when editing.
- `topic` and artifact names: descriptive English lowercase kebab-case.
- `code`: `{project abbreviation}-{area abbreviation}-{sequence}`. Abbreviations use
  uppercase letters or digits; the sequence starts at `001` within each project/area pair.
  `PROJ-API-001` is an illustration, not an assigned project code.
- Project and area abbreviations must be agreed with the user in ad00. Reuse existing
  agreements; ask only for missing abbreviations. Never infer or silently assign them.
- `phase`: starts at `001` within a design code. `task`: starts at `001` within a phase.
  Identify a task by its full code/phase/task combination, not just its task number.
- ad00 `sequence`: starts at `001` per date. ad01 `sequence`: starts at `001` per code/date.
- `worker`: the platform that performed the work, such as `codex` or `claude_code`.
  Use a stable lowercase snake_case identifier. It is not a person's name or a unique agent ID.
- de01 and te01 `sequence`: starts at `001` per code/phase/task/worker within each directory.
  Separate QA runs, retries, and follow-up work receive new record numbers.
- ADR `number`: starts at `0001` across the project; the title is a kebab-case topic.
- Pad numbers to at least three digits, or four for ADRs. Never reuse allocated identifiers
  or renumber existing records when scope changes.

A task involving multiple designs has one primary design code and links to every related design.

## Parallel work

Platform names are not unique execution identities. Every implementation and QA record
must also contain an `Execution ID` identifying its session, agent, or run, and an `Owner`.

Before dispatching parallel work, a coordinator reserves record paths and assigns task
ownership. Different sessions on the same platform must receive different record numbers.
Create reservations without overwriting existing files (for example, exclusive file creation);
retry with the next number if a reservation already exists. For separate branches or worktrees,
allocate disjoint numbers centrally before dispatch: local file existence cannot prevent
cross-branch collisions. Do not rely on timestamps or platform names for uniqueness.

Each worker writes its assigned records. The coordinator serializes changes to shared indexes
and task status, reconciles conflicts, and preserves both records if a collision is discovered.
Reassign a colliding unmerged record and update its references before integration.
Dependent tasks must wait for their prerequisites; parallel execution does not remove dependencies.

## Evidence and design workflow

### ad00: Conversation records

Summarize conversations accurately in English; a full transcript is not required. Include:

- Date and topic, participants, and a conversation reference when available.
- User requirements, constraints, and scope exclusions.
- Options discussed and the reasons for decisions.
- Confirmed decisions, explicitly separated from proposals and assumptions.
- Open questions and links to related or follow-up records.

Never describe an assistant suggestion as a user agreement. Do not invent conversations
or infer missing historical evidence. Record changed requirements in a new conversation record
and link to the earlier record. Update the ad00 index when adding a record.

### ad01: Design documents

Every design must link to the relevant ad00 files and sections as its evidence. Include its
code, title, date, owner, status, goals, non-goals, requirements, proposed behavior,
interfaces or data model as applicable, alternatives, risks, acceptance criteria, and open questions.
Give acceptance criteria stable identifiers so tasks and QA can reference them.
Distinguish confirmed requirements from proposals awaiting a decision.

Use `draft`, `accepted`, `superseded`, or `withdrawn` as design status. Record the user agreement
in ad00 before marking a design accepted. Implementation tasks must reference an accepted design.
Keep one current accepted version per code in the ad01 index. A replacement links to its
predecessor; mark the predecessor superseded and link back. Do not silently overwrite accepted
requirements. Editorial corrections may be made in place.

### adr: Architecture decisions

ad01 describes a complete design unit; an ADR records a significant architecture choice that
is difficult to reverse or constrains later work. Routine implementation details do not need ADRs.
Include title/number, date, status, context, alternatives, decision, consequences, and links
to supporting ad00 and related ad01 documents.

Use `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or `Superseded` as ADR status. Record
acceptance evidence and replacement links. Follow accepted ADRs; when a design requires a
different decision, resolve it through a new ADR that supersedes the old one. Preserve the
original decision and rationale rather than silently rewriting them.

### pm01: Implementation plans

Split each design into phases and independently verifiable tasks. Each task includes:

- Full task identifier, title, owner, status, and dependencies.
- Links to the accepted design version, its ad00 evidence, and applicable ADRs.
- Scope, implementation steps, and referenced acceptance criteria.
- Planned tests with stable IDs, method or command, environment, expected result,
  and required evidence. Identify which checks are mandatory before work begins.
- Links to implementation records, QA results, and required wiki updates.
- Blockers, completion evidence, and reasons for any cancellation or reopening.

The task file is the authoritative status record; the pm01 README is its synchronized summary.
Use `planned`, `in-progress`, `in-qa`, `completed`, `blocked`, or `cancelled`.
Normal progression is `planned → in-progress → in-qa → completed`; QA failures return a task
to `in-progress`. Record the reason when blocking, resuming, cancelling, or reopening it.
Cancelled tasks are excluded from completion totals, shown separately, and never counted as passed.

### de01: Implementation records

Record actual work, including the full task ID/link, date, worker platform, owner, execution ID,
starting revision, changed files, implementation summary, resulting revision or patch reference,
checks performed and their results, deviations, remaining work, and the QA handoff.
For uncommitted work, identify the base commit and preserve an exact diff or equivalent artifact.
Link each deviation to the updated design and conversation evidence when requirements change.
Do not use a work log as an implicit design approval or task completion claim.

### te01: QA records

Every QA record must identify the task, implementation records, date, worker platform, owner,
execution ID, tested commit (or base commit plus exact patch), environment, and test scope.
For every planned test, record its ID, command or steps, expected result, actual result,
status (`passed`, `failed`, `blocked`, or `not-run`), and evidence link or attached output.
Record reasons for blocked or unexecuted checks. Include regression checks affected by the change.

Attach screenshots for screen tests. Attach logs or reports for CLI, library, and automated
tests. Store artifacts under the QA record's asset directory, with descriptive names and
relative links. Include sufficient output to assess the result and identify failures;
keep secrets and credentials out of evidence. A bare statement that tests passed is insufficient.

Preserve failed runs. Fixes and retests receive new records referencing earlier failures.
Evidence must match the implementation being completed. If code changes after QA, reassess
the impact and rerun affected checks against the updated revision.

Mark the pm01 task `completed` only when all of the following hold:

1. Every mandatory planned check has run and passed; none is failed, blocked, or not-run.
2. All acceptance criteria are met and linked to QA evidence.
3. Required wiki updates and implementation records are complete.
4. The task links to the passing QA record and verified revision; update the pm01 index together.

Passing only the tests that happened to run is not sufficient. A required check can be removed
only through an explicit, evidenced scope change reflected in ad00, ad01, and pm01; never
silently waive it to obtain a green result.

### wiki: Features and usage

Describe implemented behavior: setup, concepts, features, examples, configuration, troubleshooting,
and limitations as applicable. Keep planned features in design documents. Organize the wiki index
by user need, and update affected pages as part of the implementation task.

## Maintaining the documentation

- Keep relative Markdown links between conversation evidence, designs, tasks, work logs, QA,
  artifacts, and user documentation. Link to specific sections when the relevant scope is narrow.
- Update each affected index in the same change as its records. ad01 lists the current accepted
  version; pm01 lists every task and an overall/phase summary, including blockers and QA links.
- Requirements changes flow through ad00 → ad01 → pm01 before dependent implementation continues.
  Review ADRs, dependencies, tests, and wiki pages for impact; reopen completed tasks when necessary.
- Preserve historical decisions, execution records, and QA evidence. Correct factual errors explicitly.
  Git history complements, but does not replace, links showing which record supersedes another.
- Check paths, links, naming, index consistency, and evidence before marking documentation complete.
