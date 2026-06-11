---
id: 1938
title: "Linear backend: number[] stores i32 elements ([1.5] → [1]) and element-assignment evaluates RHS twice"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen-linear
language_feature: arrays
goal: correctness
---
# #1938 — Linear number[] i32 truncation + double-eval RHS

## Problem

Two silent miscompiles in the linear backend's array path:

1. **`number[]` arrays store i32 elements** (`codegen-linear/runtime.ts:484`:
   "elements: i32×cap"). Reads convert back (`__arr_get` → i32 →
   `f64.convert_i32_s`, `index.ts:2734-2736`); writes truncate via
   `compileExprToI32` (`index.ts:2796-2798`). `[1.5]` silently becomes
   `[1]`. Map keys/values are likewise i32 (`index.ts:1021-1033`). Nothing
   documents or diagnoses this.
2. **Element-assignment-as-expression evaluates the RHS twice** — once for
   the store, again for the expression result (`index.ts:2797-2800`,
   `:2806-2809`, and the Float64Array path `:2772-2774`). `arr[i] = f()`
   calls `f()` twice; observable with any side-effecting RHS.

## Proposed approach

1. RHS double-eval (S, do first): compile RHS once into a scratch local;
   store from the local; leave the local as the expression value. Test with
   a counter-incrementing function as RHS.
2. Element type (M): switch `number[]` element storage to f64 (stride 8) in
   `runtime.ts` array helpers + `layout.ts`; keep an i32 fast path only
   where the element type is provably integral (explicit `i32`-typed
   annotation — mirroring the GC backend's `array-element-typing.ts`
   contract). Map keys: f64 (or document+diagnose integer-only until then —
   silent truncation is the bug, not the representation).
3. Add linear equivalence tests for fractional elements, NaN elements, and
   Map with fractional keys.

## Acceptance criteria

- `[1.5][0]` returns 1.5 under `--target linear` (test).
- `arr[i] = f()` calls `f()` exactly once (test).
- Existing linear tests green; benchmark suite (`benchmarks/run.ts` linear
  strategies) shows no crash.

## Source

Compiler quality review 2026-06. Related: #1937 (fail-loud companion),
#1854 (cross-backend differential harness would have caught both).
