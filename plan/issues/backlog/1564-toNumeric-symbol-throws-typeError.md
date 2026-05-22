---
id: 1564
title: "ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3)"
status: ready
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
goal: spec-completeness
es_edition: ES2015
language_feature: type-conversion
test262_fail: 12
created: 2026-05-21
---

# ToNumeric: Symbol argument must throw TypeError

## Problem

`Number(Symbol('x'))` and other ToNumeric conversion paths currently silently produce NaN when passed a Symbol. Per §7.1.3 ToNumeric step 3, when the result of ToPrimitive on a Symbol is itself a Symbol (because Symbols have no numeric coercion), the abstract operation must throw a TypeError.

## Spec

ECMAScript §7.1.3 ToNumeric: "If Type(value) is Symbol, throw a TypeError exception."

## Fix

Add a Symbol-type guard in `src/codegen/type-coercion.ts` in the `compileToNumeric` function (or equivalent) before the numeric conversion path. ~2 lines.

## Acceptance criteria

- [ ] `try { Number(Symbol()); return 'no-throw' } catch(e) { return e instanceof TypeError ? 'TypeError' : 'other' }` returns `'TypeError'`
- [ ] +~12 test262 passes in `built-ins/Number/`
- [ ] No regressions on numeric-coercion paths that don't involve Symbol
