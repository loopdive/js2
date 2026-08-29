---
id: 5193
title: Compiled value handed to host Float64Array constructor has no marshalling path — blocks Temporal polyfill module init
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5193 — host TypedArray constructor cannot accept an opaque compiled value

## Problem

With the #5191 fix applied (builtin-derived classes get their class-object
singleton), the `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` linked ESM bundle
advances past jsbi's statement 2 during module init and now stops at:

```
TypeError: cannot marshal opaque compiled value to host Float64Array constructor
```

`moduleInitRuns` stays `false`, so the module still yields no exports, and
#4628 Option A (Temporal as a real runtime global) remains gated on this.

## Repro

On a tree containing both the #5191 fix (PR #5242) and the instrumented
harness (PR #5239):

```
node --import tsx tests/dogfood/temporal-polyfill-harness.mjs
```

esm linked lane → `moduleInitError: TypeError: cannot marshal opaque compiled
value to host Float64Array constructor`.

A reduced repro should be extracted first (the polyfill/jsbi init passes a
compiled (WasmGC-backed) value — likely an array or ArrayBuffer produced by
compiled code — to the host `Float64Array` constructor import). Expect the
shape to be roughly:

```js
const src = [1.5, 2.5];        // compiled-side value
const f = new Float64Array(src); // host ctor receives an opaque ref
```

## Direction

The host-lane TypedArray constructor import needs a marshalling path for
compiled-side values (iterable/array-like → host copy), or the constructor
call needs to detect a compiled receiver argument and route through a
compiled-side construction instead. Decide with evidence; keep the standalone
lane's behavior unchanged (this failure is in the host lane's imports).

## Acceptance criteria

1. Reduced repro compiles and runs correctly on the host lane (values
   readable back, `.length` correct).
2. The Temporal harness advances: module init gets past this error. If a new
   later blocker appears, file it (don't fix here) and record it.
3. If `moduleInitRuns` flips to `true`, say so loudly — that un-gates #4628's
   integration step.
4. No regressions in scoped TypedArray tests (name the files run).

## Notes

- Found by dev-5191 while validating PR #5242 (see its "Temporal harness"
  section for the A/B).
- Id #5193 reserved with a degraded PR scan (gh offline); manually verified
  against all 19 open PR head branches on 2026-08-29 — none carries a 5193
  issue file. The `check:issue-ids:against-main` gate arbitrates.
