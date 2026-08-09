---
id: 3727
title: "IR classifies a PACKED (i8/i16) binary operand as an invariant violation — hard-fails a compile the legacy path handles"
loc-budget-allow:
  # Same 12 lines as the func-budget grant below — the packed-operand branch is
  # a guard inside `lowerBinary`, so it necessarily lands in this god-file.
  - src/ir/from-ast.ts
func-budget-allow:
  # The packed-operand capability-gap branch + the argument for why a packed
  # kind is not a producer-invariant violation.
  - src/ir/from-ast.ts::lowerBinary
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: typed-arrays
goal: ir-full-coverage
related: [681, 1131, 2855, 3341, 3519]
---

# #3727 — a packed IR operand is a capability gap, not a broken invariant

## Problem

Summing a typed array hard-failed the whole compile:

```ts
export function f(xs: Uint8Array): number {
  let sum: number = 0;
  for (const value of xs) {
    sum = sum + value;
  }
  return sum;
}
```

```
Codegen error: IR path failed for f: ir/from-ast: Phase 1 requires matching
operand types for '+' in f [IR-FALLBACK]
```

`success: false` — even though the LEGACY backend lowers this shape fine, and
`STRICT_IR_REASONS` is empty (so no IR rejection is supposed to be fatal).

Caught by `tests/issue-681-standalone-iterators.test.ts` ("keeps typed-array
for-of WASI-clean"), which was red on `main`.

## Root cause

`sum` is `f64`; `value` is **`i8`** (the `Uint8Array` element storage kind).
TypeScript types both as `number`, so
`checkerProvesBinarySourceCapabilityGap` answers **false** — no JS coercion is
required — and the mismatch fell to the invariant backstop:

```ts
throw new Error(detail); // → outcome.kind "invariant" → severity "error" → fatal
```

The backstop's reasoning ("if both operands are provably the same primitive,
their different IR representations contradict the producer's promise") is right
for `i32`-vs-`f64`. It is wrong for a **packed** kind, because packed kinds are
not a representation the producer could have delivered differently:

- WasmGC has no `i8`/`i16` **value** type. A packed read is
  `array.get_s`/`array.get_u`, which pushes an already-extended `i32`.
- The binary emitter rejects one in a value position outright:
  `encodeValType: packed storage type "i8" is not valid in a value position`.

So the IR simply cannot carry a `Uint8Array` element into f64 arithmetic today,
however the operands are coerced. That is a stable **capability gap** — exactly
what `IrUnsupportedError` is for.

## Fix

Classify a packed (`i8`/`i16`) binary operand as
`IrUnsupportedError("operand-coercion-unsupported")` instead of a bare `Error`.
The rejection then flows to the warning channel and the function falls back to
the legacy backend, which compiles it correctly.

## Rejected alternatives (measured, not assumed)

1. **Widen the packed operand to f64 at the mismatch** (`coerceIrNumeric` +
   `f64.convert_i32_s`). The IR verifier rejects it —
   `f64.convert_i32_s operand must be i32, got i8`.
2. **Also relax the verifier** to accept packed kinds where `i32` is expected
   (defensible: the stack value really is an i32). Gets one step further, then
   the emitter rejects the packed type in a value position — because the loop
   variable itself is an `i8`-typed SSA value, independent of the conversion.

Both confirm the same thing: the packed type is wrong at the **producer**, not
at the arithmetic. Making the IR genuinely lower this means typing the packed
element read as `i32` at the load. That is a real IR improvement and is left as
follow-up — until then, demoting to legacy is correct and complete.

## Acceptance criteria

- [x] The repro compiles and `tests/issue-681-standalone-iterators.test.ts`
      passes (8/8).
- [x] The rejection is non-fatal (warning channel), so the legacy body is used.
- [ ] Follow-up: type a packed element read as `i32` in the IR producer so the
      IR can claim this shape rather than decline it.
