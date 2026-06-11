---
id: 1908
title: "standalone: re-split and fix residual isSameValue bucket after #1776/#1807"
status: in-review
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, testing
language_feature: equality, test262-harness
goal: standalone-mode
related: [1776, 1807, 1623]
test262_bucket: issamevalue-invalid-wasm
test262_count: 0
claimed_by: codex-developer
claimed_at: 2026-06-07T13:10:29.348Z
pr: 1257
---

# #1908 — Residual standalone `isSameValue` bucket

## Problem

The checked standalone report still assigns `5,556` failures to
`issamevalue-invalid-wasm`, even though the earlier focused owners are marked
done:

- `#1776` fixed the original externref invalid-Wasm case.
- `#1807` fixed the async-generator index-shift residual.

The bucket now needs a fresh split against the current report instead of
continuing to point only at completed issues.

## Scope

- Reproduce representative failures from the current standalone report.
- Determine whether the bucket is still invalid Wasm in `isSameValue`, a
  classifier over-match on assertion failures, or a new equality helper bug.
- If it is classifier drift, update `scripts/build-test262-report.mjs` so the
  failures move to their real owners.
- If it is a codegen bug, fix the smallest helper/emitter path and add a focused
  regression test.

## Acceptance Criteria

- The issue documents the current dominant signatures/files for the bucket.
- Either the `issameValue` invalid-Wasm count materially drops on a rebuilt
  standalone report, or the remaining failures are reclassified to more precise
  issues.
- Any code fix has a focused `tests/issue-1908.test.ts` regression.

## Findings — 2026-06-07

The residual bucket was classifier drift, not a new `isSameValue` codegen bug.
The checked standalone report's `issamevalue-invalid-wasm` bucket had `5,556`
rows, but `5,550` were `assertion_fail`, `2` were `unreachable`, `1` was
`runtime_error`, and `3` were `promise_error`; there were no `wasm_compile`
rows in the bucket. The dominant signatures were ordinary assertion locations:

- `assert.sameValue(C[''], 'get string')`
- `assert.sameValue(x, #)`
- `assert.sameValue(c['#'](), '#')`
- `assert.sameValue(result.done, false, 'First result done flag')`
- `assert.sameValue(c[# + # - # * # / # ** #](), #)`

Representative files were class/computed-name and generator assertion tests:

- `test/language/statements/class/accessor-name-static/literal-string-empty.js`
- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-assignment.js`
- `test/language/statements/class/cpn-class-decl-computed-property-name-from-string-literal.js`
- `test/language/statements/class/definition/methods-gen-yield-as-generator-method-binding-identifier.js`
- `test/language/statements/class/cpn-class-decl-fields-methods-computed-property-name-from-math.js`

Fix: narrowed `issamevalue-invalid-wasm` in `scripts/build-test262-report.mjs`
to actual Wasm validator failures naming the `isSameValue` helper, e.g.
`Compiling function #N:"isSameValue" failed: ... expected type ...`. Plain
`assert.sameValue(...)` assertion failures now fall through to the real
feature buckets.

Validation rebuild:

```bash
node scripts/build-test262-report.mjs \
  --input .test262-cache/test262-standalone-current.jsonl \
  --output public/benchmarks/results/test262-standalone-report.json \
  --target standalone \
  --include-proposals \
  --baseline-sha e6eedd6821a281063fc28e768431a09cfa98f340 \
  --baseline-generated-at 2026-06-06T19:01:40Z \
  --max-unclassified-root-causes 0
```

Result: `issamevalue-invalid-wasm` is absent from the rebuilt checked report
(`0` rows, down from `5,556`), `root_cause_map.classified` remains `30,733`,
and `root_cause_map.unclassified.count` remains `0`. The former samples now
land in more precise buckets, including:

- `class-prototype-private-descriptor`: `3,226` -> `4,723`
- `standalone-iterator-protocol`: `2,514` -> `4,247`
- `standalone-dynamic-object-property`: `8,163` -> `8,892`

Focused regression: `tests/issue-1908.test.ts` pins both sides of the split:
a real `isSameValue` validator failure remains in `issamevalue-invalid-wasm`,
while a class `assert.sameValue(...)` assertion failure reclassifies to
`class-prototype-private-descriptor`.

## Revalidation — 2026-06-07

- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- Rebuilt the standalone report from
  `.test262-cache/test262-standalone-current.jsonl` against current
  `origin/main` (`9c25e310c4b31caa4f502cfbceb975016fb50663`); the
  `issamevalue-invalid-wasm` bucket remained absent, classified stayed
  `30,733`, and unclassified stayed `0`.

## Revalidation After Main Merge — 2026-06-07

- Merged current `origin/main`
  (`5bef49a5abaae3e0ae65d41cfda6844d06197d06`) into `symphony/1908` and
  resolved the report-builder conflict by keeping both the #1908
  `isSameValue` validator matcher and main's #1910 `ToPrimitive` matcher.
- Rebuilt `public/benchmarks/results/test262-standalone-report.json` from the
  current `loopdive/js2wasm-baselines` `test262-standalone-current.jsonl`
  snapshot cached as `.test262-cache/test262-standalone-current-main.jsonl`;
  `issamevalue-invalid-wasm` drops from the current main report's `5,567`
  rows to `0`, `root_cause_map.classified` is `30,688`, and
  `root_cause_map.unclassified.count` is `0`.
- `pnpm exec vitest run tests/issue-1908.test.ts tests/issue-1910.test.ts`
  passed.

## Final Revalidation — 2026-06-07

- Merged current `origin/main`
  (`3827daa96e6b7147a30474c85a065e8b35bafed2`) into `symphony/1908` before
  republishing PR #1257.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
- After `origin/main` advanced again to
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, merged it into
  `symphony/1908`; `pnpm exec vitest run tests/issue-1908.test.ts` still
  passed.

## Retry Revalidation — 2026-06-07

- Confirmed fetched `origin/main`
  (`ff02d201152dc8777d3e8151ed05dddd47d75ecf`) is still an ancestor of
  `symphony/1908`; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.

## Codex Finalization — 2026-06-07

- Confirmed fetched `origin/main`
  (`ff02d201152dc8777d3e8151ed05dddd47d75ecf`) is still an ancestor of
  `symphony/1908`; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed on the assigned
  workspace after the final PR-state check.
- PR #1257 is open, ready for review, recorded in frontmatter, and #1908 stays
  `in-review` for the PR-status poller.

## Codex Retry Finalization — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; `origin/main`
  (`ff02d201152dc8777d3e8151ed05dddd47d75ecf`) is still an ancestor of
  `symphony/1908`, so no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and remains recorded in
  frontmatter while #1908 stays `in-review` for the PR-status poller.

## Codex Retry Blocker — 2026-06-07

- Attempted to push the retry metadata commit after local validation, but
  GitHub rejected the branch update because PR #1257 is already in the merge
  queue and queued branches cannot be updated without dequeueing the PR.
- GraphQL confirms PR #1257 has `mergeQueueEntry.state: QUEUED` at published
  head `b6037503df2758adca31ac96a57c364dba6e9886`.
- Per the publish-failure workflow, this local issue copy is left
  `in-progress`; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Requeue Prep — 2026-06-07

- PR #1257 was removed from the merge queue after `origin/main` advanced to
  `d4492156fbb45e50954700f8c1f3ca6b6e3970ef` via PR #1260; GitHub now reports
  the PR as conflicting (`mergeStateStatus: DIRTY`).
- The failing `check for test262 regressions` job on PR #1257 reports a broad
  48-test pass-to-other drift cluster dominated by `oob`, while the PR diff
  still only touches report classification, generated report data, this issue
  file, and `tests/issue-1908.test.ts`.
- Cross-checks against unrelated PR #1260 / merge-group Test262 runs showed the
  same broad `oob` regression-gate pattern, consistent with baseline/run drift
  rather than a #1908 codegen regression.
- Next step is merging current `origin/main`, preserving #1908's narrowed
  `isSameValue` validator classifier alongside main's RegExp bucket split, then
  rerunning the focused regression and requeueing PR #1257.

## Codex Requeue Merge — 2026-06-07

- Merged current `origin/main`
  (`d4492156fbb45e50954700f8c1f3ca6b6e3970ef`) into `symphony/1908` after PR
  #1257 was removed from the merge queue.
- Resolved the report-builder conflict by keeping #1908's validator-only
  `isSameValue` matcher and main's #1909 RegExp sub-bucket split.
- Rebuilt `public/benchmarks/results/test262-standalone-report.json` from the
  current `loopdive/js2wasm-baselines` standalone JSONL
  (`baseline_sha: ff02d201152dc8777d3e8151ed05dddd47d75ecf`); the
  `issamevalue-invalid-wasm` bucket remains absent (`0` rows), classified is
  `30,673`, and unclassified remains `0`.
- `pnpm exec vitest run tests/issue-1908.test.ts tests/issue-1909.test.ts
  tests/issue-1910.test.ts` passed.
- After `origin/main` advanced again to
  `c871fe467c6ce11ea89c0ce72437b9f3828c532b`, merged it into
  `symphony/1908`; that merge only brought in #1905 issue metadata.

## Codex Attempt 22 Finalization — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and merged it into
  `symphony/1908`; the merge only brought in #1905 issue metadata.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
- PR #1257 remains open, non-draft, targets `main`, and stays recorded in
  frontmatter while #1908 remains `in-review` for the PR-status poller.

## Codex Attempt 23 Publish Blocker — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of `symphony/1908`; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `gh pr merge 1257 --auto --merge --match-head-commit
  06e0a904ce757c972a8052e4b00c07a4abf8427c` reported that PR #1257 is already
  queued to merge. GraphQL confirms `mergeQueueEntry.state: QUEUED` with
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- GitHub also reports `mergeStateStatus: BLOCKED`: the latest `merge shard
  reports` job failed only in the stale-baseline guard. The standalone
  regression guard was clean (`improvements=0`, `wasm-change regressions=0`,
  `net=0`), but `js2wasm-baselines` is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which CI reported as 114 commits
  behind `origin/main` (max 50).
- Current `loopdive/js2wasm-baselines` `main`
  (`d084289b27be91e1fbea8199e5e916431cc9c8b3`) still has commit subject
  `chore(test262): refresh baselines — 30601/43135 host, 16358/43132
  standalone (ff02d201152dc8777d3e8151ed05dddd47d75ecf)`, so the queued PR may
  not advance until the baseline promotion is refreshed or the check is rerun
  against a current baseline.
- Attempted to push the local metadata commit, but GitHub rejected the update
  because PR #1257 is already in the merge queue and queued branches cannot be
  updated without dequeueing the PR. Per the publish-failure workflow, this
  local issue copy is left `in-progress`; the published issue file on
  `origin/symphony/1908` remains `in-review` with `pr: 1257`.

## Codex Attempt 24 Publish Blocker — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of `symphony/1908`; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `gh pr merge 1257 --auto --merge --match-head-commit
  06e0a904ce757c972a8052e4b00c07a4abf8427c` reported that PR #1257 is already
  queued to merge. GraphQL confirms `mergeQueueEntry.state: QUEUED`,
  `position: 7`, and `enqueuedAt: 2026-06-07T05:58:56Z`.
- Attempted to push the local metadata update, but GitHub rejected the branch
  update because queued PR branches cannot be updated without dequeueing the PR.
  Per the publish-failure workflow, this local issue copy remains
  `in-progress`; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 25 Publish Blocker — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of the published `origin/symphony/1908` PR head; no additional main
  merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- GraphQL confirms `mergeQueueEntry.state: QUEUED`, `position: 6`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`; GitHub still reports
  `mergeStateStatus: BLOCKED` because the latest `merge shard reports` check
  failed.
- This local issue copy remains `in-progress` because publishing the local
  issue metadata would require updating a branch that is already queued; the
  published issue file on `origin/symphony/1908` remains `in-review` with
  `pr: 1257`.

## Codex Attempt 26 Queue Confirmation — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of both the local `symphony/1908` branch and the published
  `origin/symphony/1908` PR head; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `gh pr merge 1257 --auto --merge --match-head-commit
  06e0a904ce757c972a8052e4b00c07a4abf8427c` reported that PR #1257 is already
  queued to merge. GraphQL confirms `mergeQueueEntry.state: QUEUED`,
  `position: 6`, and `enqueuedAt: 2026-06-07T05:58:56Z`.
- GitHub still reports `mergeStateStatus: BLOCKED` because the latest
  `merge shard reports` job failed only in the stale-baseline guard: the
  baseline main-sha `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is 114 commits
  behind `origin/main` (max 50).
- This local issue copy remains `in-progress` because publishing the local
  issue metadata would require updating a branch that is already queued; the
  published issue file on `origin/symphony/1908` remains `in-review` with
  `pr: 1257`.

## Codex Attempt 27 Queue Confirmation — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of both local `symphony/1908` and the published
  `origin/symphony/1908` PR head; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- GraphQL confirms `mergeQueueEntry.state: QUEUED`, `position: 5`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`; GitHub still reports
  `mergeStateStatus: BLOCKED`.
- The latest `merge shard reports` failure is still only the stale-baseline
  guard: `js2wasm-baselines` `main`
  (`d084289b27be91e1fbea8199e5e916431cc9c8b3`) is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which CI reported as 114 commits
  behind `origin/main` (max 50). The standalone regression guard in that run
  was clean (`improvements=0`, `wasm-change regressions=0`, `net=0`).
- This local issue copy remains `in-progress` because publishing the local
  issue metadata would require updating a branch that is already queued; the
  published issue file on `origin/symphony/1908` remains `in-review` with
  `pr: 1257`.

## Codex Attempt 28 Queue Confirmation — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed the #1908 code,
  report rebuild, and focused regression are already published on
  `origin/symphony/1908` at
  `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and is still recorded in
  frontmatter.
- GraphQL confirms `mergeQueueEntry.state: QUEUED`, `position: 5`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`; GitHub still reports
  `mergeStateStatus: BLOCKED`.
- The blocker remains the stale-baseline guard in the latest
  `merge shard reports` job: `loopdive/js2wasm-baselines` `main`
  (`d084289b27be91e1fbea8199e5e916431cc9c8b3`) is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which CI reported as 114 commits
  behind `origin/main` (max 50).
- This local issue copy remains `in-progress` because publishing the local
  issue metadata would require updating a branch that is already queued; the
  published issue file on `origin/symphony/1908` remains `in-review` with
  `pr: 1257`.

## Codex Attempt 29 Queue Confirmation — 2026-06-07

- Fetched current `origin/main`
  (`5b495ba4796f5a27fa4717b291f262e3f3232c88`) and confirmed it is still an
  ancestor of both local `symphony/1908` and the published
  `origin/symphony/1908` PR head; no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- GraphQL confirms `mergeQueueEntry.state: QUEUED`, `position: 4`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`; GitHub still reports
  `mergeStateStatus: BLOCKED`.
- The latest `merge shard reports` failure remains the stale-baseline guard:
  the standalone regression guard was clean (`improvements=0`,
  `wasm-change regressions=0`, `net=0`), but the baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is still 114 commits behind
  `origin/main` (max 50).
- Attempted `git push origin symphony/1908`; the pre-push typecheck/lint,
  format check, and issue-integrity hook passed, but GitHub rejected the branch
  update because queued PR branches cannot be updated without dequeueing the
  PR. This local issue copy remains `in-progress`; the published issue file on
  `origin/symphony/1908` remains `in-review` with `pr: 1257`.

## Codex Attempt 30 Queue Blocker — 2026-06-07

- Fetched current `origin/main`
  (`d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`) and merged it locally into
  `symphony/1908`; the merge only brought in #1832 issue/test updates.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
- PR #1257 is open, non-draft, targets `main`, and the published branch still
  points at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- GraphQL confirms `mergeQueueEntry.state: QUEUED`, `position: 2`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- The latest `merge shard reports` failure is still only the stale-baseline
  guard: `loopdive/js2wasm-baselines` `main`
  (`d084289b27be91e1fbea8199e5e916431cc9c8b3`) is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`; that run's standalone guard was
  clean (`improvements=0`, `wasm-change regressions=0`, `net=0`).
- This local issue copy remains `in-progress` because publishing the local
  metadata/current-main merge would require updating a branch that is already
  queued; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 31 Queue Blocker — 2026-06-07

- Fetched current `origin/main`
  (`d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`) and confirmed the local
  `symphony/1908` branch already contains that main merge; the published PR
  branch still points at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and GraphQL reports
  `mergeQueueEntry.state: QUEUED`, `position: 2`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- The latest failed `merge shard reports` job is still blocked only by the
  stale-baseline guard: the standalone guard was clean (`improvements=0`,
  `wasm-change regressions=0`, `net=0`), but baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is 114 commits behind current
  `origin/main` (max 50). The `loopdive/js2wasm-baselines` `main` ref remains
  `d084289b27be91e1fbea8199e5e916431cc9c8b3`.
- Attempted `git push origin symphony/1908`; the pre-push typecheck/lint,
  format check, and issue-integrity hook passed, but GitHub rejected the branch
  update because PR #1257 is already queued and queued branches cannot be
  updated without dequeueing the PR. This local issue copy remains
  `in-progress`; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 32 Queue Blocker — 2026-06-07

- Fetched current `origin/main`
  (`d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`) and confirmed the local
  `symphony/1908` branch already contains that main merge; the published PR
  branch still points at `06e0a904ce757c972a8052e4b00c07a4abf8427c`.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and GraphQL reports
  `mergeQueueEntry.state: AWAITING_CHECKS`, `position: 1`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- The latest failed PR `merge shard reports` job still fails only in the
  stale-baseline guard: the standalone guard was clean (`improvements=0`,
  `wasm-change regressions=0`, `net=0`), but baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is 114 commits behind
  `origin/main` (max 50).
- This local issue copy remains `in-progress` because publishing the local
  metadata/current-main merge would require updating a branch that is already
  queued; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 33 Queue Blocker — 2026-06-07

- Fetched current `origin/main`
  (`d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`) and confirmed it is included in
  the local `symphony/1908` branch, but not in the published
  `origin/symphony/1908` PR head
  (`06e0a904ce757c972a8052e4b00c07a4abf8427c`).
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and GraphQL reports
  `mergeQueueEntry.state: AWAITING_CHECKS`, `position: 1`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- The latest failed PR `merge shard reports` job still fails only in the
  stale-baseline guard: baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is 114 commits behind
  `origin/main` (max 50).
- This local issue copy remains `in-progress` because publishing the local
  metadata/current-main merge would require updating a branch that is already
  queued; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 34 Queue Blocker — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  remains `d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`, which is included in
  the local `symphony/1908` branch, but not in the published PR head
  (`06e0a904ce757c972a8052e4b00c07a4abf8427c`).
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and GraphQL reports
  `mergeQueueEntry.state: AWAITING_CHECKS`, `position: 1`, and
  `enqueuedAt: 2026-06-07T05:58:56Z`.
- The merge queue ran merge-group branch
  `gh-readonly-queue/main/pr-1257-d6957d5dcdd238fc53bf6fc58a58ef4c6d44f172`
  at `031a74264694512c9d5a007d7d29c7174cabb0e5`; its changed paths are only
  the #1908 report classifier, generated standalone report, issue file, and
  focused regression test.
- Merge-group `Test262 Sharded` failed only in `merge shard reports` job
  `79940616124`: catastrophic guard stayed below threshold
  (`41` wasm-change regressions vs `200` threshold), standalone guard was
  clean (`improvements=0`, `wasm-change regressions=0`, `net=0`), and the
  failing stale-baseline guard reported baseline main-sha
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is `118` commits behind
  `origin/main` (max `50`).
- This local issue copy remains `in-progress` because publishing the local
  metadata/current-main merge would require updating a branch that is already
  queued; the published issue file on `origin/symphony/1908` remains
  `in-review` with `pr: 1257`.

## Codex Attempt 35 Current-Main Refresh — 2026-06-07

- Fetched current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) and merged it into
  `symphony/1908` after PR #1257 left the merge queue; the merge brought in
  other issue metadata updates only.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
- PR #1257 remains open, non-draft, targets `main`, and stays recorded in
  frontmatter while #1908 remains `in-review` for the PR-status poller.

## Codex Attempt 36 Queue Blocker — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is already an ancestor of
  `symphony/1908`, so no additional main merge was needed before publishing.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and remains recorded in
  frontmatter.
- GitHub accepted PR #1257 into the merge queue and ran merge-group branch
  `gh-readonly-queue/main/pr-1257-28c668ab4e636011d08ac4e518acc4353097f5f1`
  at `72fe08dd20fae54f69d46dcf8e0eefa9240b4d54`, but the final
  `merge shard reports` job failed and GitHub removed the PR from the queue.
- The merge-group failure was only the stale-baseline guard: catastrophic guard
  stayed below threshold (`62` wasm-change regressions vs `200` threshold),
  the standalone guard was clean (`improvements=0`, `wasm-change
  regressions=0`, `net=0`), and `js2wasm-baselines` is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which CI reports as `202`
  commits behind current `origin/main` (max `50`).
- This local issue copy remains `in-progress` per the publish/enqueue blocker
  rule until the baseline promotion is refreshed and PR #1257 can be queued
  successfully again.

## Codex Attempt 37 Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is already an ancestor of
  `symphony/1908`.
- PR #1257 is open, non-draft, targets `main`, and is recorded in frontmatter.
- Dequeued PR #1257 to publish the issue metadata update because GitHub blocks
  branch updates while a PR is already in the merge queue.
- After publishing the metadata update, re-enabled auto-merge/merge-queue entry
  for PR #1257 so GitHub can queue it when the required checks pass.
- Frontmatter status is `in-review` so the PR-status poller can flip the issue
  after GitHub reports the PR merged.

## Codex Attempt 38 Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is already an ancestor of
  `symphony/1908`.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and is recorded in frontmatter.
- GraphQL reported `mergeStateStatus: CLEAN`, all visible PR checks successful,
  and `mergeQueueEntry.state: QUEUED` before this metadata refresh.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 39 Queue Blocker — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is already an ancestor of
  `symphony/1908`, so no additional main merge was needed before publishing.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and remains recorded in
  frontmatter.
- Before this metadata refresh, GraphQL reported
  `mergeQueueEntry.state: QUEUED`, `position: 15`, and
  `mergeStateStatus: BLOCKED`.
- The latest `merge shard reports` failure is still only the stale-baseline
  guard: catastrophic guard stayed below threshold (`43` wasm-change
  regressions vs `200` threshold), the standalone guard was clean
  (`improvements=0`, `wasm-change regressions=0`, `net=0`), and
  `js2wasm-baselines` is still generated from
  `ff02d201152dc8777d3e8151ed05dddd47d75ecf`, which CI reports as `202`
  commits behind current `origin/main` (max `50`).
- Frontmatter status remains `in-review` for the PR-status poller; the
  remaining blocker is external baseline promotion rather than #1908's
  classifier/test changes.

## Codex Attempt 40 Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is still an ancestor of both
  local `symphony/1908` and the published PR head.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `dcc4280453590fc196804dd1bf1fd9cc1d277ee4`.
- GraphQL reports `mergeStateStatus: UNSTABLE`, `mergeable: MERGEABLE`, and
  `mergeQueueEntry.state: QUEUED`, `position: 18`, `enqueuedAt:
  2026-06-07T11:50:57Z`; visible Test262 checks are still running on the
  queued head.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 41 Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is still an ancestor of local
  `symphony/1908`.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `728ee2fa4e241ccd677dd6dbe4f8995653ff3d84`.
- GraphQL reports `mergeStateStatus: BLOCKED`, `mergeable: MERGEABLE`, and
  `mergeQueueEntry.state: QUEUED`, `position: 16`, `enqueuedAt:
  2026-06-07T11:57:08Z`.
- The queued Test262 Sharded run had all shard jobs successful and the final
  `merge shard reports` job still in progress at the time of this check.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 42 Pre-Publish Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`28c668ab4e636011d08ac4e518acc4353097f5f1`) is already an ancestor of both
  local `symphony/1908` and the published PR head.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- Before publishing this metadata refresh, PR #1257 was open, non-draft,
  targeted `main`, and the published branch pointed at
  `5a278574d0e8848255fced0b91d03fef5aa33928`.
- GraphQL reported `mergeStateStatus: BLOCKED`, `mergeable: MERGEABLE`, and
  `mergeQueueEntry.state: QUEUED`, `position: 16`, `enqueuedAt:
  2026-06-07T12:14:54Z` before the PR was dequeued for the metadata push.
- The visible PR checks are successful except the queued Test262 Sharded
  `merge shard reports` job, which was still in progress at the time of this
  check.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 43 Publish/Auto-Merge State — 2026-06-07

- Dequeued PR #1257 so GitHub would accept the issue metadata update, then
  pushed `symphony/1908` to `origin`.
- Re-enabled auto-merge/merge-queue entry for the updated PR head with
  `gh pr merge 1257 --auto --merge --match-head-commit`.
- GraphQL reported `autoMergeRequest.mergeMethod: MERGE` and
  `mergeQueueEntry: null` while required checks were still running, so GitHub
  should enqueue the PR after those checks pass.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 44 Current-Main Merge — 2026-06-07

- Fetched current `origin/main`
  (`767e647548cad3c799f0af573afc752abd41dd29`) and merged it into
  `symphony/1908` after GitHub reported PR #1257 was behind.
- The merge brought in #1886 changes from main and did not conflict with the
  #1908 classifier, report, regression test, or issue metadata.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed after the merge.
- Frontmatter status remains `in-review` for the PR-status poller; PR #1257
  remains the ready review PR for this issue.

## Codex Attempt 45 Queue Confirmation — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`767e647548cad3c799f0af573afc752abd41dd29`) is already an ancestor of both
  local `symphony/1908` and the published PR head.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `dc0329b64079c36cfc40b4b1992e6d60cdf6fdc4`.
- GraphQL reports `mergeStateStatus: BLOCKED`, `mergeable: MERGEABLE`, and
  `mergeQueueEntry.state: QUEUED`, `position: 13`, `enqueuedAt:
  2026-06-07T12:34:54Z`.
- The visible PR check rollup shows the issue-specific CI and all Test262 shard
  jobs successful; the remaining failed check is the final `merge shard
  reports` job, consistent with the previously documented external
  stale-baseline blocker rather than a #1908 classifier/test regression.
- Frontmatter status remains `in-review` for the PR-status poller.

## Codex Attempt 46 Queue Blocker — 2026-06-07

- Fetched `origin/main` and `origin/symphony/1908`; current `origin/main`
  (`767e647548cad3c799f0af573afc752abd41dd29`) is already an ancestor of
  `symphony/1908`, so no additional main merge was needed.
- `pnpm exec vitest run tests/issue-1908.test.ts` passed.
- PR #1257 is open, non-draft, targets `main`, and the published branch points
  at `83fbc0cb26d428abff1d639c21319552f8212335`.
- GraphQL reports `mergeStateStatus: BLOCKED`, `mergeable: MERGEABLE`, and
  `mergeQueueEntry.state: QUEUED`, `position: 11`, `enqueuedAt:
  2026-06-07T12:57:01Z`.
- The latest `merge shard reports` failure is still only the external
  stale-baseline guard: catastrophic guard stayed below threshold (`53`
  wasm-change regressions vs `200` threshold), the standalone guard was clean
  (`improvements=0`, `wasm-change regressions=0`, `net=0`), and the baseline
  main-sha `ff02d201152dc8777d3e8151ed05dddd47d75ecf` is `210` commits behind
  `origin/main` (max `50`).
- Frontmatter status remains `in-review` for the PR-status poller; the
  remaining blocker is baseline promotion freshness, not #1908's
  classifier/test changes.
