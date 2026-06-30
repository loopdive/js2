---
id: 2881
title: "Number.is{Integer,Finite,NaN,SafeInteger} coerce non-Number args (boolean/undefined/null/symbol) instead of returning false"
status: done
area: codegen
language_feature: number-predicates
sprint: current
priority: medium
horizon: s
assignee: ttraenkler/explore3
completed: 2026-06-30
---

## Problem

`Number.isInteger` / `Number.isFinite` / `Number.isNaN` / `Number.isSafeInteger`
must return `false` for any argument whose **Type is not Number**, WITHOUT
coercion (ECMA-262 §21.1.2.2–.5: step 1 is _"If number is not a Number, return
false."_). The compiler instead routed several non-Number argument types through
the numeric "static number" fast path, coercing them and reporting wrong results:

| call                          | spec    | js2wasm (before)                   |
| ----------------------------- | ------- | ---------------------------------- |
| `Number.isInteger(false)`     | `false` | `true` (coerced `false`→`0`)       |
| `Number.isInteger(true)`      | `false` | `true` (coerced `true`→`1`)        |
| `Number.isNaN(undefined)`     | `false` | `true` (coerced `undefined`→`NaN`) |
| `Number.isInteger(Symbol())`  | `false` | `true`                             |
| `Number.isInteger()` (no arg) | `false` | fell through to the generic path   |

Root cause is in `compileNumberIsPredicate` (`src/codegen/expressions/calls.ts`).
It classified an argument as a "static number" when
`isNumberType(argTsType) || argWasm.kind === "f64" || argWasm.kind === "i32"`.
But the Wasm representation is a poor proxy for the _type_:

- `boolean` lowers to **i32** (`true`→1, `false`→0),
- `undefined` / `void` / `null` lower to an **f64 `NaN`** (CLAUDE.md: "null/
  undefined in f64 context → `f64.const NaN`"),
- `symbol` lowers to a single-slot reference that BOTH the i32/f64 fast path AND
  the `__typeof_number` runtime guard mis-handle (the guard reports it as a
  number).

So these non-Number types hijacked the coercing fast path. For
`isInteger`/`isFinite`/`isSafeInteger` the `NaN` happened to yield the correct
`false`, which is why only `Number.isNaN(undefined)` surfaced as visibly wrong —
but `boolean` and `symbol` were wrong for every predicate.

Affected test262 (all under `test/built-ins/Number/`):

- `isInteger/arg-is-not-number.js`
- `isFinite/arg-is-not-number.js`
- `isNaN/arg-is-not-number.js`
- `isSafeInteger/arg-is-not-number.js`

## Fix

In `compileNumberIsPredicate`:

1. **Statically-`symbol` argument** → fold to `false` at compile time (evaluate
   the argument expression for its side effects via `compileExpression` + `drop`,
   then push `i32.const 0`). Neither the fast path nor `__typeof_number` yields
   the spec answer for a Symbol, so it gets its own arm.
2. **Exclude `boolean` / `undefined` / `void` / `null`** from the "static
   number" classification (mask `BooleanLike | Undefined | Void | Null`). They
   then take the existing runtime `__typeof_number` guard, which correctly
   reports a non-number and returns `false` (no coercion).
3. **No-argument call** (`Number.isInteger()` etc.) → return `false` directly
   (the implicit argument is `undefined`, whose Type is not Number). Previously
   the `arguments.length >= 1` guards fell through to the generic member-call
   path.

Genuine `number` arguments are unaffected (still take the direct f64 test).

## Test Results

- `tests/issue-2881.test.ts` (3 cases) — pass.
- test262 `Number/{isInteger,isFinite,isNaN,isSafeInteger}` (34 files, fresh
  single-file run): **34/34 pass** (was 30/34 — the 4 `arg-is-not-number.js`
  files flipped).
- Full `Number/` lane re-scan: no new failures (net −4).
