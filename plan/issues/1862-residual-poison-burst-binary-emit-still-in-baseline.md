---
id: 1862
title: "residual poisoned-worker 'Binary emit error' burst still in published baseline (~269) despite #1808 cap"
status: done
created: 2026-06-04
updated: 2026-06-11
priority: high
feasibility: medium
task_type: test-infra
area: ci-infra, tests
goal: compiler-correctness
sprint: 61
related: [1808, 1154, 1221, 1080]
pr: 1285
claimed_by: codex-developer
claimed_at: 2026-06-07T10:28:52.179Z
completed: 2026-06-09
---
# #1862 — residual poisoned-worker emit-error burst still in the baseline

## Symptom

`/harvest-errors` re-run on 2026-06-04 against the latest baselines-repo run
(gitHash `dfb3df5e`, promoted ~10:13Z) still shows **269** tests with the
identical `L1:1 Binary emit error: offset is out of bounds`. The prior baseline
(`f52502e9`) had 291 — so the count barely moved (291 → 269) even though
**#1808's poisoned-worker hardening is an ancestor of `dfb3df5e`** (fix commits
`f39431830`/`916ddfcae`, verified in-tree).

This is the residual tail of a problem #1808 declared capped.

## Why these are NOT real per-test crashes

Confirmed by ground-truth on current HEAD:
- `tests/issue-1808.test.ts` (8 representatives across directories) — all pass.
- An ad-hoc probe compiling **6 random members of the 269** spanning
  `built-ins/TypedArray`, `language/arguments-object`, `language/asi`,
  `language/block-scope`, `language/comments`, `language/computed-property-names`
  — all compile clean, zero emit crashes.

Trivial files like `language/comments/*` and `language/asi/*` **cannot** trigger
an emit-offset overflow. They are innocent victims: one genuine emit failure
(the `built-ins` resizable-buffer/detached cluster — 187 of the 269) poisons the
long-lived `compiler-fork-worker.mjs` incremental-compiler instance, and every
subsequent compile in that worker inherits the identical error string until
recycle. (Full mechanism documented in #1808.) Spread of the 269:
`built-ins` 187 · `language` 54 · `annexB` 28.

## The gap

#1808 added `POISON_ERROR_RE` immediate-recreate (recreate the incremental
compiler the moment a compile emits/throws a poison-class error), claiming it
"caps the blast radius of a poisoned worker at one file." Yet the **published
baseline still carries ~269 of these phantom failures**, so one of:

1. **The cap is incomplete** — the worker still emits a burst before the
   recreate takes effect (e.g. the recreate happens after the result is
   recorded, or the genuine trigger re-poisons each recycle), or
2. **Carry-forward** — `promote-baseline` merged these entries from an older
   shard/baseline without re-running them on `dfb3df5e`, so the hardening never
   executed against them.

Either way the published baseline **over-counts the failure set by ~269**
(≈0.6% of the official 43,135), understating the true pass rate, and makes
`/harvest-errors` chase ghost crashes (it did this round).

## Suggested investigation

1. Determine whether the `dfb3df5e` run actually re-compiled the 269 (check
   per-test timestamps / whether they bunch in one ~30s worker window like the
   `f52502e9` run did, per #1808's burst analysis) — distinguishes cap-incomplete
   (1) from carry-forward (2).
2. If (1): audit the order of operations in `compiler-fork-worker.mjs` — ensure
   the recreate happens BEFORE the next compile and that the poisoning result
   itself is re-run in a fresh worker (not recorded as the final verdict).
3. If (2): make `promote-baseline` re-run (not carry forward) any entry whose
   error matches `POISON_ERROR_RE`, so phantom bursts cannot persist across
   promotions. Ties to the #1080 baseline-drift umbrella.

## Acceptance criteria

- [x] Root cause classified: incomplete cap vs promote carry-forward.
- [ ] A fresh baseline run shows the `Binary emit error: offset is out of bounds`
      count drop to ~0 (matching isolated-compile ground truth), not ~269.
- [ ] `/harvest-errors` no longer surfaces this cluster.

## Implementation Findings

Attempt 22 classified the root cause as **incomplete cap in the active unified
test262 worker path**, not pure promote carry-forward.

- Refreshed the current baselines-repo JSONL on 2026-06-07 and found **271**
  rows with `Binary emit error: offset is out of bounds`.
- The rows are still tightly bunched in one live-run window:
  `2026-06-07 04:47:08`–`04:47:37` Europe/Berlin, spread across
  `built-ins` 201 · `language` 51 · `annexB` 19.
- `scripts/compiler-fork-worker.mjs` had the #1808 poison classifier, but the
  active vitest test262 path uses `scripts/test262-worker.mjs` via
  `CompilerPool(..., "unified")`. That unified worker did not classify returned
  `Binary emit error` diagnostics as poison, so it neither recycled the fork nor
  told the runner to distrust the current verdict.
- `tests/test262-shared.ts` also recorded the first poison-shaped
  `compile_error` directly into JSONL. That means even when a worker is
  recycled after a poison verdict, the contaminated verdict itself can become
  the published baseline row.

Fix:

- Added `scripts/test262-poison-error.mjs` as the shared poison classifier.
- Reused the classifier from `compiler-fork-worker.mjs`.
- Made `test262-worker.mjs` request worker recycle on poison-class thrown errors
  and returned compile-error diagnostics, before negative-test pass handling can
  mask the internal error.
- Made `tests/test262-shared.ts` retry poison-class `compile_error` rows once in
  a clean recycled worker and record only the retry result.
- Added `tests/issue-1862.test.ts` to pin the classifier and source wiring.

Validation:

- `node --check scripts/test262-poison-error.mjs`
- `node --check scripts/test262-worker.mjs`
- `node --check scripts/compiler-fork-worker.mjs`
- `pnpm test tests/issue-1862.test.ts`
- `pnpm test tests/issue-1808.test.ts`
- `pnpm exec prettier --check scripts/test262-poison-error.mjs scripts/compiler-fork-worker.mjs scripts/test262-worker.mjs tests/test262-shared.ts tests/issue-1862.test.ts`
- `pnpm exec biome lint tests/test262-shared.ts tests/issue-1862.test.ts --diagnostic-level=error`

Fresh full-baseline confirmation is intentionally left to CI/main promotion per
the scoped-validation rule; local full test262 was not run.

Attempt 30 re-ran the same scoped validation after merging current `origin/main`
on 2026-06-07; all commands passed.

## Notes

Surfaced re-running `/harvest-errors` after pulling 346 commits of sprint-58/59
work. Both prior harvest issues are genuinely fixed: **#1809** (shift-walker)
157→0 confirmed, **#1808** (emit crash) per-file clean. This issue is only about
the *baseline accounting* of the residual poison burst, not a codegen defect.
