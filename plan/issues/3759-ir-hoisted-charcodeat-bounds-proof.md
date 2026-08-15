---
id: 3759
title: "IR needs a #2682-equivalent 'provably in-bounds charCodeAt' hoisting proof to close the string-hash hash-loop gap"
status: ready
created: 2026-07-28
priority: low
feasibility: hard
reasoning_effort: max
task_type: performance
area: ir
language_feature: bitwise-operators, loops, strings
goal: performance
related: [3745, 3758, 2682]
---

# #3759 — port legacy's #2682 hoisted-in-bounds-charCodeAt proof to IR

## ⚠️ Superseded in substance by #3931 (2026-08-15) — needs a triage decision

**#3931 landed exactly this**: `src/ir/char-read-loop.ts` carries the
in-bounds proof (steps 1–3 of "Suggested next step" below, in that order),
`isI32PureExprIR`/`emitI32PureExpr` now accept a proven `recv.charCodeAt(i)`
as an int32-range leaf, and the loop-preheader emission point turned out to
already exist (`lowerForStatement` emits into the enclosing buffer before it
collects the cond/body buffers — no builder API change was needed). Measured
on a string-hash-shaped workload: 16–20x across nativeStrings, standalone,
wasi and host.

The two issues were filed three days apart by different lanes and neither
cited the other; `pre-dispatch-gate.mjs` flagged the overlap by shared idiom.
What is left here that #3931 did NOT do is step 4 — re-measuring the actual
`benchmarks/string-hash.js` lane end-to-end (#3931 measured a synthetic
hash workload in four string modes, not that benchmark). Close this as
done-by-#3931 or re-scope it to that measurement; do NOT start a second
implementation.

## Context

#3758 added a sound native-i32 arithmetic fast path for bitwise-composed
expressions, closing #3741 and measurably speeding up pure-arithmetic
accumulator loops (`fib.js`: ~13% faster). It deliberately does **not**
close the landing `string-hash` benchmark's remaining gap, documented in
#3745: the hash loop's accumulator,

```ts
let hash = 0;
for (let i = 0; i < text.length; i++) {
  hash = (hash * 31 + text.charCodeAt(i)) | 0;
}
```

does not qualify for #3758's fast path, because its RHS
(`hash * 31 + text.charCodeAt(i)`) contains a CALL expression
(`text.charCodeAt(i)`) as a leaf. #3758's soundness predicate deliberately
excludes call expressions — `String.prototype.charCodeAt` returns `NaN` on
an out-of-bounds index, and ECMA-262's ToInt32 maps that `NaN` to `0` only
_after_ the surrounding expression evaluates. Naively fusing an
unconditionally-trusted `charCodeAt` result into native i32 arithmetic would
be unsound in the general case (mirrors legacy's own `isI32PureExpr`
`#1105` comment in `src/codegen/binary-ops.ts`).

## What legacy does instead

Legacy closes this exact gap via **#2682**
(`src/codegen/statements/loops.ts`'s `detectCanonicalCharReadLoop`,
`src/codegen/string-ops.ts`'s `matchHoistedCharRead`/
`emitHoistedCharCodeAtRead`): it recognizes a **canonical string-read loop**
shape —

```ts
for (let i = 0; i < recv.length; i++) {
  // ... recv.charCodeAt(i) ...
}
```

— where `i` is a proven `detectI32LoopVar` induction variable starting
`>= 0`, strictly increasing, and the loop condition is exactly
`i < recv.length` (a statically-string-typed receiver). Under those
conditions `recv.charCodeAt(i)` can **never** return `NaN` (the loop
condition itself proves `0 <= i < recv.length`), so it's safe to hoist:
flatten `recv` **once**, before the loop, extracting its raw data-array
reference and byte offset; then inside the loop, `recv.charCodeAt(i)`
becomes a bare `array.get_u(dataLocal, offLocal + i)` — no re-flatten, no
struct-field reload, no bounds check, no NaN branch, on every iteration.
This is what lets legacy's own compiled `string-hash` collapse the whole
hash-loop body to native `i32.mul` + `i32.add`.

## Why this isn't a small patch on top of #3758

`detectCanonicalCharReadLoop` is a **loop-preheader hoisting mechanism** —
it emits code (the flatten + field extraction) into the outer body
_before_ the loop starts, then threads two new locals (`dataLocal`,
`offLocal`) into the loop body's charCodeAt call sites via a
per-function `fctx.hoistedCharReads` map that's pushed/popped as the
compiler enters/leaves the loop's scope. IR (`src/ir/from-ast.ts`) has no
equivalent concept of "emit into the enclosing scope before this loop,
then reference across into the loop body" — every existing IR lowering
constructs a value at its own point of use, in-order, within the
structured `if`/`loop`/block buffers `IrFunctionBuilder` produces. Building
this requires either:

1. A genuine IR-level loop-preheader concept (emit instructions into the
   parent block just before the loop's `IrInstrLoop`/`while.loop`/`for.loop`
   buffer starts, then reference the resulting SSA values from inside the
   loop body — needs verifying this doesn't violate the dominance/SSA
   invariants `ir/verify.ts` enforces), or
2. Some other IR-native strategy that achieves the same effect (e.g. a
   dedicated `string.char_code_at_hoisted` composite IR op that takes the
   receiver + index and internally re-derives the hoist, though that
   risks re-doing the flatten/bounds-check work every iteration unless the
   backend emitter itself caches it — needs design work to confirm it's
   actually cheaper than the status quo).

Either way this is a **new feature**, not a follow-up patch — hence its own
issue rather than folding it into #3758 (whose whole point was to avoid
repeating the shortcut — rushing a second big feature into the same change
— that caused #3745's first attempt to be reverted).

## Suggested next step

1. Read `src/ir/builder.ts`'s loop-construction API
   (`IrFunctionBuilder`'s loop/while/for-of emission) to determine whether
   there's already a natural "parent scope, before the loop" emission point
   IR's structure supports, or whether one needs to be added.
2. Port `detectCanonicalCharReadLoop`'s AST-level shape detection
   (induction-var proof via `detectI32LoopVar`, `i >= 0`,
   `loopBodyMutatesStringReadInvariants` loop-invariance check, statically
   -string-typed receiver, at least one matching `charCodeAt(i)` call in
   the body) as a new predicate — this part is pure AST analysis and can
   likely be reused/adapted with minimal risk, independent of the harder
   IR-emission question above.
3. Once a proven-in-bounds `charCodeAt(i)` read has a value, extend
   #3758's `isI32PureExprIR`/`emitI32PureExpr` to accept it as a leaf
   (it's then unconditionally int32-range — [0, 65535] — exactly like any
   other proven-bounded leaf).
4. Re-measure the actual `string-hash.js` benchmark; #3745/#3758 measured
   its hash loop as the likely-larger cost (runs once per character vs.
   the build loop's once per two characters), so this is expected to move
   the benchmark's wall-clock number, unlike #3758 alone.

## Non-goals

Scoped to closing the measured `string-hash` hash-loop gap specifically —
not a general "hoist arbitrary loop-invariant computation out of a loop"
IR optimization pass (a much bigger, separate undertaking).
