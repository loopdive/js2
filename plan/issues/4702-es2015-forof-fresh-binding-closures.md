---
id: 4702
title: "ES2015 for-of const/let fresh-binding closures — callable externref array elements"
status: done
completed: 2026-08-25
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: for-of-fresh-binding-closures
goal: test262-conformance
related: [1453, 4698, 4700]
origin: "Issue #4702 split from blocked #4698; two exact for-of fresh-binding rows independently fail after #4698's ref-cell candidate."
source-loc-max: 180
loc-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls-guards.ts
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
trap-growth-allow:
  count: 2
  reason: "#3596 fail-to-fail reclassification only: the two named explicit-resource-management rows are baseline `fail` (the old static undefined-array call guard throws before invoking the saved closure). #4702 correctly makes that runtime externref element callable, so those already-failing rows execute farther and expose the separate pre-existing `using`/`await using` loop-head capture gap as `null_deref`. Neither row passed before this change, both are outside #4702's explicitly const/let-only scope, and the target const/let rows now pass."
  tests:
    - test/language/statements/for-of/head-using-fresh-binding-per-iteration.js
    - test/language/statements/for-of/head-await-using-fresh-binding-per-iteration.js
---

# #4702 — ES2015 for-of fresh-binding closures

## Scope

Own only these two rows:

- `test/language/statements/for-of/head-const-fresh-binding-per-iteration.js`
- `test/language/statements/for-of/head-let-fresh-binding-per-iteration.js`

The rows use an initially `undefined[]` externref array as a function table,
then assign a closure from each `for (const/let x of [1, 2, 3])` iteration and
call the saved functions. TDZ behavior (#4700), destructuring, async iteration,
iterator closing, and Map/Set are explicitly out of scope.

## Exact baseline

Measured 2026-08-25 in a dedicated worktree at compiler
`86c9ec686ff5fb7a823119eebe8bb9121b1a27cc` and test262 submodule
`b363f29d3c43c626dc852744ad64a0b48a003693`, using
`runTest262File(path, "language/statements")`:

| row | result | timing | wasm SHA | observed error |
| --- | --- | --- | --- | --- |
| `head-const-fresh-binding-per-iteration.js` | fail | 1033.05 ms total (976.94 ms compile, 33.94 ms instantiate, 21.52 ms execute) | `c266374a9597` | `TypeError: undefined is not a function` at reported L16 |
| `head-let-fresh-binding-per-iteration.js` | fail | 430.28 ms total (423.81 ms compile, 4.36 ms instantiate, 1.92 ms execute) | `c266374a9597` | `TypeError: undefined is not a function` at reported L16 |

The first `assert.sameValue(s, 6)` is reached; WAT shows `f` as an externref
array (storage type `externref`) and the closure assignments are emitted. The
failure occurs when `f[0]()` is compiled as a statically non-callable
`undefined` element, so the call tail throws instead of dynamically invoking
the assigned closure. This is an externref element-call dispatch gap, not
evidence that either loop head failed to create a fresh binding.

## Root-cause plan (focused)

1. Confirm the ECMA-262 `ForIn/OfBodyEvaluation` contract (§14.7.5.7 in the
   ES2021/ES2022 editions) and preserve the existing const/let loop lowering;
   do not broaden this issue into loop-environment or TDZ work.
2. Trace the element-call dispatch from `f[0]()` through the static call-signature
   path and the existing dynamic-array fallback. Identify the narrow predicate
   that can distinguish an externref-backed array element whose runtime value may
   be callable from numeric/typed arrays that must retain their current behavior.
3. Add the smallest guarded dynamic dispatch change in the call codegen, reusing
   existing externref/closure invocation machinery. Do not change array storage,
   assignment, loop binding allocation, host imports, or runtime ABI.
4. Pin both exact source shapes in a scoped regression test and inspect emitted
   WAT to verify the loaded externref is dispatched rather than dropped/throwing.

Maximum changed compiler source: 180 LOC (tests and this plan excluded). If no
bounded predicate keeps the controls green, document the measured blocker and
do not publish a PR.

## Controls

- Existing `for-of` closure controls covering ordinary direct calls and numeric
  array iteration must remain green.
- `undefined`/`null` non-callable values must continue to throw `TypeError`.
- Numeric/f64 arrays, typed arrays, object-property element calls, and arrays
  without externref storage must retain their existing dispatch paths.
- The fix must not alter TDZ, destructuring, async, iterator-close, Map, or Set
  behavior.
- Run only scoped compiler/type checks and 3–5 focused test262 rows; no full
  `npm test` or full test262 sweep.

## Acceptance

- Both exact target rows pass, including all three saved closure calls and the
  distinct values `1`, `2`, and `3`.
- The focused regression test executes both const and let forms and fails on
  the baseline, rather than merely asserting compile artifacts.
- All listed controls remain green, generated Wasm validates, and no unrelated
  source change exceeds the 180-LOC source budget.
- Before publication, merge the latest `upstream/main` into the branch without
  rebasing/force-pushing, rerun the focused checks, push the renamed branch
  `codex/4702-es2015-forof-fresh-binding-closures`, and open (but do not merge)
  the upstream PR against `main` with head `ttraenkler`.

## Test Results

Baseline recorded above. Post-fix results on the same worktree:

- `vitest run tests/issue-4702.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot` — **4/4 passed**. The two target shapes return all three distinct closure values; undefined and numeric array calls still return the expected `TypeError` result.
- `node --import tsx ... runTest262File(...)` over the two target rows plus `for-of/decl-const.js`, `for-of/decl-let.js`, and `for-of/array.js` — **5/5 passed**. Target Wasm SHA: `1090acb6f7ce` for both rows.
- `tsc --noEmit --types node --pretty false` — **passed**.
- WAT inspection of the fixed call site shows `any.convert_extern`, closure-wrapper `ref.test`, guarded `ref.cast`, and `call_ref`; the loaded array element is no longer dropped into the unconditional primitive TypeError path.

Changed compiler source is 39 lines including replaced lines (below the
180-line limit).

The merge-group Test262 comparison also reports two bounded fail-to-fail trap
reclassifications. Both explicit-resource-management rows named in
`trap-growth-allow` were baseline failures: before #4702, their saved closure
calls stopped at the same static `undefined is not a function` guard as the
target rows. With that guard corrected, they execute the closures and expose a
pre-existing null capture for `using`/`await using` loop-head bindings. This PR
does not change resource acquisition, disposal, or using-binding lowering; no
previously passing Test262 row regressed.
