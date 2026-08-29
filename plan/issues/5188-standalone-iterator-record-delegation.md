---
id: 5188
title: "Standalone: user @@iterator returning another iterable's iterator (IterRec delegation) yields zero elements"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/runtime.ts
---

# #5188 — standalone IterRec delegation: `obj[Symbol.iterator] = () => other[Symbol.iterator]()`

## Problem

The test262 harness helper `makeIterable` (testTypedArray.js and friends) builds
`obj[Symbol.iterator] = function () { return src[Symbol.iterator](); }`. In
standalone mode, iterating that object (`Array.from(obj)`, `new TA(obj)`,
for-of, spread) yields **zero elements**. Measured during #5138: even
`Array.from(makeIterable(...))` returns length 0, which starves EVERY
TypedArray constructor-arg factory — all 8 factories must pass before any
cluster-A test goes green, so this single defect gates roughly ~500
still-failing TypedArray/ctor tests (see #5138 "followUps" §1), plus assorted
iterator-protocol tests elsewhere.

Diagnosed mechanism (#5138 follow-up, re-verify in step 0): in standalone,
`src[Symbol.iterator]()` on a native carrier evaluates to an
**externref-wrapped `$__IterRec`** (the internal iterator record struct,
`src/codegen/iterator-native.ts` ~L38: `{kind i32, …}` with kind tags VEC=3 /
USER=1 / OBJ / HOSTGEN / DRIVEN-…). When the USER @@iterator closure returns
that value, the consuming `__iterator` ladder classifies it as an OBJ/USER
iterator and then probes a `next` PROPERTY — which a raw record does not have —
so the first `__iterator_next` reports done immediately.

The #5138 implementer already attempted an "adopt the record" arm in both
tails of `buildIteratorBody` and it did NOT fix the symptom — so the actual
break may be upstream of those tails (e.g. the record is unwrapped/rewrapped
losing identity, or the USER-closure invocation path boxes the return through
a lane that never reaches those tails). Do not re-apply that patch blind.

## Implementation Plan

Step 0 — REPRODUCE AND INSTRUMENT FIRST (do not skip):
- Minimal repro, standalone target, via `.tmp/run-standalone.mts`-style compile
  (or a tiny probe module):
  `const src=[1,2,3]; const obj:any={}; obj[Symbol.iterator]=function(){return src[Symbol.iterator]();}; export function t(): number { let s=0; for (const v of obj) s+=v; return s; }`
  Expected 6, observed 0.
- Instrument: temporarily log (i32 markers via an exported counter, or WAT
  inspection with `/analyze-wat`) which kind-tag the consuming ladder assigns
  to the returned value, and which code path invoked the USER closure. Identify
  the EXACT function that mis-classifies (candidates: `buildIteratorBody`
  ladder tails in `src/codegen/iterator-native.ts`; the `__call_fn_method_0`
  boxing of the closure result; the externref→anyref unwrap in the for-of
  drive).

Step 1 — Adopt-the-record arm at the right chokepoint:
- Wherever a USER @@iterator closure's RETURN VALUE enters iterator
  consumption, add a `ref.test $__IterRec` arm BEFORE the OBJ/USER `next`-
  property probe: an externref that unwraps (`any.convert_extern` +
  `ref.cast`) to `$__IterRec` IS the iterator record — return it as-is
  (identity adoption), preserving its kind tag so VEC cursors, driven
  generator frames, and host-gen records all delegate correctly.
- Mirror the arm in `__iterator_next`/`__iterator_return` if records can reach
  them re-wrapped (step-0 instrumentation will say).

Step 2 — Repro must yield 6; then run:
- `.tmp/es2015/wp-typedarray-current-fails.txt` (or regenerate from
  `.tmp/es2015/wp-typedarray-fails.txt`) — expect a large batch of
  `built-ins/TypedArray*` ctor tests to flip.
- Iterator-protocol spot checks: `.tmp/es2015/wp-iterators-passing-spotcheck.txt`
  and `wp-forof-passing-spotcheck.txt` must stay green (the arm must not
  shadow genuine user iterators that HAVE a next method — `ref.test` on the
  exact struct type cannot match plain objects, but verify with
  `tests/equivalence/iterator-protocol-custom.test.ts` and
  `for-of-generator.test.ts`).

Step 3 — Gates + equivalence per repo protocol; commit with this issue file.

## Acceptance criteria

- The step-0 repro returns 6 in standalone.
- Net gain ≥ +100 on the typedarray current-fails list (expect several hundred
  across TypedArray + TypedArrayConstructors once all 8 factories pass).
- Spot-check lists green; equivalence gate green; five ratchet gates green.

## References

- #5138 (typedarray wave 1) — followUps §1 is the origin of this issue.
- #2038 / #3119 / #3075 / #3132 / #3164 — the IterRec kind-tag taxonomy.
