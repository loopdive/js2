---
id: 3800
title: "42% of merged PRs land with no issue reference, and half the apparent status drift is a false positive"
status: ready
created: 2026-07-31
priority: high
horizon: m
feasibility: medium
task_type: process
area: ci
goal: ci-hardening
sprint: current
related: [3474, 2048, 2093]
---

# #3800 — the issue tracker cannot be trusted as a record of what landed

## Measured, not estimated

Audit of every PR merged into `loopdive/js2` between the `sprint/76` tag
(1282287, 2026-07-24) and 2026-07-30. Denominator is **314 merged PRs**.

| bucket | count | share |
| --- | ---: | ---: |
| references an issue in the title | 182 | 58% |
| **no issue reference at all** | **132** | **42%** |

Of the 132 unreferenced, **111 are substantive** (`fix` 44, `feat` 36,
`refactor` 23, `perf` 8); only 21 are `docs`/`chore`/`ci`/`test`/`release`.
By scope the largest cluster is **`ir` (49 PRs)** — the IR migration is landing
almost entirely untracked at the issue level — then `bench`/`benchmarks` (10),
`npm-compat` (4), `json` (4).

## The second finding: naive reconciliation makes it WORSE

Of the 182 referencing PRs, 112 pointed at an issue still open
(`ready`/`in-progress`/`in-review`). That looks like 112 status flips waiting to
be applied. **Exactly half of them would have been wrong.**

| refinement | survivors |
| --- | ---: |
| all stale refs | 112 |
| …from `fix`/`feat`/`perf`/`refactor` only (a PR that *completes*) | 56 |
| …primary ref only (`type(#N):` or trailing `(#N)`, not incidental mentions) | 46 |
| …excluding multi-PR / sliced epics | 27 |
| …excluding issue files with unchecked criteria or slice sections | **12** |

Each filter removed a real false-positive class:

1. **`docs`/`chore` PRs FILE issues, they don't fix them.** `docs(#3760): file
   legacy detectI32LoopVar body-blind miscompile` *created* #3760. Marking it
   `done` would close a bug that was never fixed. 56 of 112 were this.
2. **Incidental co-mentions.** PR #3619 is titled `fix(#3615): …` but also names
   #3623 in the body of the title; a naive scan credits both.
3. **Slices of multi-phase epics.** `refactor(ir): own vec host bridges
   structurally (#3520 C30)` is slice C30 of an epic with 8 unchecked criteria.
4. **Case-sensitivity.** A slice filter matching `part` misses `(Part B)` —
   #3474 slipped through until the check moved from the title to the issue file.

This is why `reconcile-tasklist.mjs` is deliberately **report-only** for
frontmatter. The lesson generalises: **the PR→issue mapping is not
machine-derivable from titles alone.**

## Why it matters

- The frozen sprint record undercounts. Sprint 77 froze 79 issues; the true
  figure is higher, and unknowable without per-issue verification. Any
  "issues completed" metric built on this is a floor, not a census.
- Work with no issue has no acceptance criteria, so "done" is never checked
  against anything — the same failure mode #3474 exists to catch.
- A 49-PR IR migration with no issue trail cannot be audited for coverage,
  which is exactly what the #2855 ratchet needs.

## Proposed fix

1. **Require an issue reference to merge.** A cheap-gate check that fails a PR
   whose title has no `#NNNN` resolving to a file in `plan/issues/`. Allow an
   explicit `no-issue:` escape in the PR body for genuine one-offs, so the
   escape is *recorded* rather than silent.
2. **Distinguish "fixes" from "files".** Adopt `fixes #N` / `files #N` in PR
   bodies so post-merge reconciliation has an unambiguous verb instead of
   inferring intent from the conventional-commit type.
3. **Auto-flip on merge for the unambiguous case only** — single primary ref,
   completing type, target issue has no unchecked criteria and no slice
   sections. That is the 12/112 set this audit validated by hand; automate
   exactly that and leave the rest for human judgment.
4. **Backfill the IR cluster** against the `backend-agnostic-ir` goal so the
   migration has an auditable trail.

## Acceptance

- A PR with no resolvable issue reference and no recorded `no-issue:` escape
  fails a required check.
- Reconciliation reports "auto-flippable" and "needs judgment" as separate
  counts, and never writes frontmatter for the second.
- The 132 unreferenced PRs from this window are either backfilled or explicitly
  waived.

## Reproduce

```bash
gh pr list -R loopdive/js2 --state merged --limit 800 \
  --search "merged:>=2026-07-24" --json number,title,mergedAt
```
Then bucket by whether the title carries a `#NNNN` that resolves to a file in
`plan/issues/`.
