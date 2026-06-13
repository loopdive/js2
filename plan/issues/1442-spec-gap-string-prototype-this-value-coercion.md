---
id: 1442
title: "spec gap: String.prototype methods — RequireObjectCoercible + ToString on this value"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-prototype-this
goal: spec-completeness
sprint: 52
related: [1434, 1441]
---
# #1442 - String.prototype methods: ToString on receiver

## Problem

String prototype methods invoked with a non-string `this` value fail in
two distinct ways:

1. **`String.prototype.method.call(value, ...)`** with `value` being a
   boolean, number, object, or arguments object — the compiled code
   reports `Cannot convert object to primitive value` or `dereferencing a
   null pointer`.
2. **`Number.prototype.foo = String.prototype.foo; (NaN).foo()`** —
   assigning a string method onto another prototype and invoking with
   that other type as `this`. Same failure modes.

Per §22.1.3 every String.prototype method begins with
`RequireObjectCoercible(this)` then `ToString(this)`. Today the compiler
treats `<receiver>.method()` as a typed-string call when the static type
is `string`, but for `String.prototype.method.call(x, ...)` patterns it
emits a direct invocation that assumes the receiver is already a
nativeString — yielding null derefs and primitive-conversion errors.

Sample failing tests:
- `test/built-ins/String/prototype/trim/15.5.4.20-2-2.js` —
  `String.prototype.trim.call(true)` should return `"true"`.
- `test/built-ins/String/prototype/trim/15.5.4.20-2-51.js` —
  `String.prototype.trim.call(arguments)` with `[[Class]] Arguments`.
- `test/built-ins/String/prototype/substring/S15.5.4.15_A1_T1.js` —
  `__instance = new Object(true); __instance.substring = String.prototype.substring;`
- `test/built-ins/String/prototype/toLowerCase/S15.5.4.16_A1_T6.js` —
  `Number.prototype.toLowerCase = String.prototype.toLowerCase; (-Infinity).toLowerCase()`
  should be `"-infinity"`.
- `test/built-ins/String/prototype/charAt/S15.5.4.4_A1.1.js` —
  `String.prototype.charAt.call(null)` should throw TypeError.
- `test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T9.js` and
  `built-ins/String/prototype/indexOf/S15.5.4.7_A1_T2.js`.

## Failure count

≥65 failures in test262-current.jsonl, distributed:
- `Cannot convert object to primitive value` in String/prototype/*: 33
- `Cannot access property on null` in String/prototype/*: 18
- `Number.prototype.X = String.prototype.X` pattern: 14
- plus the `String.prototype.trim.call(true)` family.

## Root cause

`src/codegen/string-ops.ts` handles each String.prototype method by
calling `compileExpression(ctx, fctx, propAccess.expression)` followed by
`emitFlatten()` — both rely on the receiver being a `nativeStringType`.
When the receiver is `externref` (e.g. a boxed Number or the
`arguments` object), the flatten helper interprets the bits as a string
ref and derefs null. No `RequireObjectCoercible(this)` +
`ToString(this)` step exists.

Likewise `String.prototype.method.call(x, ...)` is special-cased in
`src/codegen/expressions/calls-closures.ts`/`calls.ts` for cases where
`x` is statically a string, but not for the general case where `x` may
be any value.

## Implementation sketch

1. Add a `ToString` runtime helper (or reuse the one used by template
   literals/`String(x)`) and a `RequireObjectCoercible(this) throw on
   null/undefined` check.
2. In `string-ops.ts`, for every method, inject the
   `RequireObjectCoercible → ToString` sequence at the top of the
   receiver compile path *unless* the static receiver type is already a
   string (fast path).
3. Extend the `String.prototype.X.call(thisArg, ...)` dispatcher to
   funnel through the same coercion.
4. Treat the `arguments` object / boxed primitives the same way: the
   coercion runs on the externref and returns a flat native string.

## Acceptance criteria

1. `String.prototype.trim.call(-Infinity) === "-Infinity"`.
2. `String.prototype.trim.call(true) === "true"`.
3. `String.prototype.charAt.call(null)` throws `TypeError`.
4. `(new Object(true)).substring = String.prototype.substring;
   (new Object(true)).substring(false, true) === "t"`.
5. `built-ins/String/prototype/*` failures of the listed patterns drop
   by ≥75%.

## Files to inspect

- `src/codegen/string-ops.ts` (all method dispatch sites)
- `src/codegen/expressions/calls-closures.ts`,
  `src/codegen/expressions/calls.ts` (`.call`/`.apply` dispatch)
- `src/codegen/type-coercion.ts` (ToString helper)
- `tests/issue-1442.test.ts`
