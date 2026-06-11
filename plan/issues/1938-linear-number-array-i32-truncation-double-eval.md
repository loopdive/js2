---
id: 1938
title: "Linear backend: number[] stores i32 elements ([1.5] → [1]) and element-assignment evaluates RHS twice"
status: in-progress
sprint: 61
created: 2026-06-10
updated: 2026-06-11
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

## Implementation notes (2026-06-11)

Split into two independent parts. **Part 1 (RHS double-eval) is done**; part 2
(f64 element storage) is carved out below because it requires a layout decision.

### Part 1 — element-assignment RHS double-eval — DONE

`compileElementAccessAssignment` (`src/codegen-linear/index.ts`) compiled the
RHS *twice*: once to feed the store, once to leave the value on the operand
stack as the expression result. So `arr[i] = f()` ran `f()` twice — observable
with any side-effecting RHS, across all four arms (array, Uint8Array,
Float64Array, Float32Array). Fix: compile the RHS once into a scratch local,
store from the local, leave the local as the expression value.

A subtlety surfaced while fixing it: for a numeric `arr[i] = v` the expression
result must be the **f64** value (an assignment-as-expression flows into an f64
context like `let x: number = (arr[i] = v)`), even though the store currently
truncates to i32. The scratch is therefore typed by `inferExprType(right)`
(f64 for numeric, i32 for reference elements); the store truncates from the f64
scratch, and the f64 scratch is returned. Tests:
`tests/linear-element-assign.test.ts` (RHS-once for array + Uint8Array,
assignment-expression value, truncated read-back).

### Part 2 — `number[]` stores i32 elements (`[1.5][0]` → 1) — CARVED OUT (needs layout decision)

Not a localized change. The linear array runtime (`runtime.ts` `__arr_new`/
`__arr_push`/`__arr_get`/`__arr_set`/`__arr_from_data` + ~20 inline
load/store sites across every Array.prototype method) uses a **single
type-agnostic i32×4 element layout shared by ALL array kinds** — `number[]`,
`boolean[]`, `string[]`, and object arrays all store an i32 (a value for
numbers/bools, a pointer for strings/objects). `number[]` reads convert i32→f64
on the way out (`index.ts:2734`), which is exactly the truncation.

Storing f64 elements requires either:
- **(a) a separate `__f64arr_*` runtime (stride 8)** selected by element type at
  every array call site (new/push/get/set/length/for-of/method dispatch/spread/
  Array.isArray), keeping the i32 runtime for reference arrays; or
- **(b) widening all array slots to 8 bytes** and boxing reference values,
  which wastes space for the common ref-array case and complicates the C-ABI
  (`__arr_from_data`, #1835, hands the runtime a contiguous i32 block).

Both ripple through the entire array-method suite and the for-of/Map iteration
paths; (a) additionally needs element-type routing the backend does not yet
thread to those sites. This is an architecture decision (which representation),
not a dev slice — recommend an architect spec before implementation. Acceptance
criterion `[1.5][0] === 1.5` is deferred to that follow-up.

## Source

Compiler quality review 2026-06. Related: #1937 (fail-loud companion),
#1854 (cross-backend differential harness would have caught both).
