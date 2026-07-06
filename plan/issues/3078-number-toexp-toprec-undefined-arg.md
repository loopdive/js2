---
id: 3078
title: "Number.prototype.toExponential(undefined) / toPrecision(undefined) must behave as no-arg, not ToInteger(undefined)=0"
status: done
completed: 2026-07-07
assignee: ttraenkler/dev-B
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: number-builtins
goal: conformance
related: [1735, 1321, 49]
---

# #3078 — `toExponential(undefined)` / `toPrecision(undefined)` ≡ no-arg

## Problem

Per ECMA-262, an explicit `undefined` fractionDigits/precision is spec-equivalent
to omitting the argument:

- §21.1.3.3 `toExponential(undefined)` → variable-precision exponential (as many
  digits as needed), same as `toExponential()`. e.g. `(123.456).toExponential(undefined)`
  === `"1.23456e+2"`.
- §21.1.3.5 step 2 `toPrecision(undefined)` → `! ToString(x)`, same as
  `toPrecision()`. e.g. `(39).toPrecision(undefined)` === `"39"`.

Pre-fix, codegen gated only on `arguments.length > 0`, so an explicit `undefined`
compiled through the ToNumber funnel → f64 NaN → normaliseNaN→0. Result:
`toExponential(undefined)` returned `"1e+2"` (0 digits) and `toPrecision(undefined)`
**threw RangeError** (0 ∉ [1,100]).

## Root cause + fix

`undefined` and `NaN` both compile to f64 NaN and are indistinguishable at the
value site — and they must differ (`toExponential(NaN)` → 0 digits via
ToIntegerOrInfinity; `toExponential(undefined)` → variable). So the fix detects
the **static** `undefined` literal at the AST level (`isStaticUndefinedArg`,
exported from `string-ops.ts`) and routes it to the existing no-argument branch
(NaN "no-arg" sentinel for `number_toExponential` / ToString path for
`number_toPrecision`). Applied to **both** the typed-receiver path and the
computed-member (`n["toExponential"](undefined)`) path in
`src/codegen/expressions/calls.ts`. `toFixed` is deliberately unchanged
(§21.1.3.3: `toFixed(undefined)` IS ToInteger(undefined)=0).

An explicit `NaN` argument still maps to 0 (regression-guarded) because
`isStaticUndefinedArg` matches only the `undefined` / `void 0` literal.

## Acceptance

- [x] `built-ins/Number/prototype/toExponential/undefined-fractiondigits.js` passes.
- [x] `built-ins/Number/prototype/toPrecision/undefined-precision-arg.js` passes.
- [x] No regression: `(123.456).toExponential(NaN)` → `"1e+2"`;
      `(1.5).toPrecision(NaN)` still throws; no-arg + numeric-arg unchanged
      (tests/issue-1735, issue-1321, issue-49 green).
- [x] Unit coverage: `tests/issue-3078-number-undefined-arg.test.ts` (8 cases).

## Notes

Only the STATIC `undefined` literal is routed to no-arg; a dynamically-`undefined`
value stays on the current (NaN→0) path — vanishingly rare and not covered by the
target tests. The sibling `tointeger-fractiondigits` / `tointeger-precision`
failures are a SEPARATE pre-existing gap (ToNumber of boolean/array args, e.g.
`toPrecision(true)` / `toPrecision([2])`), out of scope here.
