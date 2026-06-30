---
id: 2883
title: "Hint-less object-literal [Symbol.toPrimitive]() emits invalid Wasm — __call_@@toPrimitive arity mismatch (expected externref, got (ref N))"
status: done
sprint: current
created: 2026-06-30
updated: 2026-06-30
completed: 2026-06-30
assignee: ttraenkler/explore4
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: symbol-toprimitive
goal: core-semantics
depends_on: []
related: [1716, 2083, 2638, 2679]
---

# #2883 — hint-less `[Symbol.toPrimitive]()` produces an invalid Wasm module

## Symptom

Any module containing an object literal (or class) whose `[Symbol.toPrimitive]`
method **does not declare a hint parameter** failed `WebAssembly.instantiate`:

```
WebAssembly.instantiate(): Compiling function #N:"__call_@@toPrimitive" failed:
  type error in fallthru[0] (expected externref, got (ref 25)) @+4400 in __call_@@toPrimitive()
```

This is the extremely common abrupt-completion test shape
`{ [Symbol.toPrimitive]() { throw new Test262Error(); } }` and the forked
two-literal shape. Because the whole module fails to instantiate, the affected
tests register as `compile_error`, not `fail`.

## Blast radius (fresh single-file scan, current origin/main)

40 test262 tests across the suite produced the invalid `__call_@@toPrimitive`
module: `AggregateError`/`SuppressedError` message-ToString-abrupt,
`String.prototype.replaceAll` this-tostring / replaceValue-tostring,
`Array.prototype.flatMap` poisoned-length, `Atomics.waitAsync` argument
coercion (×23), `TypedArray.prototype.sort` sort-tonumber, annexB
`escape`/`unescape` to-primitive, `Iterator.zip*` options-mode, `ShadowRealm`,
`Intl` Segmenter/DisplayNames.

Measured net over the 291 `Symbol.toPrimitive`-touching tests:
**compile_error 49 → 9, pass 89 → 103 (+14), 0 regressions.**

## Root cause (ECMA-262 §7.1.1 ToPrimitive)

§7.1.1 step 2: when `input[@@toPrimitive]` is callable,
`Return ? Call(exoticToPrim, input, « hint »)`. The hint is _passed_, but a
method that ignores it (declares zero params) is still valid.

`emitToPrimitiveMethodExport` (src/codegen/index.ts) emits the runtime
`__call_@@toPrimitive(self, hint) -> externref` dispatcher. It resolved the
method via `classMemberFuncKey(ctx, "${structName}_@@toPrimitive")` and then
**unconditionally pushed `self + hint` (2 args)** into the `call`.

For a nominal/object-literal `[Symbol.toPrimitive](hint)` the resolved function
really is `(self/capture, hint) -> result` (2 params) — fine. But a **hint-less**
`[Symbol.toPrimitive]()` compiles to a single-param `(self/capture) -> result`
body (for an object literal the closure captures the object itself, so the lone
param is the object struct). Pushing 2 args into a 1-param callee is an arity
mismatch; a downstream arg-coercion/repair pass "fixed" it by consuming the hint
as the single param, **dropping the call result, and leaving the `self` struct
ref on the stack** — so the dispatcher's `if (result externref)` arm fell
through with `(ref N)` instead of `externref` → invalid module.

The 2-param (with-hint) shape always validated, which is why this hid behind the
more common explicitly-typed-hint tests.

## Fix

Branch the dispatch on the resolved method's **real param count**:

- `params.length >= 2` → forward the hint (`local.get 1`) — byte-identical to
  the old path (and still skips nativeStrings non-externref hint params).
- `params.length < 2` → call with `self` only (no hint push).

`ref.cast typeIdx` yields `(ref typeIdx)`, a subtype of the callee's
`(ref null typeIdx)` self/capture param, so the 1-arg call validates and
dispatches to the correct body. Result coercion (`extern.convert_any` /
`__box_number`) is unchanged.

Single localized change in `emitToPrimitiveMethodExport`; the dispatcher is only
emitted for modules that actually have a `_@@toPrimitive` method, so modules
without one are unaffected, and the with-hint path is unchanged — there is no
code path by which a previously-passing test can regress (confirmed: 0 losses
over the 291-test diff and the full TypedArray/DataView/ArrayBuffer/Iterator/
Promise/Error/Symbol lane re-scan).

## Test

`tests/issue-2883.test.ts` — `compileToWasm` validity guards for the hint-less
throwing / forked / multi-method shapes, plus `assertEquivalent` value checks on
the runtime ToPrimitive paths the dispatcher backs (`Number(o)`, `String(o)`,
object-key coercion) and the unchanged with-hint path.
