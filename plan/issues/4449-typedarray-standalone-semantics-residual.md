---
id: 4449
title: "standalone: TypedArray.prototype ES6 semantics residual (~556 non-reflection tests) — species protocol, detached-buffer checks, custom-ctor paths"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-30
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
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/ta-dyn-mop.ts::buildStringKeyArm
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

## 2026-08-27 exact-cohort control and handoff

The exact cohort is frozen at `/private/tmp/js2-4449-species-55.txt` (55
non-BigInt ES2015 paths covering `map`, `filter`, `slice`, and `subarray`
`speciesctor-*`, `get-ctor-*`, and `get-species-*` cases). Fresh controls were
run from combined-PR base `114f8a95a` with
`pnpm run test:262 --official-scope-only`, two workers, and the pinned
standalone artifact directory
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`:

| Lane | Run | Pass | Fail | Compile errors | Timeouts | Skips | Denominator |
|---|---|---:|---:|---:|---:|---:|---:|
| host | `20260827-035118` | 52 | 3 | 0 | 0 | 0 | 55 |
| standalone | `20260827-035511` | 0 | 55 | 0 | 0 | 0 | 55 |

The host failures are the two `slice`/`subarray` custom-constructor identity
cases (the ordinary array result is rejected by the TypedArray receiver path)
and the `subarray` custom invocation-arguments case. The standalone failures
are assertion failures rather than compile/runtime errors: constructor and
`@@species` getters are not observed, custom constructors receive no calls,
default results have the wrong identity, and custom result lengths/values are
not honored.

### Root cause

The standalone test262 shim passes each `TA` constructor through the dynamic
`$__ta_ctor`/`$__ta_dyn_view` carrier. `compileArrayMethodCall` currently
materializes that carrier to an ordinary f64 vector and routes `map`, `filter`,
and `slice` through ordinary vector allocation; `subarray` creates a shared
dynamic view directly. None of these producer paths performs
`Get(O, "constructor")`, `Get(C, @@species)`, defaulting, `Construct`, or
returned-view validation. In addition, the dynamic MOP's intrinsic named
`constructor` arm precedes expando lookup, so an own `sample.constructor`
override cannot reliably reach the species object. This is a shared
TypedArraySpeciesCreate gap, not a reflection-only metadata failure.

### Handoff

No source or test change is claimed in this checkpoint. Implementers should
first make dynamic-view own `constructor` shadowing observable, then add one
shared species-create helper for the four producer methods. The helper must
preserve lookup/abrupt-completion order, invoke custom constructors with the
method-specific argument tuple, reject incompatible/non-TypedArray results,
and write producer values into the returned view. Rerun the exact 55-row host
and pinned standalone controls before claiming a gain; host's 52/55 result is
the regression floor. Detached-buffer and reflection work remain out of scope.

## 2026-08-27 clean-delivery resumed species plan

This branch is the clean upstream delivery branch behind draft PR #5022.

1. Add focused dynamic-view controls for own `constructor` shadowing and
   `constructor[Symbol.species]` lookup/defaulting, including original abrupt
   value propagation, before modifying producer algorithms.
2. Implement one reusable TypedArraySpeciesCreate seam, then wire a single
   producer method first. Preserve method-specific constructor arguments and
   validate returned dynamic views before widening to the other methods.
3. Land only independently proven producer slices; keep detached-buffer,
   reflection metadata, and BigInt carriers out of scope.
4. Rerun the frozen 55-row cohort in standalone and host after every completed
   slice. Draft PR #5022 may be marked ready only when the owned implementation
   is complete, standalone is 55/55 with zero non-passes, and host is 55/55.

### 2026-08-27 dynamic constructor control checkpoint

The dynamic-view MOP now checks an own `constructor` expando before walking the
selected prototype, preserving original getter abrupt completions and explicit
own values. The focused standalone controls in
`tests/issue-4449-species-controls.test.ts` pass 5/5 with zero `env` imports:
own constructor shadowing, abrupt constructor getter, inherited constructor
getter, own `Symbol.species`, and abrupt `Symbol.species` getter. The existing
`issue-3058-dyn-view-proto-methods` regression suite remains green (11/11).

This checkpoint intentionally does not claim producer-method progress; the
55-row species cohort remains at the 0/55 standalone baseline until the shared
species-create seam is wired.

## 2026-08-27 clean-delivery producer checkpoint (partial)

The resumed branch wires one shared standalone `TypedArraySpeciesCreate` seam
for dynamic-view `map`, `filter`, `slice`, and `subarray`. It now performs the
constructor/`@@species` lookup and nullish defaulting, preserves abrupt getter
completion, invokes custom constructors with the method-specific argument
tuple, validates a returned dynamic view and minimum length, and copies the
ordinary producer vector into the species result. The dynamic MOP own
`constructor` shadow path remains in front of prototype lookup. Detached
buffers, reflection metadata, and BigInt value carriers remain out of scope.

Focused evidence from this worktree:

- `tests/issue-4449-species-controls.test.ts` plus
  `tests/issue-4449-species-producers.test.ts`: **12/12 passed**, zero
  standalone `env` imports.
- An all-nine non-BigInt-constructor pin covering custom `map`, `filter`,
  `slice`, and shared-buffer `subarray` passed **36/36**.
- Tracked source delta at checkpoint: `array-methods.ts` +318 lines,
  `dataview-native.ts` +366 lines, `call-receiver-method.ts` +13/-2, and
  `ta-dyn-mop.ts` +41/-7; the added focused producer test is 197 lines. The
  dataview addition is the single shared protocol and dynamic-kind copy seam;
  the array-method addition is the four producer-specific argument/order arms
  plus one runtime two-arm wrapper. No debug instrumentation is retained.

The exact frozen cohort remains `/private/tmp/js2-4449-species-55.txt` (55
rows). Fresh bounded runs used `COMPILER_POOL_SIZE=2`,
`--official-scope-only`, and the exact path-file filter:

| Lane | Run | Pass | Fail | Compile errors | Timeouts | Skips | Denominator |
|---|---|---:|---:|---:|---:|---:|---:|
| standalone (pinned QuickJS artifact `2e2d7736713beeda`) | `20260827-074318` | 20 | 35 | 0 | 0 | 0 | 55 |
| host | `20260827-075040` | 52 | 3 | 0 | 0 | 0 | 55 |

The standalone run is a **partial improvement only**, not an acceptance
claim. Its 35 residuals are concentrated in constructor/default identity (8),
invalid constructor/species and returned-view handling (11), custom invocation
`this`/result copying (12), and the same-buffer offset/subarray cases (4), with
method totals `map 9`, `filter 8`, `slice 10`, `subarray 8`. Host remains at
the 52/55 control floor; its three failures are the pre-existing Float64
`slice`/`subarray` custom-constructor receiver and invocation-argument rows.
Draft PR #5022 must remain draft and this issue remains in progress until a
future checkpoint reaches standalone 55/55 and host 55/55 with zero nonpasses.

## 2026-08-30 detached-buffer compile-timeout handoff

The full ES2015 diagnostic on detached source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` finished all 16 shards. A separate
runner-completeness defect (#5215) dropped 19 non-TypedArray verdicts from shard
10, so the preserved dispatch artifact contains 11,685 unique rows rather than
the selected 11,704: 8,974 pass, 2,258 fail, 447 compile errors, six compile
timeouts, and no skips. Every recorded timeout is in this issue's existing
detached-buffer family:

- `test/built-ins/TypedArray/prototype/byteLength/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/lastIndexOf/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/findIndex/predicate-may-detach-buffer.js`;
- `test/built-ins/TypedArray/prototype/every/callbackfn-detachbuffer.js`;
- `test/built-ins/TypedArray/prototype/indexOf/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/buffer/detached-buffer.js`.

The first two timings were observed while an accidental competing focused-test
pool was being terminated; the later four occurred with the census alone and
make the shared detached-buffer compile path the primary diagnosis. None of
the 19 missing #5215 rows is a TypedArray path, so the six-row list is exact for
the emitted artifact. This remains dispatch evidence, not a final regression
count.

The census has released the global two-worker lock. The current validation
lanes remain capped at one worker each; when one returns, a Luna Max handoff on
this existing markdown issue must rerun each path alone with one bounded
compiler worker, record whether compilation or strict rerun stalls, and fix the
shared lowering rather than increasing retry budgets.
