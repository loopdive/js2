---
id: 1566
title: "ToNumber: Symbol argument must throw TypeError (§7.1.4)"
status: ready
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
goal: spec-completeness
es_edition: ES2015
language_feature: type-conversion
test262_fail: 10
created: 2026-05-21
---

# ToNumber: Symbol argument must throw TypeError

## Problem

`+Symbol('x')` and other ToNumber paths silently produce NaN via the `_toNumber` host import path in `src/runtime.ts`. §7.1.4 ToNumber step "If argument is a Symbol, throw a TypeError" is not implemented.

## Spec

ECMAScript §7.1.4 ToNumber: "If argument is a Symbol, throw a TypeError exception."

## Fix

Add a Symbol-type guard at the start of `_toNumber` in `src/runtime.ts`, OR in `compileToNumber` in `src/codegen/type-coercion.ts` to short-circuit before the host call.

## Acceptance criteria

- [ ] `try { +Symbol(); return 'no-throw' } catch(e) { return e instanceof TypeError ? 'TypeError' : 'other' }` returns `'TypeError'`
- [ ] +~10 test262 passes in `built-ins/Symbol/prototype/{valueOf,toString}` and `language/expressions/unary-plus`
- [ ] No regression on numeric ToNumber paths
