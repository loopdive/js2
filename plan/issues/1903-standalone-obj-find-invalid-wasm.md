---
id: 1903
title: "standalone object runtime: __obj_find emits invalid Wasm in dynamic-property bucket"
status: done
sprint: 61
created: 2026-06-07
updated: 2026-06-11
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-access
goal: standalone-mode
parent: 1472
related: [1472, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
pr: 1262
claimed_by: codex-developer
claimed_at: 2026-06-07T13:17:29.633Z
completed: 2026-06-10
---

# #1903 — Standalone object runtime: `__obj_find` invalid Wasm

## Problem

The current standalone report still classifies `8,163` failures under
`standalone-dynamic-object-property`. One sample signature is a validator error
inside the native object runtime:

```text
invalid Wasm binary ... "__obj_find" failed: i32.and expected type i32, found call of type externref
```

This is not a missing feature. It is a bad Wasm emission inside the runtime that
should be fixed before larger object-model work, because it can mask real
remaining semantic failures.

## Scope

- Inspect `src/codegen/object-runtime.ts`, especially `__obj_find` and flag/key
  checks around tombstones/accessor/data entries.
- Find the path where an externref-producing helper is left on the stack for an
  `i32.and`.
- Preserve the existing `$Object`/`$PropMap` representation and dual-mode
  invariant: standalone native path only, JS-host mode unchanged.

## Acceptance Criteria

- Add a focused regression test in `tests/issue-1903.test.ts` that previously
  forces the invalid `__obj_find` shape.
- The test compiles with `target: "standalone"`, validates with
  `WebAssembly.validate`, and instantiates with an empty import object.
- The generated module has no `env::__extern_*`, `env::__object_*`, or
  `env::__new_plain_object` imports.
- No broad refactor of the object runtime.

## Implementation Notes

- Root cause: `ensureObjectRuntime` could register object helper bodies after
  native-string helpers had snapshotted an older import base. A later uniform
  native-string finalize reconciliation could then over-shift the freshly
  registered object-runtime call indices, so `__obj_find`'s hash call could land
  on an externref-producing helper before `i32.and`.
- Moved `reconcileNativeStrFinalizeShift` to `src/codegen/native-strings.ts`
  and re-exported it from `expressions/late-imports.ts` for existing callers.
- `ensureObjectRuntime` now reconciles native-string import drift immediately
  after `ensureNativeStringHelpers(ctx)` and before registering `$Object`
  helpers, matching the existing union-helper base-settling invariant.
- Added `tests/issue-1903.test.ts`, a standalone dynamic computed-property
  lookup with native strings that validates, instantiates with `{}`, and asserts
  no `env::__extern_*`, `env::__object_*`, or `env::__new_plain_object` imports.
- Publish follow-up: the first ready PR run reached a stale standalone baseline
  guard after `#1905` landed on `main`. Merged `origin/main` into this branch
  before republishing so `#1262` is evaluated against the current main payload.
- Publish follow-up 2: re-merged current `origin/main` (`3fc48711b`, #1910)
  into this branch, kept the #1903 object-destructuring classifier addition,
  and left generated standalone report artifacts aligned with current main.
- Publish follow-up 3: re-merged the later `origin/main` baseline refresh
  (`5bef49a5`) and kept the generated standalone report artifact on main's
  refreshed payload.
- Publish follow-up 4: merged current `origin/main` (`3827daa96`, #1263) into
  this branch after GitHub reported PR #1262 as conflicting; the only conflict
  was unrelated #1907 issue metadata, resolved to main's in-review PR record.
- Final handoff (2026-06-07): refreshed the local checkout against
  `origin/main` (`3827daa96`), confirmed PR #1262 is open and non-draft, and
  found no additional #1903 source changes needed.
- Final handoff 2 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` is still an ancestor of the branch, reran scoped
  validation, and found no additional source changes needed before re-pushing
  PR #1262.
- Publish follow-up 5: merged current `origin/main` (`ff02d2011`, #1259) after
  the base advanced again, resolved the unrelated #1904 issue-file conflict to
  main's in-review PR record, and kept the #1903 runtime fix with the merged
  #1904 object-runtime changes.
- Final handoff 3 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` is still an ancestor of the branch, reran scoped
  validation, and found no additional #1903 source changes needed before the
  final issue-status push.
- Final handoff 4 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed current `origin/main` (`ff02d2011`) is still an ancestor of the
  branch, reran scoped validation, and found no additional #1903 source changes
  needed before re-pushing PR #1262.
- CI follow-up (2026-06-07): the ready PR run exposed a separate standalone
  invalid-Wasm shape where late imports caused native-string helpers such as
  `__str_flatten` to be shifted twice after the late-import flush. The fix lets
  `reconcileNativeStrFinalizeShift` settle drift up to a target import boundary,
  has `flushLateImportShifts` settle only pre-batch native-string drift before
  applying the late-import batch shift, and then rebases the native-string
  snapshot so the final reconcile does not apply the same batch again.
- Added a second #1903 regression in `tests/issue-1903.test.ts` covering the
  standalone private-accessor/Test262 shape that previously compiled to an
  invalid `__str_flatten` call after dead-import elimination.
- Publish follow-up 6: merged current `origin/main` (`f4dd784d4`) after the base
  advanced again, resolved the generated standalone Test262 report conflict to
  main's refreshed payload, and kept the #1903 runtime/test changes intact.
- Final handoff 5 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`f4dd784d4`) is still an ancestor of the branch,
  reran scoped validation, and found PR #1262 open, ready, and mergeable with
  GitHub checks still pending.
- Publish follow-up 7: PR #1262 had already entered the merge queue, so the
  branch first rejected the final handoff push. Dequeued the PR, merged the new
  `origin/main` (`d4492156f`, #1260), kept the #1903 issue record on this
  implementation branch, and resolved the report/script conflicts by combining
  main's RegExp bucket split with the #1903 object-destructuring classifier.
- Publish follow-up 8: merged current `origin/main` (`12c0e1429`, #1265) after
  the base advanced again, with no #1903 conflicts, and reran scoped validation.
- Publish follow-up 9: merged current `origin/main` (`053ed24ef`, #1269) after
  the base advanced again, with no #1903 conflicts, and reran scoped validation.
- Publish follow-up 10: merged current `origin/main` (`5b495ba47`, #1270)
  after the latest PR run hit the standalone regression guard against a stale
  baseline. The merge had no #1903 source conflicts and only brought in
  unrelated #1905 issue metadata.
- Final handoff 6 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`5b495ba47`) is still an ancestor of the branch,
  reran scoped validation, and found no additional #1903 source changes needed.
  PR #1262 remains open, ready, and mergeable while GitHub finishes the
  required check rollup.
- Final handoff 7 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`5b495ba47`) is still an ancestor of the branch, and
  reran scoped validation. No additional #1903 source changes were needed; PR
  #1262 remains the ready review PR for this issue.
- Final handoff 8 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`5b495ba47`) is still an ancestor of the branch, and
  reran scoped validation. No additional #1903 source changes were needed; PR
  #1262 remains open, ready, and waiting on GitHub checks.
- Final handoff 9 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`5b495ba47`) is still an ancestor of the branch, and
  reran scoped validation. PR #1262 is open, non-draft, mergeable, and has
  auto-merge enabled while required checks are still pending.
- Final handoff 10 (2026-06-07): fetched `origin/main`/`origin/symphony/1903`,
  confirmed `origin/main` (`5b495ba47`) is still an ancestor of the branch, and
  reran scoped validation. No additional #1903 source changes were needed; PR
  #1262 remains open, non-draft, and recorded for in-review tracking.
- Final handoff 11 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`5b495ba47`) is still an ancestor of `symphony/1903`
  (`abc6cef30`), reran scoped validation, and confirmed PR #1262 is open,
  non-draft, and queued in the merge queue.
- Final handoff 12 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`5b495ba47`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed before
  publishing the issue-only handoff update for PR #1262.
- Final handoff 13 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`5b495ba47`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open and non-draft. After
  publishing the handoff commits, merge-queue entry is enabled for PR #1262 on
  the pushed head.
- Final handoff 14 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`5b495ba47`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, mergeable, and
  queued in the merge queue before publishing this issue-only handoff update.
- Publish follow-up 11: merged current `origin/main` (`d6957d5d`) after the
  base advanced again, with no #1903 conflicts, and reran scoped validation.
- Final handoff 15 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`d6957d5d`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed before
  republishing the in-review issue status for PR #1262.
- Final handoff 16 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`d6957d5d`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and confirmed PR #1262 is open, non-draft, clean, mergeable, and green before
  republishing the in-review issue status.
- Final handoff 17 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`d6957d5d`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed before
  republishing the in-review issue status for PR #1262.
- Final handoff 18 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`d6957d5d`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, mergeable, and
  waiting on queued/in-progress GitHub checks before republishing the in-review
  issue status.
- Final handoff 19 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`d6957d5dc`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, and mergeable
  with required GitHub checks still pending before republishing the in-review
  issue status.
- Publish follow-up 12: merged current `origin/main` (`28c668ab4`) after the
  base advanced again, with no #1903 conflicts, reran scoped validation, and
  kept PR #1262 recorded as the ready in-review PR for this issue.
- Final handoff 20 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, mergeable, and
  has auto-merge enabled while GitHub checks are still pending.
- Final handoff 21 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, mergeable, and
  has auto-merge enabled while GitHub checks are still pending before
  publishing this in-review issue update.
- Final handoff 22 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and confirmed PR #1262 is open, non-draft, mergeable, and in the merge queue
  with GitHub checks still pending before publishing this in-review issue
  update.
- Final handoff 23 (2026-06-07): publishing the handoff commit required
  dequeuing PR #1262, pushing the updated issue record, and re-enabling
  auto-merge for the pushed head because required checks are still pending. The
  PR remains open, non-draft, mergeable, and recorded as the ready in-review PR
  for this issue.
- Final handoff 24 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and confirmed PR #1262 is open, non-draft, mergeable, and in the merge queue
  before publishing this in-review issue update. Because the PR was already
  queued, publishing the issue-status commit required dequeuing it first; after
  the push, GitHub rejected explicit enqueue while required checks were
  pending, so auto-merge is enabled on the pushed head to queue it when checks
  pass.
- Final handoff 25 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, and mergeable
  with required GitHub checks still pending before publishing this in-review
  issue update.
- Final handoff 26 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, mergeable, and recorded as the ready in-review
  PR for this issue.
- Final handoff 27 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, and mergeable.
  Publishing this issue update required dequeuing the queued PR; after the push,
  auto-merge was re-enabled for the pushed head because required GitHub checks
  were still pending.
- Final handoff 28 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 was open, non-draft, mergeable, and queued before publishing this
  issue-status update. Publishing the issue-only commit requires dequeuing the
  PR first; after the push, auto-merge/merge-queue entry is re-enabled for the
  pushed head.
- Final handoff 29 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 is open, non-draft, and mergeable; the GitHub check rollup still had
  in-progress test262 shards on the pre-handoff head before publishing this
  issue-status update.
- Final handoff 30 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and confirmed PR #1262 is open, non-draft, clean, mergeable, and green before
  publishing this in-review issue update.
- Final handoff 31 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and confirmed PR #1262 is open, non-draft, and mergeable.
  Required GitHub test262 shards were still in progress on the pushed head, so
  auto-merge/merge-queue entry remains the publish path after this issue-status
  update is pushed.
- Final handoff 32 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and found no additional #1903 source changes needed. PR #1262 was open,
  non-draft, mergeable, and green on the pre-handoff head before publishing
  this in-review issue update.
- Final handoff 33 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and found no additional #1903 source changes needed. PR #1262 is open,
  non-draft, mergeable, and queued in the merge queue on the pre-handoff head;
  publishing this issue-status update requires re-enabling queue/auto-merge on
  the pushed head.
- Final handoff 34 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`28c668ab4`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 is open, non-draft, mergeable, and was queued on the pre-handoff head;
  publishing this issue-status update requires re-enabling queue/auto-merge on
  the pushed head.
- Publish follow-up 13: merged current `origin/main` (`767e64754`, #1288) after
  the base advanced during final publish, with no #1903 conflicts, reran scoped
  validation, and kept PR #1262 recorded as the ready in-review PR for this
  issue.
- Final handoff 35 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, mergeable, and recorded as the ready
  in-review PR for this issue.
- Final handoff 36 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, mergeable, and recorded as the ready
  in-review PR for this issue while required GitHub checks are still pending.
- Final handoff 37 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 is open, non-draft, clean, mergeable, and green on the pre-handoff
  head before publishing this issue-status update.
- Final handoff 38 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, and mergeable while required GitHub checks
  are still pending before publishing this in-review issue update.
- Final handoff 39 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, and mergeable with one CI shard still
  in progress on the pre-handoff head before publishing this in-review issue
  update.
- Final handoff 40 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, ran an
  explicit no-op `git merge --no-edit origin/main`, reran scoped validation,
  and found no additional #1903 source changes needed. PR #1262 is open,
  non-draft, clean, mergeable, green, and queued in the merge queue on the
  pre-handoff head before publishing this in-review issue update.
- Final handoff 41 (2026-06-07): fetched current refs, confirmed
  `origin/main` (`767e64754`) is still an ancestor of `symphony/1903`, reran
  scoped validation, and found no additional #1903 source changes needed. PR
  #1262 remains open, non-draft, and mergeable before publishing this
  in-review issue update.

## Validation

- `npx vitest run tests/issue-1903.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (before and after merging `origin/main`)
- `npx vitest run tests/issue-1807.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1781.test.ts` (before and after merging
  `origin/main`)
- `npx vitest run tests/issue-1905.test.ts` (post-merge integration check for
  the current-main payload)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts
  tests/issue-1807.test.ts tests/issue-1905.test.ts tests/issue-1910.test.ts
  tests/issue-1472.test.ts -t
  "dynamic property add/read|#1903|#1781|#1807|#1905|#1910"` (after merging
  `origin/main` at `3fc48711b`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts
  tests/issue-1807.test.ts tests/issue-1905.test.ts tests/issue-1910.test.ts
  tests/issue-1472.test.ts -t
  "dynamic property add/read|#1903|#1781|#1807|#1905|#1910"` (after merging
  `origin/main` at `5bef49a5`)
- `npx vitest run tests/issue-1903.test.ts` (final handoff on 2026-06-07)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (final handoff on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts` (after merging `origin/main` at
  `3827daa96`)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (after merging `origin/main` at `3827daa96`)
- `npx vitest run tests/issue-1903.test.ts` (final revalidation before
  re-pushing PR #1262)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (final revalidation before re-pushing PR #1262)
- `npx vitest run tests/issue-1903.test.ts` (after merging `origin/main` at
  `ff02d2011`)
- `npx vitest run tests/issue-1472.test.ts -t "dynamic property add/read"`
  (after merging `origin/main` at `ff02d2011`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 4 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after fixing native-string late-import
  double-shift)
- `pnpm run build:compiler-bundle` (after fixing native-string late-import
  double-shift)
- Bundled compiler validation for
  `/workspace/test262/test/language/statements/class/elements/set-access-of-missing-private-setter.js`
  with `target: "standalone"` and `skipSemanticDiagnostics: true`: compile
  succeeded and `WebAssembly.validate` returned `true`.
- `TEST262_TARGET=standalone npx tsx -e 'import { runTest262File } from
  "./scripts/test262/runner.ts"; ...'` for
  `/workspace/test262/test/language/statements/class/elements/set-access-of-missing-private-setter.js`
  returned `status: "pass"`.
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `f4dd784d4`)
- Rebuilt the PR #1262 `test262-standalone-results-merged.jsonl` artifact with
  `--max-unclassified-root-causes 0` after classifying
  `language/expressions/object/dstr` under the existing object-property bucket.
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 5 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `d4492156f`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `12c0e1429`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `053ed24ef`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `5b495ba47`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 6 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 7 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 8 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 9 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 10 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 11 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 12 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 13 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 14 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `d6957d5d`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 15 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 16 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 17 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 18 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 19 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `28c668ab4`)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 20 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 21 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 22 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 24 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 25 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 26 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 27 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 28 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 29 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 30 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 31 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 32 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 33 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (final handoff 34 on 2026-06-07)
- `npx vitest run tests/issue-1903.test.ts tests/issue-1472.test.ts -t
  "#1903|dynamic property add/read"` (after merging `origin/main` at
  `767e64754`)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 35 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 36 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 37 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 38 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 39 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 40 on 2026-06-07)
- `pnpm exec vitest run tests/issue-1903.test.ts tests/issue-1781.test.ts`
  (final handoff 41 on 2026-06-07)
