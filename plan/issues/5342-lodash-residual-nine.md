---
id: 5342
title: "lodash residual: the last 9 of 62 — two traps, two Symbol-keyed nulls, two deepEqual misses — never investigated"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

lodash is **53/62** on clean main `c9a8b48616` (50 at the start of this
effort). Nobody has looked at the remaining nine. All are in the single
`test.js` file lodash's suite admits, so grouping by file tells nothing; the
error lines do:

```
 2  RuntimeError: dereferencing a null pointer
 2  assertion 1: deepEqual mismatch; object != object
 2  assertion 2: strictEqual mismatch; object:null !== string:Symbol(a)
 1  assertion 1: expected truthy value; got boolean:false
 1  assertion 6: strictEqual mismatch; boolean:true !== boolean:false
 1  assertion 1: deepEqual mismatch; object:null != string:-0,-0,0,0
```

Two of these are recognisable on sight:

- **`object:null !== string:Symbol(a)` (2)** — a `Symbol` reaching a
  string-typed slot and being dropped to `null`. lodash's `toString`/`isSymbol`
  paths, or a `Symbol`-keyed property read through `__extern_get` that the
  compiled side typed as string.
- **`object:null != string:-0,-0,0,0` (1)** — an array of signed zeros joined
  to a string answered `null`; `-0` handling in `String()`/`join` over an
  `f64` vec, or `Object.is`-style zero comparison (`_.eq`, `_.isEqual`).

## Acceptance criteria

1. lodash ≥ 58/62.
2. Regression test per fixed cause, failing on parent, passing with fix,
   untyped `.js` two-file fixtures, anti-vacuity control.
3. A/B at one HEAD, 17 suites, per test file — lodash improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Run the suite, read the report immediately, and for each of the nine pull
   the test **name** and the full `wasmError`. The names identify the lodash
   function under test (`_.toString`, `_.isEqual`, `_.eq`, …); that is the
   real grouping.
2. **Two null-pointer traps first** — traps are the cheapest to bisect (WAT
   shows the exact `struct.get`/`ref.as_non_null`). Reduce with a negative
   control (standalone `.mjs`, `compileAndRunUpstreamModule`, harness
   sanity-checked). Check the #5320/#5323/#5333 capture-cell family before
   treating as new.
3. **Symbol → null (2):** reduce `String(Symbol("a"))`-shaped code and a
   `Symbol`-keyed property read on an object literal. The slot that receives
   the symbol is typed string; find the coercion (`type-coercion.ts`) or the
   `__extern_get` result typing that drops it.
4. **`-0` (1):** reduce `[-0, -0, 0, 0].join()` / `String(-0)` /
   `_.eq(-0, 0)`. Check the `f64 → string` lowering for the `-0` special case
   and `Object.is` lowering.
5. deepEqual (2) and the two booleans last — likely downstream of the above.
6. Fix each at its site; **one PR per independent cause**; regression tests;
   A/B.

## Dispatch

Model: **opus**. Nine unexamined failures with at least four distinct
mechanisms; needs diagnosis before any fix.
