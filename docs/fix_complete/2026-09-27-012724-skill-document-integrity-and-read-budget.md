# Completed: Skill Document Integrity and Read Budget Fixes

- Completed: 2026-09-27 01:27:24 KST (UTC+09:00).
- Request: [Skill Document Integrity and Read Budget Fixes](../fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md). Findings:
  - [1](../fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md#1-p2-resource-reads-bypass-skillmd-version-validation)
  - [2](../fix/2026-09-27-012222-skill-document-integrity-and-read-budget.md#2-p2-skill-load-responses-exceed-the-declared-read-budget)
- Base: `1c45fcb` (HEAD). The reviewed implementation was `674b362` (`Implements skills`). The commit reference is in [References](#references).

## 1. Resource reads bypass SKILL.md version validation (P2)

**Root cause (verified).** `skills_read` resolved `SKILL.md` like any other file. It checked a digest only against earlier reads of the same path in the same invocation, never against the digest the catalog pinned when the document was activated. So the first read of a changed `SKILL.md`:
- returned the new instructions;
- recorded them as a resource with a different digest from the invocation's `documentDigest`.

**Changes.**
- [`src/skills/catalog.ts`](../../src/skills/catalog.ts):
  - The internal `CatalogAccess.read` now returns the full document `text`, decoded from the same bytes that were checked against the catalog digest and parsed. It also accepts a `reserve` callback, which runs before the content is read.
  - New `isDocument(name, file)` compares device and inode with the skill's `SKILL.md`. Another spelling of the name, or a hard link, is therefore recognized as the document.
- [`src/skills/prepare.ts`](../../src/skills/prepare.ts): when the resolved path is the document, `skills_read` goes through `catalog.read`. This is the same digest-verified path `catalog.load` and `skills_load` use. It also checks that the digest equals the digest activated for this invocation.
  - A changed document is rejected with `SkillChangedError` and returns no content.
  - An unchanged document is returned whole, from the verified bytes. It is recorded as the invocation's document, not as a resource, so `usage()` never holds a contradictory entry.
  - Path restrictions, cancellation, per-invocation isolation, and change detection for ordinary resources are unchanged.

**Resulting behavior.** In the reproduction, step 5 now fails with `SkillChangedError` like step 4, returns no changed text, and `prepared.usage()` still shows the original `documentDigest` with no `SKILL.md` resource. A new catalog and preparation accept the updated document.

## 2. Skill load responses exceed the declared read budget (P2)

**Root cause (verified).** `skills_load` counted only the UTF-8 length of the Markdown body. The generated wrapper (name, digest, tags) and the activation note were not counted, and the reservation happened after the document had been read. With a one-byte budget, a one-byte body was loaded and 152 bytes were returned.

**Changes.**
- [`src/skills/prepare.ts`](../../src/skills/prepare.ts) — `skills_load`:
  - It builds its response with a single function (`loadResponse`) and counts that response's complete UTF-8 length.
  - Before reading the document's content, it reserves the least it could return: the wrapper and note with an empty body. A call that cannot fit is refused after a size check only.
  - After reading, a new `settle()` adjusts the reservation to the exact response size. The check and the update happen synchronously, so concurrent calls cannot oversubscribe the budget.
  - Activation, usage and the `ok` event happen only after the reservation succeeds. Any failure releases the reservation and emits an error event.
- `skills_read` of `SKILL.md` reserves the file size before reading and settles to the returned text. Ordinary `skills_read` behavior is unchanged: it reserves the file size, which equals the returned text.
- [`src/skills/types.ts`](../../src/skills/types.ts) documents what each limit controls:
  - `maxDocumentBytes` and `maxResourceBytes` bound filesystem reads per file.
  - `maxContextBytes` bounds system-prompt text.
  - `maxReadBytes` bounds tool-returned text. The documentation describes the reservation, settlement and release, and states that disk reads are bounded by the per-file limits, not by this budget.
- [`README.md`](../../README.md) states the same limit semantics, and how `skills_read` treats `SKILL.md`.

**Design note.** A first attempt reserved an upper bound (wrapper plus file size) before reading. The exact-boundary regression test showed that this refuses a response which fits exactly, because the file also contains the frontmatter. The minimal pre-read reservation plus atomic settlement satisfies both acceptance criteria:
- responses that fit exactly succeed;
- calls that cannot fit at all read no content.

**Resulting behavior.** The reproduction (body `A`, `maxReadBytes: 1`) now fails with `SkillLimitError`. No text is returned, the skill is not activated, usage stays empty, and only an error load event is emitted.

## Regression tests

The tests are in [`test/skills.test.ts`](../../test/skills.test.ts); 10 are new.

**Finding 1** ("SKILL.md through skills_read is pinned to the catalog version"):
- The reproduction with explicit activation and with activation through `skills_load`. Both `catalog.load` and `skills_read` reject, no changed text is returned, and usage is unchanged.
- An unchanged `SKILL.md` is returned whole and recorded as the document, not a resource.
- A hard link to the document is treated as the document. Changes to ordinary resources are still detected.
- A new catalog and preparation accept the updated document.

**Finding 2** ("skills_load counts its whole response against maxReadBytes"):
- The one-byte reproduction: nothing is returned, activated, recorded or charged.
- An exact boundary on a body with non-ASCII text: the complete response fits at exactly its UTF-8 length and is refused one byte below.
- Five parallel loads under a budget for two and a half responses: exactly two succeed.
- A load and a read share one budget, and a refused load leaves the remainder usable.
- An over-budget load is refused before reading content: its changed content is never checked, and the budget error comes first.

Against the pre-fix source (with `src/skills` stashed), 9 of the 10 new tests fail. The one that passes is the new-catalog test, which checks the supported path.

## Validation

All commands were run on 2026-09-27 against the final working tree.

| Command | Result |
| --- | --- |
| `npx vitest run test/skills.test.ts test/skills-integration.test.ts` | 37 passed. |
| `npm test` | 557 passed, 36 skipped. The skipped tests are the PostgreSQL server suite, which needs `UMIO_TEST_POSTGRES_URL`; this change touches no database code. |
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed (exit 0). |
| `npm run build` | Passed. |

## Remaining limitations

- `maxReadBytes` bounds returned text. A load that passes the pre-read check can still read up to `maxDocumentBytes` from disk and then be refused at settlement. That I/O is bounded per call by the per-file limit, as documented.
- Automatic verification of manifests on graph retry or resume remains the separately deferred feature noted in the request; it is not part of these fixes.

## References

- Commit: see `git log` for the commit titled "Fix skill document pinning and read budget accounting".
