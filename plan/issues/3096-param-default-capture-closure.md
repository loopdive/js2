---
id: 3096
title: "Free variables referenced only in a parameter-default initializer are not captured by arrow/function-expression closures"
status: done
sprint: current
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen
language_feature: destructuring, default-parameters, closures
es_edition: 6
goal: spec-completeness
created: 2026-07-08
completed: 2026-07-08
related: [1161]
---

## Problem

An arrow function / function expression that references an enclosing-scope
variable **only** inside a parameter default initializer failed to capture that
variable. The closure capture analysis in `compileArrowAsClosure` (and the
callback-closure path) scanned only the function **body** for free variables —
never the parameter defaults — so the default compiled against a missing
capture and lowered to `ref.null extern`.

For a destructuring parameter this then threw at runtime:

```js
var iter = [7];
var f = function ([x] = iter) { return x; };
f();   // TypeError: Cannot destructure 'null' or 'undefined'
```

The default `= iter` should have supplied the value when the argument is
omitted, but `iter` (referenced nowhere in the body) was not captured, so it
read as `null` and the array-destructure null-guard threw. Simple (non-pattern)
parameters had the same root defect but degraded silently to a wrong value
(`null`/`NaN`) instead of throwing.

This surfaced as the test262 `assertion_fail`/`runtime_error` signature
`Cannot destructure 'null' or 'undefined'` across the `dstr` families
(`dflt-*`, `ary-ptrn-elem-ary-empty-init`, …).

## Root cause

`src/codegen/closures.ts` — both closure capture-analysis sites built
`referencedNames` by walking only the closure `body`:

```ts
collectReferencedIdentifiers(body, referencedNames, ownLocals);
```

Parameter default initializers (`param.initializer`) and binding-pattern
element defaults / computed keys (inside `param.name`) were never scanned, so
their free variables were absent from the capture set.

## Fix

Added a shared helper `collectParamDefaultReferences(parameters, names,
shadowed)` that scans, per parameter, both `param.name` (binding-pattern element
defaults + computed keys) and `param.initializer` (top-level default), using the
function's own-locals as the shadow set so the parameters' own binding names
stay excluded. Called it right after the body scan at both closure sites
(`compileArrowAsClosure` and the callback-closure path).

Scope is intentionally limited to arrow functions and function expressions.
Function **declarations**, object/class **methods**, **generators**, and
`for-of` destructuring have their own separate capture analyses that share the
same underlying gap and are left for a follow-up (they need capture-**set**
builder changes, not just a predicate tweak).

## Validation

- 18 test262 files (`language/expressions/function/dstr/*`,
  `language/expressions/arrow-function/dstr/*` with the destructure-null
  signature) flip pass.
- 40 currently-passing `expressions/{function,arrow-function}` +
  `statements/function` files still pass (no regression).
- Edge cases verified: nested element defaults `([x = outer]) => x`, later
  param referencing earlier param `(a, b = a) => b` (correctly NOT captured),
  default not fired when arg present, object-pattern default capture.
- The two pre-existing failing vitest suites
  (`null-destructure-param-object`, `issue-1712-capture-closure-dispatch`)
  fail identically on the unmodified base.
