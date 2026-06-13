---
id: 1445
title: "spec gap: String.raw + String.prototype.* argument coercion (ToInteger / ToPrimitive)"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-arg-coercion
goal: spec-completeness
sprint: 52
related: [1434, 1442]
---
# #1445 - String.raw + String.prototype argument coercion

## Problem

Two argument-coercion gaps:

1. **`String.raw(template, ...substitutions)`** does not invoke the
   spec-prescribed `ToObject(template)` /
   `ToObject(Get(cooked, "raw"))` / `ToLength(Get(raw, "length"))` /
   `ToString(Get(raw, key))` sequence. Tests that pass plain object
   templates or hostile getters bypass the abrupt completions and
   either crash or produce wrong output.
2. **String.prototype methods that take numeric arguments**
   (`indexOf(position)`, `slice(start, end)`, `substring`, `substr`,
   `charAt`, `charCodeAt`, `codePointAt`, `padStart(length)`,
   `padEnd(length)`, `repeat(count)`, `startsWith/endsWith(position)`)
   do not run `ToInteger` / `ToLength` / `ToPrimitive` on those
   arguments. Tests that pass objects with `valueOf` or BigInt fail.

Sample failing tests:
- `test/built-ins/String/raw/template-length-is-symbol-throws.js` —
  `{raw:{length: Symbol(1)}}` must throw TypeError.
- `test/built-ins/String/raw/returns-abrupt-from-next-key.js` —
  abrupt getter must propagate.
- `test/built-ins/String/raw/returns-abrupt-from-next-key-toString.js`.
- `test/built-ins/String/prototype/indexOf/position-tointeger-bigint.js`
  — `"".indexOf("", 0n)` must throw TypeError.
- `test/built-ins/String/prototype/indexOf/searchstring-tostring-toprimitive.js`
  — Symbol.toPrimitive on the search arg.

## Failure count

≥34 failures across `tostring`/`toprimitive`/`tointeger`/`tonumber`
test files inside `built-ins/String/prototype/*`, plus 15 in
`built-ins/String/raw`.

## Root cause

- `src/codegen/string-ops.ts` emits each numeric arg via
  `compileExpression(ctx, fctx, arg, { kind: "f64" })` which performs
  *implicit* coercion only for statically-typed paths. Externref args
  (objects with `valueOf`) and BigInt args are not routed through the
  shared `ToNumber/ToInteger` runtime helper used by #1434.
- `String.raw` is implemented (search `String\.raw` in
  `src/codegen/expressions/calls.ts` or `builtins.ts`) but does not
  follow the spec algorithm — its `length` read does not go through
  `ToLength`, and the per-key read does not go through `ToString`.

## Implementation sketch

1. Replace direct `compileExpression(..., { kind: "f64" })` calls in
   `string-ops.ts` for index/length args with a `ToInteger`/`ToLength`
   helper call when the static arg type is `any`/`externref`/`bigint`.
2. In the `String.raw` implementation, run each `Get` through the
   shared `ToString` and `ToLength` helpers and propagate abrupt
   completions (throw TypeError if a Symbol is observed).
3. BigInt args to index/length methods must throw TypeError —
   confirm `ToInteger` rejects BigInt as spec requires.

## Acceptance criteria

1. `"".indexOf("", 0n)` throws `TypeError`.
2. `"".indexOf({[Symbol.toPrimitive]: () => "x"}, 0)` invokes
   `Symbol.toPrimitive` exactly once.
3. `String.raw({raw: {length: Symbol(1)}})` throws `TypeError`.
4. `String.raw({raw: {length: 2, 0: "a", get 1() { throw new
   Test262Error(); }}}, "x")` propagates the abrupt completion.
5. The 34 + 15 ≈ 50 listed failures drop to zero.

## Files to inspect

- `src/codegen/string-ops.ts` (each numeric-arg coercion site)
- `src/codegen/expressions/calls.ts` and
  `src/codegen/expressions/builtins.ts` (`String.raw` implementation)
- `src/codegen/type-coercion.ts` (ToInteger / ToLength / ToString
  helpers)
- `tests/issue-1445.test.ts`
