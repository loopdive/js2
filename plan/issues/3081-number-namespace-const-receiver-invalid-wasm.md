---
id: 3081
title: "invalid Wasm: Number.prototype method on a namespace-constant receiver (Number.NaN.toFixed(0)) emits a call with an externref receiver where f64 is expected"
status: done
completed: 2026-07-07
assignee: ttraenkler/dev-B
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: number-builtins
goal: correctness
related: [2160, 2933, 49]
---

# #3081 — namespace-constant Number method receiver → invalid Wasm

## Problem

`Number.NaN.toFixed(0)`, `Number.POSITIVE_INFINITY.toExponential(2)`,
`Number.MAX_SAFE_INTEGER.toFixed(0)`, etc. emitted **invalid Wasm** that failed
at instantiate:

```
WebAssembly.instantiate(): Compiling function "f" failed:
call[0] expected type f64, found call of type externref
```

`Number.NaN` / `Number.POSITIVE_INFINITY` / `Number.MAX_VALUE` are typed `number`
by the checker, so they enter the numeric `toFixed`/`toPrecision`/`toExponential`
lowering. But the value itself lowers through `__get_builtin` to a **boxed-number
externref**, not an f64. `emitNumberMethodReceiverF64` only widened an i32
receiver and left an externref receiver un-coerced, so the externref was fed
straight to `number_to{Fixed,Precision,Exponential}` (which expect an f64
receiver) → the type mismatch above.

## Fix

`emitNumberMethodReceiverF64` (`src/codegen/expressions/calls.ts`) now recovers an
externref/ref receiver to f64 via `__unbox_number` — the same helper the
standalone Number-wrapper path in the same function already uses. A non-externref
ref is coerced to externref first. An externref receiver was ALWAYS invalid Wasm
here, so the unbox cannot regress any previously-instantiable module.

## Impact

Removes a class of **invalid-Wasm emission** (a latent hazard — invalid output is
never acceptable). Net-0 on test262 _today_: the single test with this signature,
`Number/prototype/toFixed/S15.7.4.5_A1.3_T02.js`, is **additionally** blocked by a
separate pre-existing issue — after this fix the module instantiates and
`Number.NaN.toFixed(Number.POSITIVE_INFINITY)` correctly throws RangeError, but
the test's `assert(e instanceof RangeError)` fails because the compiled thrown
RangeError is not recognised by `instanceof RangeError` (error-object
representation, tracked separately). This fix is a prerequisite for that test and
a correctness/robustness improvement in its own right.

## Acceptance

- [x] `Number.NaN.toFixed(0)` compiles to valid Wasm → "NaN".
- [x] `Number.POSITIVE_INFINITY.toExponential(2)` → "Infinity";
      `Number.NEGATIVE_INFINITY.toPrecision(3)` → "-Infinity".
- [x] No regression: primitive-f64 / i32 receivers + toString(radix) unchanged
      (issue-1735 / issue-1321 / issue-49 / issue-3078 green).
- [x] Unit coverage: `tests/issue-3081-number-namespace-const-receiver.test.ts`.

## Notes

Follow-up to unlock the S15.7.4.5_A1.3_T02 win: the caught compiled RangeError
must satisfy `e instanceof RangeError` (error-object nominal representation).
