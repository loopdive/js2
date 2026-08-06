---
id: 3185
title: "UMBRELLA default lane: Array.prototype generics + observable-semantics cluster (~1,057 fails — largest untracked builtin bucket)"
status: ready
created: 2026-07-12
updated: 2026-08-04
priority: high
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: array-methods
goal: builtin-methods
sprint: current
horizon: l
related: [3169, 3170, 3180, 2036, 3022, 1589, 2670, 2668, 4119]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F2)"
---

# #3185 — UMBRELLA: default-lane Array.prototype generics + observability (~1,057)

## Problem

`built-ins/Array` is the **largest built-ins fail bucket on the default
(JS-host) lane** — **1,057 non-pass** (baseline 2026-07-12) — yet has no open
default-lane issue: the 2026-07-03 harvest filed class/defineProperty/
iterator/invalid-wasm/with/negative buckets and skipped Array, and every open
Array HOF issue (#3169/#3170/#3180/#2036) is `--target standalone`.

Sub-buckets (non-pass per method directory):

```
90 reduceRight   88 reduce   69 map   68 filter   63 splice
54 some   53 forEach   51 every   50 lastIndexOf   48 indexOf
48 slice   45 sort   45 concat   14 flatMap   13 pop
```

Top error shapes across those method dirs (mechanism signal):

```
111  assert(testResult, 'testResult !== true')          ← callbackfn arg/return semantics
 33  assert(accessed, 'accessed !== true')              ← accessor/get observation order
 28  newArr.length mismatch                              ← result length/species
 21  "object is not a function"                          ← callable mis-dispatch
 16  illegal cast [in test()]                            ← uncatchable trap
 14  array element access out of bounds [in test()]      ← uncatchable trap
 13/13/12/7  Array.prototype.{indexOf,every,lastIndexOf,reduce}.call(arrayLike)
  8  callCnt mismatch                                    ← visit-count (holes/mutation)
  8  Object.getPrototypeOf(result) mismatch              ← species/proto
```

## Mechanisms (slice this umbrella by mechanism, not by method)

1. **Array-like receivers via `.call(obj, …)`** — the externref-receiver path
   exists (`ARRAY_LIKE_METHOD_SET`, `src/codegen/array-methods.ts:668`; thisArg
   handling `:692`) but misses spec ordering/coverage the tests check.
2. **Observable semantics on real arrays** — HasProperty/Get ordering, hole
   skipping vs visiting, length caching, mutation-during-iteration
   (`accessed`, `callCnt`, `testResult` shapes).
3. **Result-object fidelity** — length, prototype, species of map/filter/
   slice/splice/concat results.
4. **Hard traps (30)** — 16 illegal_cast + 14 OOB inside `test()`; these are
   soundness-adjacent (uncatchable, abort whole tests) and should be the FIRST
   slice. Coordinate with #3179/#3162 mechanism notes.

## Notes

- `src/codegen/array-methods.ts` is 9,632 LOC and inside the #3182 bloat
  epic's blast radius — land slices here as *behavioral* fixes, coordinate
  refactors with #3182/#3105.
- reduce/reduceRight (178 combined — the two biggest dirs) have a documented
  exclusion note at `src/codegen/array-methods.ts:664-666` (different callback
  signature on the array-like path) — a known-incomplete edge.

## Child slices (filed 2026-07-12)

Decomposed into 3 M-sized method-family slices over the default JS-host lane
(disjoint from the standalone #3169/#3180 receiver-ladder tests). Each slice
folds in the trap-first mandate (§4) for its own methods:

- **#3199** — fold/predicate family: reduce/reduceRight/every/some (~283), P1.
- **#3200** — iteration/producer family: forEach/map/filter/flatMap (~204), P1.
- **#3201** — search + structural family:
  indexOf/lastIndexOf/slice/splice/sort/concat/pop (~312), P1 — owns the
  30 trap-class fails (land first).

This issue stays the tracking umbrella.

## Re-slicing note (2026-07-12) — the M method-family slices were mis-sized

Root-causing #3199 (fold/predicate, done) with fresh-process probes over the
baseline jsonl showed the original decomposition **sized by fail-count, not by
where the fix lives**. The three M slices (#3199/#3200/#3201) each contain only
a small margin fixable inside `array-methods.ts`; the bulk is **architectural
and out of that file**. Measured for #3199 (281 fails), and expected to repeat
across #3200/#3201:

- **~102/slice — real-array observable semantics** (getters / `defineProperty`
  / `delete` / mutation-during-iteration on **vec-backed** arrays). Getters &
  delete never fire on the WasmGC vec, so `testResult`/`accessed`/`callCnt`
  asserts fail. **BLOCKED ON rep-unification #3134** — belongs in its own **XL
  child gated on #3134**, NOT in the array-methods.ts method-family slices.
  This is the single largest lever for the umbrella's `< 600` target and
  cannot land until #3134.
- **~125/slice — `.call(arrayLike)` generic-path gaps** that are **cross-file**,
  not array-methods work: `instanceof`-on-host-externref inside callbacks
  (`o instanceof Date` → false), Function-value receivers (`object is not a
  function`), etc. Should be filed as **distinct feature issues** (instanceof
  on host refs; array-like receiver-type coverage), not folded into the
  array-methods slices.
- **Small in-file margin** — the genuinely `array-methods.ts`-local, zero-
  regression wins (e.g. #3199's reduce accumulator-type-from-initial-value fix,
  ~2 test262 flips). This is what the array-methods.ts owner can harvest per
  slice; it is NOT the ≥150 the slice acceptance asked for.

**Action for re-decomposition:** (1) create an XL child "real-array observable
semantics for Array.prototype HOFs (getters/defineProperty/delete on vec-backed
arrays)" **depends_on: 3134**, absorbing the ~102/slice bulk; (2) file the
cross-file `.call` gaps (instanceof-on-host-ref, Function/array-like receiver
coverage) as their own issues; (3) keep #3199/#3200/#3201 as the thin in-file
behavioral-margin slices (drop the ≥150 acceptance — retarget to "harvest the
zero-regression in-file wins + honest re-slice"). #3199 is done on that basis.

## Acceptance criteria (umbrella)

1. Child slices filed per mechanism above (trap slice first), each with
   measured test lists pulled from the baseline jsonl.
2. `built-ins/Array` default-lane non-pass < 600 (from 1,057) when the
   mechanism slices land.
3. The 30 trap-class fails (illegal cast / OOB) → 0 traps (spec result or
   thrown JS TypeError, never a Wasm trap).
4. No standalone-lane regressions in the #3169/#3180 receiver-ladder tests.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F2.

## Re-measure 2026-08-04 — standalone lane, ES5 + untagged scope

Source: `plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md`.
Baselines fetched 2026-08-04, `oracle_version` 12, lane `honest`, baseline SHA
`d3d7ec4c`.

**738 files** in the ES5 + untagged standalone scope — second-largest cluster
there, behind the descriptor family (#2668, 762). Note the edition split: only
**40 are `ES5`-tagged, 698 are untagged**. The untagged label is the `esid`-only
fall-through introduced by #3639; before that change these same files carried the
`ES2015` label, which is why #2670 sized a near-identical population at ~1,017
under an ES2015 heading. **#2670, #3185 and this re-measure are largely the same
files under three different labels — reconcile before summing.**

Per-method (non-pass, this scope):

```
112 reduceRight  104 reduce   70 filter   70 map    64 some
 63 forEach       62 every    54 lastIndexOf  51 indexOf   14 sort
```

Top failure shapes, with the confirmed mechanism read from the test bodies:

```
135  testResult !== true            15.4.4.18-7-b-12: "deleting own property with prototype property
                                    causes prototype index property to be visited on an Array-like object"
 45  newArr.length mismatch         15.4.4.20-9-c-i-20: own accessor without a get, overriding an
                                    inherited accessor
 40  testResult[i] mismatch         15.4.4.19-8-b-15: decreasing length mid-iteration must make the
                                    prototype index property visible
 39  accessed !== true              15.4.4.20-4-8: side effects of step 2 visible when an exception occurs
 24  result !== true                15.4.4.18-1-11: forEach applied to a Date object
 18  "Reduce of empty array"        15.4.4.22-8-b-iii-1-28: reduceRight on a String object with its own
                                    property get method
```

**Confirmed mechanism** (test sources read directly, plus `src/codegen/hof-native.ts`):
the iteration reads a **dense snapshot** of the receiver instead of performing the
spec's per-index `HasProperty` + `Get`, which must walk the **prototype chain**
and invoke accessors. Non-Array receivers (`Date`, `String` object, plain
array-like) take the same snapshot path.

**Correction — this is NOT a per-step `length` re-read.** The spec fixes `len`
once (§23.1.3.15 step 2 and analogues) and `__hof_*` already does that; its
header says so explicitly. `15.4.4.19-8-b-15` passes in a real engine because the
loop runs to the ORIGINAL bound and the now-out-of-range index resolves through
`Array.prototype["2"]` — a prototype lookup, not a re-read. Adding a
per-iteration `length` re-read would be incorrect and slower. The `length`-side
gap is narrower: `LengthOfArrayLike` must be a real `[[Get]]` (once, before the
loop) so an accessor `length` is invoked — `15.4.4.19-2-9`.

**Sizing caveat — 477 of 738 (65 %) also fail on the JS-host lane.** Only 261 are
standalone-only, so the standalone-lane children (#3180/#3200/#2036/#4119) cannot
close most of this; the observable-semantics arm is lane-independent.

**Framing:** same substrate as #2668 — property access is shape-specialised
rather than routed through the ordinary-object MOP. A MOP fix for ordinary
objects should move both clusters, so do not size them additively.

**Missing-throw sub-cluster:** 113 files in this scope are `assert.throws` seeing
no exception at all inside `Array.prototype` methods (step-order validation never
firing). They belong to this umbrella, not to the new #4158.

**Not verified by repro** — counts from the published baselines; no compiler was
built for this re-measure.
