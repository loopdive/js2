---
id: 4449
title: "standalone: TypedArray.prototype ES6 semantics residual (~556 non-reflection tests) — species protocol, detached-buffer checks, custom-ctor paths"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-25
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 2159, 2175]
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #4449 — TypedArray.prototype standalone semantics residual

## Problem

556 non-passing ES2015-classified standalone tests under `built-ins/TypedArray*`
remain after excluding the reflection files (`length.js`/`name.js`/
`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` — those are
#2159/#2175's lane). Measured 2026-08-15 (`.tmp/es6-standalone-clusters.ts`,
baseline_sha `734fab88`):

| ~Tests | Sub-bucket | Symptom |
|---|---|---|
| 55 | `speciesctor-*` | `@@species` / custom-constructor protocol not consulted (`Expected a TypeError…`, `same constructor Expected SameValue(«undefined», «true»)`) |
| 41 | detached-buffer | operations must throw TypeError on a detached ArrayBuffer; no exception thrown |
| 22 | `custom-ctor` | result-constructor selection on map/slice/filter/subarray |
| 438 | other | per-method semantics under "Testing with FloatNArray and makeArray" — validation order, `ToInteger` coercion, callbackfn protocol observability, `arraylength-internal` |

Heaviest methods: `set` (37), `map` (35), `slice` (34), `filter` (32),
`subarray` (31), `copyWithin` (27), `fill` (20), `reduce`/`reduceRight` (38).

## Implementation Plan (2026-08-25)

Work in bounded commits; do not turn the 556-file residual into one rewrite.

1. **Freeze a current cohort.** Run the standalone TypedArray path filter and
   save the result file under `.tmp/`. Partition non-passes into reflection,
   detached-buffer, species/custom-ctor, and per-method semantics. Exclude the
   reflection filename families owned by #2159/#2175 and record the exact
   denominator used for every before/after claim.
2. **Trace the native carrier once.** Start in
   `src/codegen/dataview-native.ts`, especially the `%TypedArray%.prototype`
   helpers and the shared backing-buffer window. Confirm how a view reaches its
   backing vec and how detachment is represented (`buf.length < 0`). Reuse the
   existing DataView/ArrayBuffer detached-buffer throw builders; do not add a
   host import or a second detached-state representation.
3. **Land detached-buffer validation first.** Add a shared TypedArray
   `ValidateTypedArray` entry helper and call it at each affected prototype
   method at the specification-required point relative to argument coercion.
   Use representative tests that detach before entry and during `valueOf` /
   callback evaluation so a blanket early check cannot falsely pass the slice.
4. **Implement TypedArraySpeciesCreate.** Read `receiver.constructor`, then
   `constructor[Symbol.species]`; default on null/undefined, require a
   constructor otherwise, construct with the requested length/buffer tuple,
   and verify the result is a compatible non-detached TypedArray of sufficient
   length. Thread this through `map`, `filter`, `slice`, and `subarray` rather
   than duplicating lookup logic per method. If first-class method reflection
   is truly required, leave only those exact files on #2159/#2175 and record
   evidence; do not classify ordinary species lookup as reflection by default.
5. **Close method-semantic clusters by shared algorithm.** Attack in this
   order: `set` overlap/coercion, `map`/`filter` callback and result creation,
   `slice`/`subarray` bounds/species, `copyWithin`/`fill` index coercion, then
   reduce/reduceRight empty and traversal behavior. Each commit gets a focused
   unit test under `tests/issue-4449-*.test.ts` and a before/after path-filter
   delta.
6. **Regression audit.** Run the full TypedArray filter in standalone and GC
   modes, plus the focused tests. Report new passes, losses, remaining
   failures by cluster, and reassign only proven external blockers to their
   owning issues.

Primary ownership: `src/codegen/dataview-native.ts` and new focused tests.
Coordinate before editing shared reflection/prototype-object machinery owned
by #2159/#2175 or class/destructuring files owned by #4447/#4450.

## Implementation Update (2026-08-25)

This bounded slice implements step 3 for the shared-backing static view lane.
`emitTaViewValidate` checks the backing byte vector's shared detached marker
(`length < 0`), null backing references, and fixed-view out-of-bounds windows;
auto-length views retain their live-buffer semantics. It emits a catchable
standalone `TypeError` before materialization and therefore before method
argument/callback evaluation.

The guard is wired into the ordinary array-method dispatcher and the earlier
standalone packed-carrier `map`/`filter` and scalar-HOF fast paths. The latter
were the reason a validation helper in `array-methods.ts` alone missed the
highest-yield map/reduce cases. Species/custom-constructor result allocation
remains open and is not claimed by this slice; reflection-only filename
families remain attributed to #2159/#2175.

This closes only the detached/shared-view validation slice. The parent issue
remains in progress until species/custom-constructor and remaining per-method
clusters satisfy the acceptance criteria below.

## Test Results (2026-08-25)

- `CI=true node_modules/.bin/vitest run tests/issue-4449.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=dot`
  — **4 passed**. Covers detached `map` and `reduce` callback ordering,
  fixed-view OOB after resize, and an in-bounds resize regression.
- The standalone TypedArray filter was started from this worktree as run
  `20260825-012742` using `TEST262_TARGET=standalone`, the interpreter lane,
  `TEST262_PATH_FILTER='built-ins/TypedArray'`, and 16 weighted chunks. It was
  stopped after the runner's bounded retry budget (the partial report has 886
  rows: **191 pass / 886 total, 21.6%**). It is recorded as a before snapshot,
  not an after delta: compile-timeout retries and the unsupported
  `$262.detachArrayBuffer` interpreter harness dominate this broad cohort. The
  exact ES2015 baseline remains the plan's 556-test cohort;
  species/custom-constructor failures and reflection filename families are
  still open blockers.

## Acceptance

- Sub-bucket counts above driven to zero (or re-attributed to #2175 with
  evidence) with scoped-run measurements
  (`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/TypedArray"`).

## 2026-08-27 Luna/max wave plan — exact species cohort

The cached ES2015 baseline joins exactly 11,704 paths. Within it, the exact
`speciesctor` cohort contains 55 rows: cached host is 45 pass / 10 fail and
cached standalone is 0 pass / 55 fail. These counts select the cohort only;
the implementation branch must rerun all 55 rows on the combined PR head before
and after its change.

1. Freeze the exact 55 paths and separate constructor lookup, `@@species`
   lookup/defaulting, abrupt completion, invocation arguments, and returned-view
   validation by row. Do not treat the shared error text as a bucket boundary.
2. Implement the narrowest shared TypedArraySpeciesCreate path used by `map`,
   `filter`, `slice`, and `subarray`, preserving lookup order and abrupt values.
   Do not touch reflection-only method metadata or detached-buffer handling.
3. Add permanent focused coverage for one success, one default-species case,
   one abrupt constructor lookup, and one incompatible returned object.
4. Rerun the exact 55 paths in host and standalone. Record every denominator,
   any losses, and residual handoff here; integrate only a net-correct proven
   slice into draft PR #5010.
