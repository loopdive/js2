---
id: 1905
title: "standalone: native Reflect.get/set/has/deleteProperty over $Object"
status: done
sprint: 61
created: 2026-06-07
updated: 2026-06-10
completed: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: reflection, objects
es_edition: ES2015
goal: standalone-mode
parent: 1472
related: [1472, 1466, 1629, 1888]
test262_bucket: standalone-reflect-refusal
test262_count: 309
claimed_by: codex-developer
claimed_at: 2026-06-07T13:19:59.758Z
pr: 1290
---

# #1905 — Standalone native Reflect object subset

## Problem

The standalone report still has `309` failures in
`standalone-reflect-refusal`. `#1472` deliberately routed only
`Reflect.ownKeys` to native `__object_keys` and refused the rest to avoid
leaking `env::__reflect_*` imports.

The obvious `$Object` subset is now implementable:

- `Reflect.get(target, key[, receiver])`
- `Reflect.set(target, key, value[, receiver])`
- `Reflect.has(target, key)`
- `Reflect.deleteProperty(target, key)`

`Reflect.apply` and `Reflect.construct` remain separate call/constructor
machinery and are out of scope here.

## Scope

- Implement the object-runtime-backed subset for standalone only.
- Reuse existing `__extern_get`, `__extern_set`, `__extern_has`/keyed has, and
  `__delete_property` helpers where semantics line up.
- Preserve boolean return semantics for `Reflect.set`, `Reflect.has`, and
  `Reflect.deleteProperty`.
- Keep descriptor/prototype/integrity methods refused unless they are proven
  correct in this slice.

## Acceptance Criteria

- Focused tests in `tests/issue-1905.test.ts` cover get/set/has/deleteProperty
  on open `$Object` values under `target: "standalone"`.
- No `env::__reflect_*` imports leak under standalone.
- Unsupported Reflect methods still refuse loud with a tracked issue cite.
- Default/gc mode still uses the host Reflect bridge.

## Implementation Notes

- Added standalone lowering for `Reflect.get`, `Reflect.set`, `Reflect.has`,
  and `Reflect.deleteProperty` before the existing Reflect refusal path.
- `Reflect.get`, `Reflect.has`, and `Reflect.deleteProperty` route to the
  existing native `$Object` helpers: `__extern_get`, `__extern_has`, and
  `__delete_property`.
- Added native `__reflect_set` as a boolean-returning wrapper around
  `__extern_set` so ordinary assignments keep their void ABI while
  `Reflect.set` reports false for the object-runtime write refusals it can
  prove: frozen data writes, non-extensible new keys, non-writable own data
  properties, getter-only accessors, and non-`$Object` receivers.
- Descriptor/prototype/integrity methods, `Reflect.apply`, and
  `Reflect.construct` remain on the standalone refusal path with the existing
  `#1472 Phase C` cite.

## Validation

- `pnpm test tests/issue-1905.test.ts`
- `pnpm test tests/issue-1472.test.ts -t "unsupported Reflect"`
- `pnpm exec prettier --check src/codegen/object-runtime.ts src/codegen/expressions/calls.ts tests/issue-1472.test.ts tests/issue-1905.test.ts`
- Also tried the full `tests/issue-1472.test.ts`; it still has unrelated
  pre-existing failures in Object prototype and open-any method-dispatch cases,
  so validation for this issue stayed scoped to the changed Reflect refusal
  regression.

## Redispatch Verification

- 2026-06-07: confirmed PR `#1261` is already merged and `origin/main`
  contains the standalone Reflect object subset implementation and
  `tests/issue-1905.test.ts`.
- Reran scoped validation on this worktree:
  `pnpm test tests/issue-1905.test.ts`,
  `pnpm test tests/issue-1472.test.ts -t "unsupported Reflect"`, and
  `pnpm exec prettier --check src/codegen/object-runtime.ts src/codegen/expressions/calls.ts tests/issue-1472.test.ts tests/issue-1905.test.ts`.
- Final PR check: GitHub reports PR `#1261` as merged, so there is no
  remaining merge-queue action for this issue.
- Current redispatch pass: fetched `origin/main`, reran the scoped validation
  above successfully, confirmed implementation PR `#1261` is already merged,
  and opened ready/non-draft follow-up PR `#1266` for this issue-file update.
- Latest Codex pass: reran the scoped validation above successfully and
  confirmed GitHub reports PR `#1266` as merged with successful checks, so no
  merge-queue action remains for that tracked PR.
- Opened ready follow-up PR `#1269` for this current validation and issue-state
  refresh.
- Attempt 21: reran the scoped validation above successfully, confirmed GitHub
  reports ready PR `#1269` as merged with successful checks, and left the issue
  in review for the PR-status poller.
- Opened ready follow-up PR `#1270` for the Attempt 21 issue-state refresh.
- Current Codex pass: fast-forwarded the branch to `origin/main`, reran the
  scoped validation above successfully, and confirmed GitHub reports ready PR
  `#1270` as merged with successful checks.
- Opened ready follow-up PR `#1284` for the current issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1284` is open with checks still completing.
- Latest Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and kept ready PR `#1284` tracked for this issue-state refresh.
- Current Codex pass: reran the scoped validation above successfully, confirmed
  the implementation and `tests/issue-1905.test.ts` are already on `main`, and
  left ready PR `#1284` as the tracked in-review PR for this issue-state
  refresh.
- Current Codex pass: fetched current `origin/main`, confirmed local
  `symphony/1905` contains it, reran the scoped validation above successfully,
  and confirmed ready PR `#1284` is open/non-draft, green, and queued in the
  merge queue at position 13.
- Publish blocker: pushing local commit `318a00d1f` was rejected by GitHub
  because PR `#1284` is already in the merge queue. GitHub requires dequeuing
  the PR before the branch can be updated, so this local issue-state refresh
  remains unpublished.
- Current Codex pass: fetched current `origin/main`, confirmed local
  `symphony/1905` contains it, reran the scoped validation above successfully,
  and confirmed ready PR `#1284` is open/non-draft, green, and queued in the
  merge queue at position 11 before the final branch refresh.
- Final publish pass: dequeued stale PR `#1284`, pushed the refreshed
  `symphony/1905` branch containing current `origin/main`, and re-enabled
  GitHub auto-merge so the refreshed head can enter the merge queue after
  required checks pass.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1284` is open/non-draft, green, and queued in the
  merge queue at position 12.
- Final Codex publish pass: dequeued PR `#1284`, pushed this refreshed issue
  state to `symphony/1905`, and re-enabled GitHub auto-merge for the current
  head while required checks are pending so GitHub can queue it after checks
  pass.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1284` is open/non-draft with GitHub checks still
  completing before the final publish refresh.
- Final Codex publish pass: dequeued PR `#1284`, pushed the refreshed issue
  state to `symphony/1905`, and re-enabled GitHub auto-merge for the refreshed
  head while required checks are pending.
- Attempt 30: fetched current `origin/main`, fast-forwarded `symphony/1905` to
  current main (`28c668ab4`), reran the scoped validation above successfully,
  and confirmed the previously tracked ready PR `#1284` is already merged.
- Opened ready follow-up PR `#1290` for the Attempt 30 issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1290` is open, non-draft, mergeable, and green before
  publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed `symphony/1905`
  remains based on it, reran the scoped validation above successfully, and
  confirmed ready PR `#1290` is open/non-draft and mergeable with required
  checks still completing before this issue-state refresh is published.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1290` is open/non-draft, clean, mergeable, and queued
  in the merge queue at position 17 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1290` is open/non-draft, clean, mergeable, and queued
  in the merge queue at position 19 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully
  including the focused Prettier check, and confirmed ready PR `#1290` is
  open/non-draft, clean, mergeable, and queued in the merge queue at position 18
  before publishing this issue-state refresh.
- Final Codex publish pass: dequeued PR `#1290`, pushed this refreshed issue
  state to `symphony/1905`, and re-enabled GitHub auto-merge for the refreshed
  head while required checks are pending so GitHub can queue it after checks
  pass.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1290` is open/non-draft, clean, mergeable, and green
  before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main`, confirmed it remains an
  ancestor of `symphony/1905`, reran the scoped validation above successfully,
  and confirmed ready PR `#1290` is open/non-draft, clean, mergeable, green, and
  queued in the merge queue at position 19 before publishing this issue-state
  refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 17 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 18 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 17 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 15 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 16 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft and mergeable with required checks still completing
  before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, and queued in the merge queue at
  position 17 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 18 before publishing this issue-state refresh.
- Current Codex pass: fetched current `origin/main` (`28c668ab4`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft and mergeable with required checks still completing
  before publishing this issue-state refresh.
- Post-merge Codex pass: merged current `origin/main` (`767e64754`) into
  `symphony/1905`, reran the scoped validation above successfully including the
  focused Prettier check, and kept ready PR `#1290` as the tracked in-review PR
  before publishing this refreshed branch.
- Current Codex pass: fetched current `origin/main` (`767e64754`), confirmed it
  remains an ancestor of `symphony/1905`, reran the scoped validation above
  successfully including the focused Prettier check, and confirmed ready PR
  `#1290` is open/non-draft, clean, mergeable, green, and queued in the merge
  queue at position 15 before publishing this issue-state refresh.
- Current Codex pass (2026-06-07T14:50+02:00): fetched current `origin/main`
  (`767e64754`), confirmed it remains an ancestor of `symphony/1905`, reran the
  scoped validation above successfully including the focused Prettier check, and
  confirmed ready PR `#1290` is open/non-draft, clean, mergeable, green, and
  queued in the merge queue at position 16 before publishing this issue-state
  refresh.
- Current Codex pass (2026-06-07T14:57+02:00): fetched current `origin/main`
  (`767e64754`), confirmed it remains an ancestor of `symphony/1905`, reran the
  scoped validation above successfully including the focused Prettier check, and
  confirmed ready PR `#1290` is open/non-draft, mergeable, and queued in the
  merge queue at position 13 while the final equivalence gate is still queued.
- Final Codex publish pass (2026-06-07T15:01+02:00): dequeued PR `#1290` to
  allow the branch update, pushed the refreshed issue state to `symphony/1905`,
  and re-enabled GitHub auto-merge for the refreshed head while required checks
  are pending so GitHub can queue it after checks pass.
- Current Codex pass (2026-06-07T15:08+02:00): fetched current `origin/main`
  (`767e64754`), confirmed it remains an ancestor of `symphony/1905`, reran the
  scoped validation above successfully including the focused Prettier check, and
  confirmed ready PR `#1290` is open/non-draft, clean, mergeable, green, and
  queued in the merge queue at position 12 before publishing this issue-state
  refresh.
- Current Codex pass (2026-06-07T15:15+02:00): fetched current `origin/main`
  (`767e64754`), confirmed it remains an ancestor of `symphony/1905`, reran the
  scoped validation above successfully including the focused Prettier check, and
  confirmed ready PR `#1290` is open/non-draft, clean, mergeable, green, and
  queued in the merge queue at position 12 before publishing this issue-state
  refresh.
- Current Codex pass (2026-06-07T15:22+02:00): fetched current `origin/main`
  (`767e64754`), confirmed it remains an ancestor of `symphony/1905`, reran the
  scoped validation above successfully including the focused Prettier check, and
  confirmed ready PR `#1290` is open/non-draft, clean, mergeable, green, and
  queued in the merge queue at position 12 before publishing this issue-state
  refresh.
- Final Codex publish pass (2026-06-07T15:23+02:00): dequeued PR `#1290`, pushed
  this refreshed issue state to `symphony/1905`, and re-enabled GitHub
  auto-merge for the refreshed head while required checks are pending so GitHub
  can queue it after checks pass.
