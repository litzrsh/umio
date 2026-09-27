# Reusable documentation workflow

Date: 20260927
Participants: User and Codex
Source: The current repository conversation; no external conversation URL is available.

## Requirements and context

The user requested a review of documentation rules before creating `docs/README.md`.
The structure must also be reusable when starting other projects. All documentation is in English.

## Confirmed decisions

- Use adr for architecture decisions; ad00 for conversation evidence; ad01 for design units;
  pm01 for implementation phases, tasks, and planned tests; de01 for work records;
  te01 for QA evidence; and wiki for features and usage.
- Correct the proposed design document path from ad00 to ad01.
- Assign design codes from user-agreed project and area abbreviations. Ask when missing.
- Namespace phases and tasks by design code to avoid collisions across designs.
- Use `YYYYMMDD` from the system clock; no timezone declaration is needed.
- Interpret `worker` as the execution platform, such as `claude_code` or `codex`.
  The structure must accommodate parallel work.
- Apply the reviewed naming, evidence links, status rules, design/ADR distinction,
  navigation, QA completion criteria, and wiki maintenance recommendations.
- Delete the existing legacy documentation instead of migrating or preserving it.
- Preserve `docs/releasing.md` for releases.

## Alternatives and rationale

The initial proposal placed design files under ad00 and did not namespace task paths by
design. Separating ad01 and adding design codes preserves the evidence/design distinction
and avoids task path collisions. Explicit QA criteria prevent incomplete test execution
from being described as all green.

The assistant initially proposed `YYYY-MM-DD` with a declared timezone and a legacy
migration policy. The user replaced those with system-clock `YYYYMMDD` dates and legacy deletion.
The user clarified that worker denotes a platform, rather than an individual execution identity.

## Operational conventions

The [documentation conventions](../../README.md) implement these agreements. Execution IDs,
coordinated number reservations, and serialized index updates are operational details introduced
by Codex to support parallel work; they are not quotations of explicit user instructions.

## Open questions

No project or area abbreviation was assigned in this conversation. Ask the user before
creating the first design code. Creating the reusable documentation framework does not assign one.

## Scope exclusions

This change does not create feature designs, implementation plans, or retrospective conversation
records for discarded documents. The reusable directory READMEs start with empty design/task indexes.
