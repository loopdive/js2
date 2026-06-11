---
id: 1909
title: "standalone RegExp residual bucket after #1474/#682: split Phase 2d and native-engine gaps"
status: done
sprint: 61
created: 2026-06-07
updated: 2026-06-10
completed: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [682, 1474, 1539]
test262_bucket: standalone-regexp
test262_count: 1997
pr: 1291
claimed_by: codex-developer
claimed_at: 2026-06-07T12:26:29.742Z
---

# #1909 — Standalone RegExp residual bucket

## Problem

The standalone report still has `1,997` failures in `standalone-regexp` even
though the original native-RegExp umbrellas are marked done. Current samples
include unsupported flags and pattern forms such as `u`/`v`/`d`, lookahead,
negated shorthand inside character classes, and word-boundary variants.

## Scope

- Re-split the current RegExp bucket by signature and feature family.
- Land the smallest high-count native-engine slice if one is clearly ready
  (for example a contained flag/pattern form).
- Otherwise file child issues from the split and update the classifier so the
  dashboard stops pointing only at completed umbrellas.

## Acceptance Criteria

- `tests/issue-1909.test.ts` covers at least one newly-supported standalone
  RegExp residual or a classifier regression if this issue is analysis-only.
- The issue records the top current RegExp signatures and which child issue owns
  each.
- A rebuilt standalone report no longer treats the entire residual as only
  `#682/#1474`.

## 2026-06-07 implementation findings

This issue was handled as a classifier/split slice, not a compiler semantics
slice. I fetched the published standalone JSONL from
`loopdive/js2wasm-baselines`:

- Source:
  `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl`
- Rebuild command:
  `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909.json --target standalone --include-proposals --max-unclassified-root-causes 0`
- Root-cause map remained complete: `30,733 / 30,733` non-pass/non-skip rows
  classified, `0` unclassified.

The previous single `standalone-regexp` bucket had `1,997` rows:

- `1,730` compile errors
- `267` fail/runtime rows
- error categories: `other` 1,709, `assertion_fail` 206, `runtime_error` 37,
  `null_deref` 23, `wasm_compile` 16, `illegal_cast` 5, `oob` 1

After this change, the rebuilt report splits those same `1,997` rows:

| Count | Bucket                              | Owner                | Representative signatures                                                                                            |
| ----: | ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
|   833 | `standalone-regexp-phase-2d`        | #1911                | `flags "u"`, `flags "v"`, lookahead/lookbehind, regexp modifiers, Unicode/property escapes                           |
|   104 | `standalone-regexp-phase-2b`        | #1912                | word-boundary `\b`/`\B`, backreferences, negated shorthand in classes, class range compatibility                     |
|   452 | `standalone-regexp-string-protocol` | #1913                | `@@match`, `@@matchAll`, `@@replace`, `@@split`, `lastIndex`, split limit, replacement substitutions                 |
|   546 | `standalone-regexp-native-engine`   | #1914                | `pattern.source`, result `input/index`, `RegExp.prototype` descriptors, dynamic constructor/reflection/object access |
|    62 | `standalone-regexp` fallback        | #1909 + child issues | duplicate flags, syntax refusals, generic String.search/Reflect residuals needing later reassignment                 |

Implementation:

- Added ordered RegExp sub-buckets to `scripts/build-test262-report.mjs` ahead
  of the generic RegExp fallback.
- Filed child issues #1911, #1912, #1913, and #1914 for the current owners.
- Added `tests/issue-1909.test.ts` to lock representative classifier routing.
- Updated the older #1781 root-cause smoke test to expect the new
  native-engine sub-bucket for assertion/runtime RegExp rows.
- Before publishing, trimmed the PR net diff back to this issue's classifier,
  test, and RegExp child-issue files after syncing with current `origin/main`.

Validation:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

Final publish check after merging `origin/main` on 2026-06-07:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

The final rebuilt report keeps `30,733 / 30,733` standalone non-pass/non-skip
rows classified with `0` unclassified. The RegExp residual remains split into
`833` Phase 2d rows, `104` Phase 2b rows, `452` string-protocol rows, `546`
native-engine rows, and `62` fallback rows.

## 2026-06-07 PR status refresh

PR #1260 is open, ready for review, and still points at this issue branch. The
previous queue push blocker cleared after GitHub dropped the temporary merge
queue refs, but the remote PR head `a3fe42c32` now shows a failed
`check for test262 regressions` job:

- run: `https://github.com/loopdive/js2/actions/runs/27080559423/job/79926321031`
- summary: `62` pass-to-other transitions, `27` improvements, net `-35` pass
- baseline note in the failed log: baseline age `1h 20m` at commit `99b58e6`

The branch was then resynced with current `origin/main`, and the scoped local
validation listed above passed again.

## 2026-06-07 publish blocker after main sync

The final branch push was rejected because PR #1260 is back in GitHub's merge
queue:

- Remote PR head: `a3fe42c32`
- Local attempted head: `0808e70fc`
- Queue ref observed:
  `refs/heads/gh-readonly-queue/main/pr-1260-f4dd784d4f1960a8c759b51f0cff23e8f4ed4f34`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the current main-sync metadata can be pushed.

## 2026-06-07 queue refresh after reassignment

Scoped validation was rerun in this worktree after the reassignment:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts tests/issue-1910.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. At refresh time, PR #1260 remained open and ready,
with remote head `a3fe42c32`. GitHub had accepted it into the merge queue
again:

- Queue ref:
  `refs/heads/gh-readonly-queue/main/pr-1260-f4dd784d4f1960a8c759b51f0cff23e8f4ed4f34`
- Merge-group run:
  `https://github.com/loopdive/js2/actions/runs/27081078870`
- Current merge-group status at refresh time: `in_progress`

At that point the local branch still contained post-sync metadata commits that
could not be pushed while GitHub kept the PR branch in the merge queue.

## 2026-06-07 merged PR state

PR #1260 merged via the GitHub merge queue at `2026-06-07T03:16:41Z`:

- Merge commit: `d4492156fbb45e50954700f8c1f3ca6b6e3970ef`
- PR URL: `https://github.com/loopdive/js2/pull/1260`
- Final PR head included in the merge: `a3fe42c32`

After the merge, this branch was merged with current `origin/main` so the local
issue metadata is based on the merged PR state. The issue remains `in-review`
with `pr: 1260`; the PR-status poller owns the eventual `done` transition.

## 2026-06-07 follow-up metadata refresh

This issue was reassigned after PR #1260 had already merged. Current GitHub
state confirms PR #1260 is `MERGED`, ready/non-draft, with merge commit
`d4492156fbb45e50954700f8c1f3ca6b6e3970ef`.

The implementation remains complete and present on `origin/main`; this branch is
now carrying only the #1909 issue-state refresh so the plan metadata stays in
sync with the merged PR state.

Follow-up validation after merging current `origin/main`:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

The rebuilt report still classifies `30,733 / 30,733` standalone non-pass
non-skip rows. The RegExp split is unchanged: `833` Phase 2d rows, `104` Phase
2b rows, `452` string-protocol rows, `546` native-engine rows, and `62`
fallback rows.

Opened ready follow-up PR #1289 for this issue-state refresh.

## 2026-06-07 final PR refresh

Current GitHub state for PR #1289:

- URL: `https://github.com/loopdive/js2/pull/1289`
- State: open, ready/non-draft
- Head: `symphony/1909` at `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Merge state: `CLEAN`
- Checks: all reported PR checks succeeded

The issue remains `in-review` with `pr: 1289`; the PR-status poller owns the
eventual `done` transition after merge.

## 2026-06-07 queue push blocker

After the final PR refresh commit, the branch push was rejected because GitHub
has already added PR #1289 to the merge queue:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `83c265ff0`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after dequeue

GitHub no longer exposes a `gh-readonly-queue/main/pr-1289*` queue ref for PR
#1289, so the follow-up metadata refresh can be pushed again. Current PR state:

- URL: `https://github.com/loopdive/js2/pull/1289`
- State: open, ready/non-draft
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded

At this point the issue was moved back to `in-review` with `pr: 1289`; the
later queue push blocker below supersedes that local state.

## 2026-06-07 queue push blocker after dequeue refresh

The attempted refresh push was rejected because GitHub reported PR #1289 as
queued again:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `d7248f012`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after second dequeue

GitHub no longer exposes a `gh-readonly-queue/main/pr-1289*` queue ref for PR
#1289, so the latest metadata refresh can be pushed again. Current PR state:

- URL: `https://github.com/loopdive/js2/pull/1289`
- State: open, ready/non-draft
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded

This issue is moved back to `in-review` with `pr: 1289`; the PR-status poller
owns the eventual `done` transition after merge.

## 2026-06-07 queue push blocker after second dequeue refresh

The attempted refresh push was rejected because GitHub reported PR #1289 as
queued again:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `8eff1f74547b62a5890e018bde0cd7e8f21ba53e`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote` immediately before or after the push attempt
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until the queued
PR merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after third queue release

GitHub still has PR #1289 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1289`
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`

This issue is moved back to `in-review` with `pr: 1289`; the PR-status poller
owns the eventual `done` transition after merge.

## 2026-06-07 final validation after main refresh

Merged current `origin/main` into `symphony/1909` and reran scoped validation:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The implementation remains present on `origin/main`;
this branch carries the current `in-review` issue metadata for PR #1289.

## 2026-06-07 queue push blocker after third refresh

The attempted push after merging current `origin/main` and rerunning scoped
validation was rejected because GitHub reported PR #1289 as queued:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `a08587123`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote` immediately after the rejection
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1289
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after fourth queue release

GitHub still has PR #1289 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1289`
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

This issue is moved back to `in-review` with `pr: 1289`; the PR-status poller
owns the eventual `done` transition after merge.

## 2026-06-07 queue push blocker after fourth refresh

The attempted push after the live PR refresh and scoped validation was rejected
because GitHub reported PR #1289 as queued:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `acb707863a9fa4ea85b26986b15394f763bd3a99`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote` before the push attempt
- Merge queue command:
  `gh pr merge 1289 --auto --match-head-commit 19540cd895d2e9a2331cff3a52b976657f2c85a0`
  reported `Pull request #1289 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1289
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after fifth queue release

GitHub still has PR #1289 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1289`
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. This branch is based on current `origin/main`; its net
diff versus `origin/main` is limited to this issue-state refresh. This issue is
moved back to `in-review` with `pr: 1289`; the PR-status poller owns the
eventual `done` transition after merge.

## 2026-06-07 queue push blocker after fifth refresh

The attempted push after the live PR refresh and scoped validation was rejected
because GitHub reported PR #1289 as queued:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `aea968834327cb4bd966eab9ec5ebd9340f06d49`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote` immediately after the rejection
- Merge queue command:
  `gh pr merge 1289 --repo loopdive/js2wasm --auto --match-head-commit 19540cd895d2e9a2331cff3a52b976657f2c85a0`
  reported `Pull request #1289 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1289
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after sixth queue release

GitHub still has PR #1289 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1289`
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`

The branch is based on current `origin/main`, and its net diff versus
`origin/main` is limited to this issue-state refresh. This issue is moved back
to `in-review` with `pr: 1289`; the PR-status poller owns the eventual `done`
transition after merge.

## 2026-06-07 queue push blocker after sixth refresh

The attempted push after merging current `origin/main` was rejected because
GitHub reported PR #1289 as queued:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `2d89289ce036cb9d7bcef89ba002b679e2228e8c`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1289
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR refresh after seventh queue release

GitHub still has PR #1289 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1289`
- Remote head before this refresh: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Base: `main`
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`

The branch is based on current `origin/main`, and its net diff versus
`origin/main` is limited to this issue-state refresh. This issue is moved back
to `in-review` with `pr: 1289`; the PR-status poller owns the eventual `done`
transition after merge.

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed.

## 2026-06-07 queue push blocker after seventh refresh

The attempted push after the live PR refresh and scoped validation was rejected
because GitHub reported PR #1289 as queued:

- Remote PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Local attempted head: `877d3055c7ce2aa39e94b937b2f2b9bd7ecfd393`
- PR URL: `https://github.com/loopdive/js2/pull/1289`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1289*` ref was visible
  via `git ls-remote`
- Merge queue command:
  `gh pr merge 1289 --repo loopdive/js2 --auto --match-head-commit 19540cd895d2e9a2331cff3a52b976657f2c85a0`
  reported `Pull request #1289 is already queued to merge`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1289
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 merged PR refresh after reassignment

GitHub now reports PR #1289 as merged:

- URL: `https://github.com/loopdive/js2/pull/1289`
- State: merged, ready/non-draft before merge
- Final PR head: `19540cd895d2e9a2331cff3a52b976657f2c85a0`
- Merge commit: `44e1c37f605dc96972ff31b59716a0a0562be661`
- Merged at: `2026-06-07T09:01:31Z`

The implementation and earlier issue-state refresh are present on current
`origin/main`. Follow-up PR #1291 now carries this final merged-state metadata
refresh. This issue remains `in-review` with `pr: 1291`; the PR-status poller
owns the eventual `done` transition.

## 2026-06-07 live PR #1291 refresh after reassignment

Current GitHub state for PR #1291:

- URL: `https://github.com/loopdive/js2/pull/1291`
- State: open, ready/non-draft
- Head: `symphony/1909` at `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded

The branch was based on current `origin/main`, and its net diff versus
`origin/main` was limited to this issue-state refresh. At that point this issue
was moved back to `in-review` with `pr: 1291`; the queue push blocker below
supersedes that local state.

## 2026-06-07 queue push blocker after reassignment refresh

The attempted push after the live PR refresh and scoped validation was rejected
because GitHub reported PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `c223fdd467eefea5924f476bc67083398780ef05`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Queue ref visibility: no `gh-readonly-queue/main/pr-1291*` ref was visible
  via `git ls-remote`
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2 --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 queue recheck after reassignment

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Merge queue entry: `QUEUED`, position `7`, estimated time to merge `2818`
  seconds
- Auto-merge request: none reported; queue entry is active

`origin/main` remains an ancestor of the local branch. This issue remains
`in-progress` locally because GitHub reports PR #1291 is already queued to
merge, and queued branches cannot be updated with the latest local metadata
refresh.

## 2026-06-07 queue push blocker after reassignment recheck

The attempted push after the reassignment queue recheck was rejected because
GitHub reports PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `73b2d54b4`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR #1291 refresh after latest queue release

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote head before this refresh: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1291*` ref was visible
  via `git ls-remote`

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The branch remains based on current `origin/main`.
This issue is moved back to `in-review` with `pr: 1291`; the PR-status poller
owns the eventual `done` transition after merge.

## 2026-06-07 live PR #1291 refresh after current queue release

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote head before this refresh: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1291*` ref was visible
  via `git ls-remote`

The branch is based on current `origin/main`, and its net diff versus
`origin/main` remains limited to this issue-state refresh. This issue is moved
back to `in-review` with `pr: 1291`; the PR-status poller owns the eventual
`done` transition after merge.

## 2026-06-07 queue push blocker after current refresh

The attempted push after the live PR refresh was rejected because GitHub reports
PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `69f1c5724`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 queue push blocker after latest refresh

The attempted push after the latest live PR refresh and scoped validation was
rejected because GitHub reports PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `ada2c1a9e`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2 --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 live PR #1291 refresh for current handoff

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote head before this refresh: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Queue ref visibility: no `gh-readonly-queue/main/pr-1291*` ref was visible
  via `git ls-remote`

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The branch is based on current `origin/main`, and
this issue is moved back to `in-review` with `pr: 1291`; the PR-status poller
owns the eventual `done` transition after merge.

## 2026-06-07 queue push blocker for current handoff

The attempted push after the current live PR refresh was rejected because
GitHub reports PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `6da0eacc7`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2 --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 current live queue refresh

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Merge queue entry: `QUEUED`, position `9`, estimated time to merge `3560`
  seconds
- Auto-merge request: none reported; queue entry is active

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. `origin/main` is an ancestor of the local branch, and
the net diff versus `origin/main` remains limited to this issue-state refresh.
This issue is left `in-progress` locally because GitHub reports PR #1291 is
already queued to merge and queued branches cannot be updated.

## 2026-06-07 current queue recheck

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Merge queue entry: `QUEUED`, position `8`, estimated time to merge `3189`
  seconds
- Auto-merge request: none reported; queue entry is active

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The standalone report still shows `0` stale rows.
This issue remains `in-progress` locally because GitHub reports PR #1291 is
already queued to merge and queued branches cannot be updated.

## 2026-06-07 queue push blocker after current recheck

The attempted push after the current queue recheck was rejected because GitHub
reports PR #1291 as queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `6dca3929d9757cab748c2b60c9c8c1dbcf9a2ccd`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2wasm --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue is left `in-progress` locally until PR #1291
merges or is dequeued so the latest metadata refresh can be pushed.

## 2026-06-07 current queue recheck after validation

GitHub still has PR #1291 open and ready/non-draft for `symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Checks: all reported PR checks succeeded
- Merge queue entry: `QUEUED`, position `7`, estimated time to merge `2818`
  seconds
- Auto-merge request: none reported; queue entry is active

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The rebuilt standalone report still shows `0` stale
rows. `origin/main` is an ancestor of the local branch, and the net diff versus
`origin/main` remains limited to this issue-state refresh.

This issue remains `in-progress` locally because GitHub reports PR #1291 is
already queued to merge and queued branches cannot be updated with the latest
local metadata refresh.

## 2026-06-07 Codex queue handoff refresh

Live GitHub state still has PR #1291 open and ready/non-draft for
`symphony/1909`:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Check rollup: `SUCCESS`
- Merge queue entry: `QUEUED`, position `7`, estimated time to merge `2818`
  seconds
- Auto-merge request: none reported; the merge queue entry is active

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The rebuilt standalone report still classifies
`30,733 / 30,733` standalone non-pass/non-skip rows with `0` unclassified and
`0` stale rows. The RegExp split is unchanged: `833` Phase 2d rows, `104`
Phase 2b rows, `452` string-protocol rows, `546` native-engine rows, and `62`
fallback rows.

`origin/main` is an ancestor of the local branch, and the net diff versus
`origin/main` remains limited to this issue-state refresh. This issue remains
`in-progress` locally because GitHub reports PR #1291 is already queued to
merge; queued PR branches cannot be updated with the latest local metadata
refresh.

## 2026-06-07 Codex queued-branch push blocker

The attempted push after the Codex queue handoff refresh was rejected because
GitHub reports PR #1291 is queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `9ac03e885db7fb58eb3ee2ae98754aa158daee5c`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2 --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Queue state after the rejection: `QUEUED`, position `7`, estimated time to
  merge `2818` seconds
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue remains `in-progress` locally until PR #1291
merges or is dequeued so the latest local metadata refresh can be pushed.

## 2026-06-07 Codex live queue status

Live GitHub state at `2026-06-07T14:14:01+02:00` still has PR #1291 open,
ready/non-draft, and already accepted into the merge queue:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Check rollup: `SUCCESS`
- Merge queue entry: `QUEUED`, position `7`, estimated time to merge `2818`
  seconds

`origin/main` is an ancestor of the local branch, and the net diff versus
`origin/main` remains limited to this issue-state refresh. This issue remains
`in-progress` locally because GitHub reports PR #1291 is already queued to
merge; queued PR branches cannot be updated with the latest local metadata
refresh.

## 2026-06-07 Codex validation and queue recheck

Live GitHub state at `2026-06-07T14:19:52+02:00` still has PR #1291 open,
ready/non-draft, mergeable, and accepted into the merge queue:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Merge state: `CLEAN` / mergeable
- Check rollup: `SUCCESS`
- Merge queue entry: `QUEUED`, position `7`, estimated time to merge `2818`
  seconds

Scoped validation was rerun in this worktree:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The rebuilt standalone report still has `0`
unclassified rows and `0` stale rows. The RegExp split remains `833` Phase 2d
rows, `104` Phase 2b rows, `452` string-protocol rows, `546` native-engine
rows, and `62` fallback rows.

`origin/main` is an ancestor of the local branch and of the remote PR head. The
net diff versus `origin/main` remains limited to this issue-state refresh. This
issue remains `in-progress` locally because the active merge-queue entry blocks
metadata pushes to the PR branch until PR #1291 merges or is dequeued.

## 2026-06-07 Codex final queue push blocker

The attempted push after the validation and queue recheck was rejected because
GitHub reports PR #1291 is queued:

- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Local attempted head: `3ca6eff8683a3d6eb70afbb48c4f5461872d9c5e`
- PR URL: `https://github.com/loopdive/js2/pull/1291`
- Push preflight: local pre-push typecheck, lint, format, and issue integrity
  checks passed
- Merge queue command:
  `gh pr merge 1291 --repo loopdive/js2wasm --auto --match-head-commit 6f35f0230b118fefe6e7437ffc672626e4ecbd91`
  reported `Pull request #1291 is already queued to merge`
- Push result:

```text
GH006: Protected branch update failed ...
A pull request for this branch has been added to a merge queue.
Branches that are queued for merging cannot be updated.
```

Per the publish rule, this issue remains `in-progress` locally until PR #1291
merges or is dequeued so the latest local metadata refresh can be pushed.

## 2026-06-07 Codex queue/main preflight

Live GitHub state at `2026-06-07T14:28:45+02:00` still has PR #1291 open,
ready/non-draft, and accepted into the merge queue:

- URL: `https://github.com/loopdive/js2/pull/1291`
- Remote PR head: `6f35f0230b118fefe6e7437ffc672626e4ecbd91`
- Base: `main`
- Check rollup: `SUCCESS`
- Merge queue entry: `QUEUED`, position `6`, estimated time to merge `2447`
  seconds

`origin/main` has advanced since the queued PR head, and the local branch is
carrying only issue-state metadata relative to its merge base. The next step is
to temporarily release the queued PR, merge current `origin/main`, push the
refreshed issue metadata, and enqueue PR #1291 again.

## 2026-06-07 Codex main-refresh validation

PR #1291 was temporarily dequeued and converted to draft so the branch could be
updated without the merge queue locking the PR head again. The branch now
contains current `origin/main`, and the net diff versus `origin/main` remains
limited to this issue-state refresh.

Scoped validation after the main refresh:

- `pnpm test tests/issue-1909.test.ts tests/issue-1781.test.ts`
- `node --check scripts/build-test262-report.mjs`
- `node scripts/check-issue-ids.mjs`
- `pnpm exec prettier --check scripts/build-test262-report.mjs tests/issue-1909.test.ts tests/issue-1781.test.ts plan/issues/1909-standalone-regexp-residual-bucket.md`
- `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-1909-validate.json --target standalone --include-proposals --max-unclassified-root-causes 0`

All scoped checks passed. The rebuilt standalone report still classifies
`30,733 / 30,733` standalone non-pass/non-skip rows with `0` unclassified and
`0` stale rows. The RegExp split remains `833` Phase 2d rows, `104` Phase 2b
rows, `452` string-protocol rows, `546` native-engine rows, and `62` fallback
rows.

This issue is back to `in-review` with `pr: 1291`; after the refreshed branch
is pushed, PR #1291 should be marked ready and re-entered into the merge queue.
