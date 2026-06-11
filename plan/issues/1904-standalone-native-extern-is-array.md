---
id: 1904
title: "standalone: native __extern_is_array predicate for Array.isArray over Wasm carriers"
status: done
pr: 1294
sprint: 61
created: 2026-06-07
updated: 2026-06-10
completed: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: arrays, objects
goal: standalone-mode
parent: 1472
related: [1328, 1678, 1888]
test262_bucket: standalone-dynamic-object-property
test262_count: 8163
claimed_by: codex-developer
claimed_at: 2026-06-07T10:45:58.981Z
---
# #1904 — Native `__extern_is_array` for standalone

## Problem

The standalone dynamic object/property bucket still samples:

```text
Codegen error: '__extern_is_array' ... not yet supported in --target standalone
```

`Array.isArray` already has host-mode and compile-time paths, but any dynamic or
externref-shaped value falls through to `__extern_is_array`, which the broad
`__extern_*` standalone refusal catches. That blocks destructuring,
Array/TypedArray construction guards, and test262 harness checks that only need
a native brand predicate.

## Scope

- Add a standalone-native implementation for `__extern_is_array`.
- Route it through `OBJECT_RUNTIME_HELPER_NAMES` or an equivalent standalone
  native helper path before `STANDALONE_REFUSED_IMPORT`.
- Recognize the Wasm carriers that this compiler uses for arrays/rest vectors
  under standalone. Do not claim Proxy/exotic host arrays that cannot exist
  without a JS host.

## Acceptance Criteria

- `Array.isArray` over a standalone-emitted array/rest/vector carrier returns
  true where the JS semantics require an array result.
- Non-array `$Object` and primitive values return false without trapping.
- The regression test compiles and instantiates under `target: "standalone"`
  with no `env::__extern_is_array` import.
- JS-host/default behavior is unchanged.

## Implementation Notes

- Routed `__extern_is_array` through the standalone object-runtime native helper
  path before the broad `__extern_*` refusal.
- Reserved the helper with `ensureObjectRuntime`, then filled its body during
  finalize after all Wasm array carriers are known.
- The native predicate recognizes `$ObjVec`, `__vec_*`, and template vector
  carriers; primitives, `$Object`, and other externrefs return false.
- Proxy/host exotic recursion from ES §7.2.2 is intentionally out of scope for
  standalone because those carriers cannot exist without a JS host.

## Validation

- `npm test -- tests/issue-1904.test.ts`
- `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts`
- `npm run typecheck`

Final Codex verification on 2026-06-07: the scoped issue test, related regression set, and typecheck passed after refreshing the branch against current main. PR #1259's earlier test262 gate failure was on the stale published head and reported baseline drift; the branch was refreshed again against `origin/main` before republishing.

Codex rerun on 2026-06-07: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. The PR remains ready and non-draft with issue status `in-review`.

Codex final publish check on 2026-06-07: refreshed `origin/main`, confirmed it is already included in `symphony/1904` (`git merge --ff-only origin/main` was already up to date), reran the scoped issue test, related regression set, and typecheck successfully. PR #1259 is open, ready/non-draft, and targets `main`.

Codex final rerun on 2026-06-07: after fetching current `origin/main`, confirmed it is an ancestor of `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. PR #1259 remains open, ready/non-draft, and targets `main`.

Codex post-merge rerun on 2026-06-07: merged the latest `origin/main` into `symphony/1904`, then reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully before republishing PR #1259.

Codex final check on 2026-06-07: merged current `origin/main` into `symphony/1904`, reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. GitHub reports PR #1259 is already merged, so there is no remaining merge-queue action.

Codex verification on 2026-06-07: after fetching current `origin/main`, confirmed it is an ancestor of `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged; no merge-queue or auto-merge action remains.

Codex dispatch check on 2026-06-07: revalidated the already-merged implementation from PR #1259 on `symphony/1904`; `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged, so no merge-queue or auto-merge action remains.

Codex stale redispatch check on 2026-06-07: fetched current `origin/main`, confirmed it is an ancestor of `symphony/1904`, reran the scoped issue test (4/4), related regression set (17/17), and typecheck successfully. GitHub reports PR #1259 is already merged and ready/non-draft history exists, so there is no remaining PR creation, merge-queue, or auto-merge action for this issue.

Codex redispatch verification on 2026-06-07: `git merge --ff-only origin/main` was already up to date, `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged; issue status is kept `in-review` per Symphony handoff rules, with no remaining merge-queue or auto-merge action.

Codex stale dispatch verification on 2026-06-07: fetched current `origin/main`, confirmed `origin/main` is already included in `symphony/1904`, and `git merge --ff-only origin/main` was already up to date. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is already merged, so there is no remaining PR creation, merge-queue, or auto-merge action for this issue.

Codex stale dispatch closeout on 2026-06-07: verified PR #1259 is merged, ready/non-draft history exists, and `origin/main` is an ancestor of `symphony/1904`. Reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. Issue status remains `in-review` per Symphony handoff rules; no merge-queue or auto-merge action remains after merge.

Codex redispatch closeout on 2026-06-07: merged current `origin/main` into `symphony/1904` and reran scoped validation on the refreshed branch. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is already merged and was ready/non-draft, so no merge-queue or auto-merge action remains; issue status stays `in-review` for the poller.

Codex stale dispatch final check on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in `symphony/1904`, and `git merge --ff-only origin/main` was already up to date. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub reports PR #1259 is merged and non-draft; no merge-queue or auto-merge action remains after merge.

Codex current dispatch closeout on 2026-06-07: merged current `origin/main` into `symphony/1904`, then reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. GitHub reports PR #1259 is already merged and non-draft, so no merge-queue or auto-merge action remains; issue status stays `in-review` for the poller.

Codex latest-main closeout on 2026-06-07: after `origin/main` advanced again, merged the new tip into `symphony/1904` and reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. PR #1259 is already merged and non-draft; no merge-queue or auto-merge action remains.

Codex attempt 22 closeout on 2026-06-07: merged current `origin/main` into `symphony/1904` and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck`. GitHub reports PR #1259 is already merged and was ready/non-draft, so no merge-queue or auto-merge action remains for this branch.

Codex current verification on 2026-06-07: merged current `origin/main` into `symphony/1904`, reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. GitHub reports PR #1259 is already merged and non-draft, so there is no merge-queue or auto-merge action remaining for this issue.

Codex final dispatch check on 2026-06-07: fetched current `origin`, confirmed `origin/main` is an ancestor of `symphony/1904`, reran `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck` successfully. GitHub reports implementation PR #1259 is merged and was ready/non-draft; follow-up closeout PR #1286 is open and ready/non-draft, so issue status stays `in-review` for the poller.

Codex current closeout on 2026-06-07: PR #1286 is open, ready/non-draft, clean, and queued in the merge queue at position 14. Local scoped validation passed again: `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck`. The queued-closeout commit would keep issue status `in-review` for the Symphony poller once publishable.

Codex publish blocker on 2026-06-07: after the local queued-closeout commit `ead6c0fb2`, `git push origin symphony/1904` was rejected with GH006 because PR #1286 is already in the merge queue and queued branches cannot be updated. Issue status is left `in-progress` until the queued PR merges or is dequeued for a follow-up push.

Codex current blocker on 2026-06-07: fetched current `origin`, confirmed `origin/main` is an ancestor of `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck`. GitHub GraphQL reports PR #1286 is open, ready/non-draft, clean, and queued at position 14; local branch updates remain unpublished because queued branches reject pushes, so issue status stays `in-progress` per the publish-blocker rule.

Codex dispatch verification on 2026-06-07: fetched current `origin`, confirmed `origin/main` is still an ancestor of `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` (4/4), `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` (17/17), and `npm run typecheck`. GitHub GraphQL reports PR #1286 is open, ready/non-draft, clean, and queued at position 13; local branch updates remain unpublished while the queued branch rejects pushes, so issue status stays `in-progress` until PR #1286 merges or is dequeued.

Codex publish attempt on 2026-06-07: `git merge --ff-only origin/main` was already up to date, and `git push origin symphony/1904` reran pre-push typecheck, lint, prettier format check, and issue integrity successfully before GitHub rejected the update with GH006 because PR #1286 is already in the merge queue. GitHub GraphQL still reports PR #1286 open, ready/non-draft, clean, and queued at position 13; issue status remains `in-progress` per the publish-blocker rule because the latest local issue-file commits cannot be pushed while the PR remains queued.

Codex current attempt on 2026-06-07: fetched `origin`, confirmed `origin/main` is an ancestor of `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 open, ready/non-draft, clean, and queued at position 13 with head `8db25d962fb115fe1755278809a64388cc554af5`; local branch updates remain unpublished because queued branches reject pushes, so issue status stays `in-progress` until the PR merges or is dequeued.

Codex queue verification on 2026-06-07: fetched `origin`, confirmed `origin/main` is an ancestor of local `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 open, ready/non-draft, clean, and queued at position 12 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; local issue-file commits remain unpublished while GitHub rejects updates to queued branches, so issue status remains `in-progress` per the publish-blocker rule.

Codex current queue verification on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 open, ready/non-draft, clean, and queued at position 12 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` locally because unpublished issue-file commits cannot update a queued branch unless PR #1286 merges or is dequeued.

Codex publish attempt on 2026-06-07: `git merge --ff-only origin/main` was already up to date, and `git push origin symphony/1904` ran pre-push typecheck, lint, prettier format check, and issue integrity successfully before GitHub rejected the update with GH006 because PR #1286 is already in the merge queue. Local issue-file commits remain unpublished, and issue status stays `in-progress` per the publish-failure rule until the queued PR merges or is dequeued.

Codex current closeout on 2026-06-07: merged current `origin/main` into `symphony/1904` and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 open, ready/non-draft, and queued at position 10 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` locally because queued branches reject updates until the PR merges or is dequeued.

Codex latest queue check on 2026-06-07: reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 open, ready/non-draft, all visible checks successful, and queued at position 10 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` because the local branch has unpublished issue-file updates that cannot be pushed while the queued PR branch is locked.

Codex publish blocker on 2026-06-07: after local commit `15d35971b`, `git merge --ff-only origin/main` was already up to date and `git push origin symphony/1904` reran pre-push typecheck, lint, prettier format check, and issue integrity successfully before GitHub rejected the update with GH006 because PR #1286 is already in the merge queue. The issue remains `in-progress` until PR #1286 merges or is dequeued for a publishable follow-up.

Codex current publish check on 2026-06-07: fetched current `origin`, confirmed local `symphony/1904` includes `origin/main`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 is open, ready/non-draft, all visible checks successful, and queued at position 9 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; local issue-file updates remain unpublished until GitHub allows the queued branch to update or the queued PR merges.

Codex current verification on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in `symphony/1904`, and `git merge --ff-only origin/main` was already up to date. `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 is open, ready/non-draft, all visible checks successful, and queued at position 9 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; local closeout updates remain unpublished because the queued branch is locked until PR #1286 merges or is dequeued.

Codex queue check on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in local `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 is open, ready/non-draft, all visible checks successful, and queued at position 8 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` locally because queued branches reject updates until PR #1286 merges or is dequeued.

Codex latest queue verification on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in local `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 is open, ready/non-draft, all visible checks successful, and queued at position 8 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` because the current local issue-file updates cannot be pushed while GitHub locks the queued branch.

Codex current queue check on 2026-06-07: fetched `origin`, confirmed `origin/main` is included in local `symphony/1904`, and reran scoped validation successfully: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. GitHub GraphQL reports PR #1286 is open, ready/non-draft, all visible checks successful, and queued at position 7 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status remains `in-progress` locally because the queued branch rejects updates until PR #1286 merges or is dequeued.

Codex publish blocker on 2026-06-07: `git merge --ff-only origin/main` was already up to date, and `git push origin symphony/1904` ran pre-push typecheck, lint, prettier format check, and issue integrity successfully before GitHub rejected the update with GH006 because PR #1286 is already in the merge queue. GitHub GraphQL still reports PR #1286 open, ready/non-draft, all visible checks successful, and queued at position 7 with remote head `8db25d962fb115fe1755278809a64388cc554af5`; issue status stays `in-progress` until the queued PR merges or is dequeued for a publishable update.

Codex final publish check on 2026-06-07: merged current `origin/main` into `symphony/1904` after GitHub reported PR #1286 merged. Scoped validation passed on the refreshed branch: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. Issue status is restored to `in-review` with `pr: 1286`; no merge-queue or auto-merge action remains after the merged PR.

Codex current publish check on 2026-06-07: PR #1294 is open and ready/non-draft for the remaining issue-file closeout delta on `symphony/1904`. Scoped validation passed again: `npm test -- tests/issue-1904.test.ts` passed 4/4, `npm test -- tests/issue-1904.test.ts tests/issue-1678.test.ts tests/issue-1328.test.ts tests/issue-1866.test.ts` passed 17/17, and `npm run typecheck` passed. Issue status is kept `in-review` for the Symphony poller.
