---
id: 3397
title: "standalone: boxed value used directly in scalar op (f64.ne/i32 cmp/ref.is_null) without unbox — invalid Wasm (~27 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: medium
feasibility: medium
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, type-coercion
language_feature: coercion, equality, truthiness
goal: standalone-mode
umbrella: 2039
related: [2039]
test262_bucket: standalone-invalid-wasm
test262_count: 27
es_edition: multi
---

# #3397 — scalar unbox missing in arithmetic/branch position (child of #2039)

## Bucket

- **Records:** 27
- **Validator signatures (a boxed/wrong-rep value feeds a scalar-typed
  instruction slot):**
  - `f64.ne[0] expected type f64, found local.tee of type externref` — 7 (all
    `line-terminators`; also 1 `i32.ne … found externref`)
  - `i32.lt_s[0] expected type i32, found local.get of type f64` — 3 (Atomics)
  - `ref.is_null[0] expected reference type, found local.get of type f64/i32` — 3
  - `array.len expected arrayref, found local.get of (ref/i32)` — 3 (TypedArray)
  - assorted `call expected f64/externref, found f64.const/local.get`,
    `extern.convert_any expected anyref, found i32`, `local.tee expected
externref, found i32/f64` — ~11
- **Area distribution:** line-terminators:8, Atomics:3, statements:3,
  expressions:3, TypedArray:3, Array:2, Temporal:2, ArrayBuffer:1,
  rest-parameters:1, Object:1.
- **3 sample tests:**
  - `test/language/line-terminators/S7.3_A7_T6.js`
    (`f64.ne[0] expected f64, found local.tee of type externref`)
  - `test/built-ins/Atomics/notify/notify-one.js`
    (`i32.lt_s[0] expected i32, found local.get of type f64`)
  - `test/built-ins/Array/prototype/toLocaleString/user-provided-tolocalestring-shrink.js`
    (`ref.is_null[0] expected reference type, found local.get of type f64`)

## Reproduced on current main

```
INVALID [line-terminators/S7.3_A7_T6.js]:
  Compiling function #64:"test" failed:
  f64.ne[0] expected type f64, found local.tee of type externref @+39683
```

## Root cause

A value stored in a local at one ValType (externref, or f64) is consumed by a
scalar instruction that requires a different ValType, with no coercion inserted:

1. **`f64.ne`/`i32.ne` got externref (7+1).** The `line-terminators` tests
   compare a value in a numeric/equality context, but the operand local is
   typed externref (a boxed value). The comparison lowering pushes the raw
   externref into `f64.ne` instead of unboxing (`any.convert_extern` +
   `__unbox_number` or `coerceType(externref, f64)`).

2. **`i32.lt_s` got f64 (3, Atomics).** An index/count value is f64 in a local
   but the Atomics bounds-check emits `i32.lt_s`, missing an `i32.trunc`/
   `coerceType(f64, i32)`.

3. **`ref.is_null` got f64/i32 (3).** A null-check is emitted on a scalar value
   — the value's ValType was resolved as a ref (nullable) but is actually a
   scalar, so `ref.is_null` is illegal. The producing expression's ValType is
   mistracked (mirror of #3394's producer-side issue, but for the numeric side).

4. **`array.len` got non-array (3, TypedArray).** A TypedArray receiver resolved
   to a struct/i32 where the length read expects an arrayref — missing the
   backing-array projection before `array.len`.

All four are the same class: **the operand ValType tracked by codegen disagrees
with what the emitted scalar op requires, and no `coerceType` bridges the gap.**

## Implementation Plan

### Investigation anchors

- **f64.ne / i32.ne (equality/relational):** grep `compileBinaryExpression`
  comparison cases (`===`, `!==`, `<`, `>`) in `src/codegen/expressions.ts`.
  Where an operand local is externref but the op is `f64.ne`/`i32.ne`, route the
  operand through `coerceType(operandType, f64)` (unbox) before the compare —
  OR select an externref-aware equality helper. Root: the operand's tracked
  ValType (externref) is not being consulted when choosing the compare opcode.
- **i32.lt_s (Atomics bounds):** grep the Atomics builtins lowering; insert
  `coerceType(f64, i32)` (f64→i32 trunc) on the index/count before the compare.
- **ref.is_null on scalar:** find the nullish/`== null` lowering; gate
  `ref.is_null` on the operand actually being a ref ValType — for scalar
  operands the null test is a constant `false` (numbers are never null).
- **array.len:** grep TypedArray `.length` / `.byteLength` lowering; project to
  the backing arrayref before `array.len`.

### Fix pattern

- Prefer routing every scalar-op operand through `coerceType(from, opValType)`
  keyed on the operand's tracked ValType, rather than assuming the operand is
  already the scalar type. This is the same discipline as #3394 but on the
  unbox/scalar side.

### Wasm IR pattern (targets)

```wasm
;; externref operand into f64 compare
local.get $x                 ;; externref
any.convert_extern
call $__unbox_number         ;; -> f64   (or coerceType(externref,f64))
f64.ne
;; f64 index into i32 bounds check
local.get $i                 ;; f64
i32.trunc_sat_f64_s
i32.lt_s
```

### Edge cases

- NaN semantics for `f64.ne`: unboxing must preserve NaN so `NaN !== NaN` holds.
- `ref.is_null` on a value that COULD be either scalar or ref (union `any`):
  keep the ref path when the ValType is genuinely nullable; only elide for
  statically-scalar operands.
- Atomics index truncation must match spec ToIndex (throw on out-of-range) —
  don't silently truncate a non-integer.

### Test files to verify

- `test/language/line-terminators/S7.3_A7_T6.js`
- `test/built-ins/Atomics/notify/notify-one.js`
- `test/built-ins/Array/prototype/toLocaleString/user-provided-tolocalestring-shrink.js`
- Regression test `tests/issue-3397-scalar-unbox.test.ts` (standalone + wasi +
  host-guard).

## Acceptance criteria

- All 27 rows compile to valid Wasm (or refuse loudly).
- NaN / equality semantics preserved (equivalence tests).
- No host-mode regression.
