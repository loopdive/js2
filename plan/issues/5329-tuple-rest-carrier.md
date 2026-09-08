---
id: 5329
title: "Tuple-typed rest parameter has no carrier: invalid module + null-deref on every call"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

A tuple-typed rest parameter — `function (...args: [Error])` — is a carrier
neither rest builder recognised, and both of their "anything else" fallbacks
were wrong:

- **`compileRestClosureArguments`** (`src/codegen/expressions/calls-closures.ts`)
  fell through to `pushDefaultValue(ref …)`, i.e. `ref.null` + `ref.as_non_null`.
  Every direct call to such a closure trapped with **"dereferencing a null
  pointer"** before its body ran.
- **`classifyClosureDispatchRest`** (`src/codegen/closure-exports.ts`) answered
  `undefined`, which the caller could not distinguish from *"there is no rest
  formal"*. The closure was therefore admitted as an ordinary arity-N entry with
  the formal dropped, so the arm's `call_ref` was one operand short and the
  **whole module** failed validation:
  `Compiling function #N:"__call_fn_0" failed: not enough arguments on the stack
  for call_ref (need 2, got 1)`.

Production witness: jest's `packages/jest-jasmine2/src/queueRunner.ts` —
`const next = function (...args: [Error]) {…}` plus a `next.fail` twin. It was
the **only** module of the 34 in the jest dogfood suite that failed Wasm
validation.

## Root cause

Rest parameters have three carriers in this compiler and the classifier knew two
and a half of them:

| source | lowered carrier |
| --- | --- |
| `...args: number[]` / `...args` | `{ length, data }` vec |
| `...args: T` (generic) | `externref` |
| `...args: []` | zero-field struct |
| **`...args: [Error]`** | **`__tuple_N` struct, one field per element** |

The last row hit neither `getArrTypeIdxFromVec` (not a vec) nor the
`fields.length === 0` branch.

Two independent things were wrong, and only fixing both is safe:

1. **No recipe for the carrier.** Added — the tuple struct is built
   positionally, one field per element, padded with that field type's
   missing-argument default.
2. **`undefined` was overloaded.** "No rest formal" and "a rest formal I cannot
   build" are different facts and the callers must treat them differently. The
   classifier now answers `{ kind: "unsupported" }` for the second, and both
   dispatch builders SKIP such an entry. An unbuildable carrier can no longer
   cost the module its validity — the worst case is a closure that is not
   offered on the host dispatcher.

The recognizer lives in one place — `src/codegen/closures/tuple-rest-carrier.ts`
— so the two builders agree by construction rather than by coincidence.

## Evidence

- Minimal repro (dogfood harness, `compileAndRunUpstreamModule`):
  `const f = function (...a: [number]) { return a[0]; }; f(7)` — invalid module
  before, `7` after. `[Error, Error]` likewise.
- Controls that were already clean and stay clean: `...a: number[]`,
  `...a: any[]`, `...a: []`, a top-level `function f(...a: [number])`.
- `tests/issue-5329-tuple-rest-carrier.test.ts`: **3 failed → 3 passed**. On the
  base arm the compile reports `success: true` and then
  `WebAssembly.instantiate` rejects the module.
- jest dogfood: `queueRunner.test.ts` stops failing validation. Its 6 tests do
  **not** yet pass — see the residual below — so the suite headline does not
  move on this change alone.

## Residuals (measured, deliberately not in this change)

- **`queueRunner.test.ts` is still 0/6.** With the module valid, the failure
  moves to a host-callback `TypeError: Cannot convert object to primitive value`
  raised from `invokeNativeFunctionCallback` while running the test's
  `jest.fn()` mocks. That is the same family as the `prompt`/`Replaceable`
  "illegal cast" bucket, not a rest-carrier problem.
- **`args.length` on a tuple reads NaN.** This is a property-access gap on tuple
  structs generally, not something the carrier introduced: a plain
  `const t: [number, number] = [1, 2]; t.length` reads NaN too, identically
  before and after. Asserted in the regression test so it cannot move silently.
