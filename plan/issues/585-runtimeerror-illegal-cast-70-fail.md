---
id: 585
title: "RuntimeError: illegal cast (70 FAIL)"
status: done
created: 2026-03-19
updated: 2026-08-24
completed: 2026-03-19
priority: medium
feasibility: medium
goal: crash-free
sprint: 0
test262_fail: 70
files:
  src/codegen/expressions.ts:
    breaking:
      - "ref.cast fails on mismatched closure/struct types at runtime"
---
# #585 — RuntimeError: illegal cast (70 FAIL)

## Status: in-review
70 tests fail with "RuntimeError: illegal cast" — ref.cast encounters a value whose runtime type doesn't match the expected struct type.

### Root cause
Residual after #1115 (closure struct subtyping). The main remaining cause was:
- When a closure returning externref is passed to a function expecting `() => void`, two different wrapper struct types are created (one for `() -> externref`, one for `() -> void`). The closure struct is a subtype of the wrong wrapper, causing ref.cast to fail at the call site.

## Complexity: M

## Implementation Summary

### What was done
1. In `compileArrowAsClosure` (expressions.ts), added contextual type checking: when a closure is created as an argument to a function, check if the contextual type expects void return. If so, override the closure's return type to void so it uses the same wrapper struct type as the callee expects.

2. In `compileReturnStatement` (statements.ts), added a safety drop: when a void function has `return expr;`, the expression value is dropped before the return opcode (Wasm requires an empty stack for void function returns).

### Results
- 51 tests had "illegal cast" in the latest test262 run
- 44 of 51 (86%) no longer have illegal cast errors
- 30 tests now fully PASS
- 7 tests still have illegal cast (destructuring elision + generator patterns -- different root cause)
- 10 tests have other runtime errors (anonymous class struct issue, not related to closures)

### Files changed
- `src/codegen/expressions.ts` — contextual type override for closure return type
- `src/codegen/statements.ts` — drop return value in void functions
- `tests/illegal-cast-closures-585.test.ts` — 7 new tests covering the fix

### What worked
Using TypeScript's contextual type system to determine the correct wrapper struct type at closure creation time. This aligns the closure's wrapper struct hierarchy with what callers expect.

### What didn't work / remaining
- 7 tests still have illegal cast in generator+destructuring patterns (different code path)
- The approach doesn't help closures passed through module globals where the contextual type isn't available at creation time

## 2026-08-24 class host-bridge validation repair

The retained seven-test regression file exposed a later, adjacent validation
defect in its class-expression case. The compiler emits host-callable class
method dispatchers even when the source only calls the method inside Wasm.
`getVal(): number` therefore left an `f64` result on an `externref` dispatcher
path when the module had no `__box_number` helper, and WebAssembly validation
rejected `__class_call_getVal_0` before the original closure regression could
run.

Numeric class-dispatch results now fail closed when boxing infrastructure is
absent: the dispatcher drops the raw `f64`, `f32`, `i32`, or `i64` result and
returns a null externref host fallback instead of emitting an invalid stack
type. When `__box_number` is present, the existing exact boxed-number path is
unchanged. This is host-bridge availability handling, not a change to the
compiled direct call, so the in-Wasm `obj.getVal()` still returns `99`.

Exact evidence: `tests/illegal-cast-closures-585.test.ts` compiles, validates,
and passes **7/7**. This repairs the retained harness; it does not reclassify
the historical generator/destructuring residuals documented above.
