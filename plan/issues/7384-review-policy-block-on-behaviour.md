---
id: 7384
title: "Review policy for IR PRs: block on behaviour, two rounds, no re-review of merges"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: process
area: process
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Review policy: keep the defect hunt, drop the tail

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R7. This changes a project-lead rule (`CLAUDE.md`, "IR path: code quality comes first",
step 2); it needs the lead's decision.

## Problem

Review census, 2026-11-05 to 11-19 (85 PRs with a recorded verdict; 22 threads read in full, the rest from verdicts):

- 29 first reviews blocked on a real PR-introduced behaviour defect, 10 on a claim-then-withdraw, 13 on design or
  proof only, 32 passed.
- About 196 rounds, 2.3 per PR, maximum 7. About 69 % of rounds found no real defect (estimate); at least 19
  re-reviews of merge resolutions found nothing.
- In 14 reviews read in full, 32 % of findings were proof/ceremony and 23 % nits.
- Median 62 min per blocking round; about 220 PR-hours of delay in 14 days (estimate).
- Meanwhile 3 real regressions passed review and were caught by the merge queue; 2 reached main.

## To decide

- Blocking set: wrong answer, crash, invalid Wasm, verdict regression, new claim-then-withdraw, and a design defect
  that the plan's quality criterion names. Everything else is a comment the author may batch into a follow-up.
- Cap of two blocking rounds; a third needs the lead.
- No review for docs-only, test-only and data-only PRs; no re-review of a merge of main unless it had conflicts in
  `src/`.
- One design review per mechanism before code, instead of design findings per slice.

## Acceptance criteria

1. `CLAUDE.md` states the new rule and the reviewer brief matches it.
2. Two weeks after: rounds per PR, share of rounds with a blocking finding, and defects that escaped to the merge
   queue or main are re-measured against the figures above.
