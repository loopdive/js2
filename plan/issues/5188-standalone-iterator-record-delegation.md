---
id: 5188
title: "Standalone: user @@iterator returning another iterable's iterator (IterRec delegation) yields zero elements"
status: in-review
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
  # 2026-08-29: +14 LOC in calls.ts is the comment block explaining the #1058
  # aliased-throw-array fix (one call site copies its Instr[] before handing it
  # to a second consumer). The rationale is non-obvious enough that a future
  # reader would otherwise "simplify" the copy away and re-break 534 tests.
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # 2026-08-29: same two changes — the adopt arm in buildIteratorBody (+6) and
  # the aliased-array copy in tryEmitInlineDynamicCall (+14). Both are local
  # additions to existing ladders, not new responsibilities worth a split.
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
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

## Results (2026-08-29)

Two defects, both required. Fixing either alone changes nothing.

**1. The delegation bug this issue describes** (`src/codegen/iterator-native.ts`).
The diagnosis in the plan was right about the symptom and wrong about the
carrier. `__iterator`'s OBJ arm calls the user's `@@iterator`, then wraps
whatever comes back as an OBJ record and probes a `next` PROPERTY on it. For
`obj[Symbol.iterator] = function () { return src[Symbol.iterator](); }` the
returned value is not a `{next()}` object — for a native array source it is the
canonical **`$Vec`** carrier (an `$__IterRec` for other sources). Neither has a
`next` property, so the first step reported done and iteration yielded zero
elements.

New `iterRecAdoptArm` runs at all three chokepoints where a `@@iterator`
result enters classification (the OBJ arm, the USER `deps` tail, the #3146
PARTIAL tail): an `$__IterRec` is returned by identity (kind tag intact, so VEC
cursors / driven generator frames / host-gen records all keep delegating), and
a `$Vec` is wrapped into a fresh `$IterRec{VEC, vec, 0, null}`. `ref.test` is on
exact struct types, so a real user iterator object can never match.

Probe (`.tmp/p5188/repro.ts`, the exact `makeIterable` shape): **0 → 6**.

**2. The blocker that hid it** (`src/codegen/expressions/calls.ts`).
The target list could not measure anything: **534 of 540 entries were compile
errors**, all "stack-balance (#1058): reaches an instruction array from
incompatible control-flow contexts". Cause: `tryEmitInlineDynamicCall` builds
the "Constructor cannot be invoked without 'new'" throw sequence ONCE and hands
the same `Instr[]` object both to `buildInt8ArrayCarrierMatch` (which nests it
under an `empty`-typed `if`) and to the `$__ta_ctor` arm (a `val externref`
`if`). Two incompatible branch contexts on one array ⇒ the repair pass fails
the whole compile closed. Every test262 file including `testTypedArray.js` hit
it. Fix: each consumer gets its own copy.

### Measured

| List | Before | After |
| --- | --- | --- |
| `wp-typedarray-current-fails.txt` (540) | **0 pass** (534 compile_error, 6 fail) | **58 pass** (21 compile_error, 461 fail) |
| `wp-typedarray-passing-spotcheck.txt` (40) | 3 pass (37 compile_error) | **39 pass**, 1 fail |
| `wp-iterators-passing-spotcheck.txt` (19) | 19 pass | 19 pass |
| `wp-forof-passing-spotcheck.txt` (40) | 37 pass, 3 fail | 37 pass, 3 fail (identical, pre-existing) |
| `wp-iterators-current-fails.txt` (95) | 16 pass | 16 pass |
| `wp-forof-current-fails.txt` (129) | 69 pass | 69 pass |

Attribution, measured not inferred: with ONLY the calls.ts fix, chunk `ta-aa`
(135 entries) scores **0 pass**; with both, **19**. The compile fix is the
enabler, the iterator fix is what actually flips tests.

The one remaining typedarray spot-check failure
(`prototype/map/speciesctor-get-species-custom-ctor-throws.js`) is not a
regression — it was a compile_error on base. That list was generated against a
tree where the harness still compiled, so its "passing" baseline was stale.

Equivalence gate: 24 failing / 1718 passing / 24 known — no new regressions.
All five ratchet gates green.

## Follow-ups

- 461 typedarray entries still fail and 21 still fail to compile. Now that the
  harness compiles they are visible as ordinary conformance gaps rather than
  one opaque blocker — worth a fresh clustering pass.
- `{ [Symbol.iterator]: function () { return src[Symbol.iterator](); } }` — the
  same delegation written as an object-literal computed property — still throws
  (`.tmp/p5188/r7.ts` `literalDelegating`). Different lowering from the post-hoc
  assignment; not covered here.
- A symbol-keyed method call on a plain object returns `undefined`
  (`obj2[Symbol.iterator] = function () { return 42; }; obj2[Symbol.iterator]()`
  → NaN, `.tmp/p5188/r6.ts`). Separate defect, unrelated to iteration.
- The `#1058` aliased-`Instr[]` hazard is structural: `buildThrowJsErrorInstrs`
  returns a fresh array, but any caller that reuses the RESULT in two branches
  re-creates the bug silently. A dozen sites hold a throw array in a variable.
  Worth a lint or a defensive copy inside `buildInt8ArrayCarrierMatch`.

## References

- #5138 (typedarray wave 1) — followUps §1 is the origin of this issue.
- #2038 / #3119 / #3075 / #3132 / #3164 — the IterRec kind-tag taxonomy.
