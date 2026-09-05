---
id: 4635
title: "Standalone: declared-alias TypedArray ctor misreads an array argument as a length (var TA = Int8Array; new TA([5]))"
status: ready
sprint: Backlog
created: 2026-08-23
updated: 2026-08-23
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/new-builtin-globals.ts
---

# #4635 — Declared-alias TA ctor: array arg treated as length

## Problem

Measured 2026-08-23 (standalone, `runTest262File` probe):

```js
var TA = Int8Array;
var sample = new TA([5]);
sample.length; // 5  — WRONG (spec: 1)
sample[0];     // undefined — WRONG (spec: 5)
```

The checker types `TA` as `Int8ArrayConstructor` (declared alias), so the
DYNAMIC any-ctor paths (fixed for the param shape in #4626's second slice)
never fire; some static builtin-alias arm claims the `new` and compiles
the COUNT constructor, ToNumber-ing the array (`[5]` → "5" → 5).
The direct spelling `new Int8Array([5])` is correct; the ANY-typed param
shape is correct since #4626 slice 2. Only the statically-aliased binding
misroutes.

Not currently blocking any test262 harness self-test (the harness uses
the param shape) — filed from the #4626 reduction so the residual is not
lost.

## Implementation Plan

1. **Locate the claiming arm**: instrument `compileNewExpression`
   (new-super.ts) for `new TA([5])` with the alias-typed binding — the
   #4626 debugging showed candidates: `tryNewBuiltinStaticAlias`
   (new-builtin-static-alias.ts, #4491 T6) and the
   `NEW_GLOBAL_FALLTHROUGH` route (new-builtin-globals.ts). Confirm which
   one wins before editing (repeat of the mark-trace method; the method is
   cheap, wrong guesses are not).
2. **Fix inside that arm**: it already resolves the concrete view kind
   from the alias's static type; give it the same argument-shape dispatch
   the direct `new Int8Array(...)` path has (count vs array-copy vs
   buffer vs view-copy) instead of unconditionally ToNumber-ing arg0.
   Reuse the direct path's helpers — do not re-implement the copy loops.
3. **Acceptance**: the probe answers `length 1, sample[0] === 5`; the
   direct and param spellings stay green
   (`harness/testTypedArray-conversions.js` standalone), and a 15-test
   standalone sample over `built-ins/TypedArray*/**` baseline-pass tests
   shows 0 regressions; js-host lane untouched.
