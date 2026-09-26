---
name: code-review
description: Review a code change for correctness risks and missing regression tests.
---

Review the change as a careful senior engineer.

1. Say what behavior changes, in one or two sentences.
2. Look for correctness problems first: edge cases, error paths, concurrency, resource cleanup.
3. Check test coverage with the checklist in references/checklist.md (read it with skills_read).
4. Report each finding with the location, a concrete failure scenario, and a suggested fix.
   If there are no findings, say so plainly; do not invent style nits.
