---
id: 5340
title: "hono utils/concurrent: `RangeError: Invalid array length` on every test (0/6)"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`src/utils/concurrent.test.ts` is **0/6**. All six fail with:

```
RangeError: Invalid array length
```

That is the host's `new Array(n)` / `arr.length = n` throwing on a length
that is negative, non-integer, or `NaN`. A compiled value that should have been
a small non-negative integer arrived at the host as something else. The
canonical js2wasm shape for this is a number crossing a boundary as the
**undefined sentinel** (`0x7FF00000DEADC0DE` in an `f64` slot) or as `NaN`
from an `externref → f64` unbox that was never given a bridge — the exact
mechanism #5328 fixed for a *return* site (`allowProvenNumberUnbox` gated
correctly for arguments, wrongly for results).

Measured on a clean detached worktree at main `c9a8b48616`.

## Evidence

- Six entries in `tests/dogfood/report/hono-upstream-suite.json` for this
  file, all with the `RangeError` first line and a non-null `wasmError`.
- hono's `src/utils/concurrent.ts` is small: it builds a bounded-concurrency
  runner (`new Array(concurrency)`-style pre-allocation and/or index arithmetic
  over a task list). The length operand is the suspect.

## Acceptance criteria

1. `src/utils/concurrent.test.ts` ≥ 5/6.
2. Regression test under `tests/`, failing on the parent, passing with the
   fix; untyped `.js` two-file fixtures; pins the numeric *value* reaching the
   host (e.g. `Array.isArray(new Array(n)) && new Array(n).length === n`);
   anti-vacuity control included.
3. A/B at one HEAD, 17 suites, per test file — hono improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read `tests/dogfood/.hono-upstream-suite/src/utils/concurrent.ts` and find
   every `new Array(`, `.length =`, and `Array.from({ length })`. One of
   those receives the bad operand.
2. Reduce with a negative control (standalone `.mjs`,
   `compileAndRunUpstreamModule`, harness sanity-checked). The likely minimal
   shape: a function whose numeric parameter has a **default** or arrives via
   an **options object / destructuring** (`{ concurrency = 4 } = {}`), used
   as an array length. Ablate: default vs no default; destructured vs
   positional; called from the same module vs from the test file (host
   boundary).
3. Dump WAT for the failing and passing forms. Look specifically for:
   - `f64.const` of the undefined sentinel feeding `__box_number` or a host
     `new Array` import;
   - an `externref → f64` site whose unbox was skipped (`drop` +
     `f64.const NaN` in `type-coercion.ts` ~3125/~3137, or the terminal
     fallback ~4290);
   - a parameter default lowered via `pushParamSentinel` whose callee-side
     check never ran because the call crossed the host bridge (the
     `__call_*` wrappers do not re-run default resolution).
4. Fix at the producer. If it is the same gate #5328 touched
   (`src/codegen/expressions/call-identifier.ts`, `allowProvenNumberUnbox`),
   extend that fix rather than adding a parallel one.
5. Regression test, A/B.

## Dispatch

Model: **opus**. Small file, sharp symptom, but the fix likely lands in
`call-identifier.ts` / `type-coercion.ts`, both of which have bitten this
effort with "looks equivalent, isn't" hazards.
