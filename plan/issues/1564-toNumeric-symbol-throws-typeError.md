---
id: 1564
title: "ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: type-conversion
goal: spec-completeness
sprint: Backlog
es_edition: ES2015
test262_fail: 12
---
# ToNumeric: Symbol argument must throw TypeError

## Problem

`Number(Symbol('x'))` and other ToNumeric conversion paths currently silently produce NaN when passed a Symbol. Per §7.1.3 ToNumeric step 3, when the result of ToPrimitive on a Symbol is itself a Symbol (because Symbols have no numeric coercion), the abstract operation must throw a TypeError.

## Spec

ECMAScript §7.1.3 ToNumeric: "If Type(value) is Symbol, throw a TypeError exception."

## Fix

Add a Symbol-type guard in `src/codegen/type-coercion.ts` in the `compileToNumeric` function (or equivalent) before the numeric conversion path. ~2 lines.

## Acceptance criteria

- [x] `try { Number(Symbol()); return 'no-throw' } catch(e) { return e instanceof TypeError ? 'TypeError' : 'other' }` returns `'TypeError'`
- [x] No regressions on numeric-coercion paths that don't involve Symbol

## Root cause

The core ToNumber funnel (`Number(x)`, `new Number(x)`, unary `+`/`-`, `~`,
arithmetic/relational/update operators) already throws TypeError on Symbol
inputs via the `__unbox_number` ToNumber import (#1434). The remaining gap was
in the `Number.prototype` numeric formatters: `toFixed` / `toPrecision` /
`toExponential` compiled their digits argument directly into an f64 local
(`local.tee`/`local.set`) without funneling through ToNumber. A Symbol
argument (an externref at the Wasm level) produced an invalid-Wasm `local.tee`
(f64 vs externref) — a compile error — instead of the spec-required TypeError.

## Fix

`src/codegen/expressions/calls.ts`: added `coerceNumberMethodArgToF64` and
called it after compiling the digits argument at both the property-access
(`n.toFixed(...)`) and element-access (`n["toFixed"](...)`) sites for all three
formatters. The helper converts i32→f64 directly and routes externref/ref
through `coerceType(..., f64)`, which funnels through `__unbox_number`
(ToNumber) and throws TypeError on Symbol.

## Test Results

`tests/issue-1564.test.ts` — 26/26 pass (ToNumber via Number/new Number/unary
ops/arithmetic/relational/update operators + the three formatters; plus
regression guards confirming numeric/boolean args still coerce correctly).

test262 (JS-host mode):
- `Number/prototype/toFixed/toFixed-tonumber-throws-typeerror-symbol.js` → PASS
- `Number/prototype/toPrecision/return-abrupt-tointeger-precision-symbol.js` → PASS

Two remaining `built-ins/Number/` Symbol tests
(`return-abrupt-tonumber-value-symbol.js`,
`toExponential/return-abrupt-tointeger-fractiondigits-symbol.js`) still fail in
untyped JS-host mode: an untyped `Symbol("x")` local is not represented as an
externref there, so the formatter arg takes the i32 path and the value is
treated numerically rather than throwing. That is a separate JS-mode Symbol
*representation* gap (not the formatter ToNumber funnel) — tracked for a
follow-up. The pre-existing failures in `tests/issue-866.test.ts` and
`tests/comparison-coercion.test.ts` are present on `origin/main` and unrelated.
