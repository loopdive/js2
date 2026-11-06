---
id: 7281
title: "IR module-init: throw new X('…' + x) where x is a scalar module binding"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7240, 7249, 7251, 7266]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-06 (#7281): src/ir/select.ts +18 — two small selector predicates
  # beside their siblings: `mayYieldUnboxedModuleScalar` (+13 incl. doc) next to
  # `isPhase1ThrowStatement`, its only caller, and `isModuleStringConcat` (+5)
  # next to `obviousModuleValueFamily`, whose result it reads. Both extend the
  # existing refusals in place; neither is a new arm, so there is nothing to
  # split out of select.ts.
  - src/ir/select.ts
---

# #7281 — IR module-init: `throw new X('…' + x)` with a scalar module binding

## Problem

Test262 assertion messages of the shape

```js
var x = 1;
x <<= 1;
if (x !== 2) { throw new Test262Error('#1: … Actual: ' + (x)); }
```

keep the test's `<module-init>` on the legacy compiler. Two selector refusals
fire in turn:

1. `isPhase1ThrowStatement` refuses `throw-module-scalar-unboxed` when the
   thrown expression *touches* an f64/boolean module binding and the whole
   expression's family is not string. The thrown value here is a `new`
   expression (an object); the binding is only read inside the argument, a
   string concat.
2. With that lifted, `isPhase1Expr`'s module-value guard refuses the concat
   `'…' + x` as `expr-module-value-representation-mismatch` (string family
   beside f64 family), although a string `+` is exactly the operator that
   combines those families (ToString of the number side).

## Measurement (step 1)

Wrapped stride-40 standalone ledger on main, per-file rows: 6 files whose only
legacy unit is the test `<module-init>` with first refusal
`throw-module-scalar-unboxed`. Probing each one past the refusal:

| file | binding | next refusal after this change |
| --- | --- | --- |
| `unsigned-right-shift/S11.7.3_A2.4_T1.js` | f64 | none — IR |
| `line-terminators/between-tokens-cr.js` | f64 | none — IR |
| `compound-assignment/S11.13.2_A3.1_T6.js` | `y` dynamic (`var y;`) | still `throw-module-scalar-unboxed` (#2 uses `y`) |
| `compound-assignment/S11.13.2_A4.7_T1.2.js` | dynamic (`x = new Number(1)`) | same |
| `compound-assignment/S11.13.2_A4.4_T1.1.js` | dynamic (`new Boolean`) | same |
| `compound-assignment/S11.13.2_A4.11_T2.9.js` | dynamic | same |

The four dynamic-binding files are out of scope: admitting their concat (a
throwaway probe) only moves them to unrelated refusals —
`constructor-resolution-unsupported` (`new Number` / `new Boolean`) and
`compound assign <<= to "y" (dynamic)` in from-ast. Expected zero-legacy delta:
**+2**.

## Implementation Plan

Module: `src/ir/select.ts` only. No from-ast change: `new X(<string>)` and a
string `+` over an f64 read already lower; only the selector refused them.

- `isPhase1ThrowStatement` calls a new `mayYieldUnboxedModuleScalar(expr)`,
  which keeps the old test (`expressionTouchesScalarModuleBinding` and family
  not string) but, for a `new`, applies it to the callee and each argument
  instead of to the object. `throw new X(x)` (scalar argument) and `throw x`
  stay refused.
- The `isPhase1Expr` module-value guard exempts `isModuleStringConcat(expr)`:
  a `+` whose `obviousModuleValueFamily` is string. Boolean module operands are
  still refused by the next guard (`expr-module-boolean-nonboolean-op`); an
  extern or nullish operand never proves a string family, so it is unaffected.

Quality criterion: both changes extend the existing refusal in place; no new
lowering arm, no duplicated predicate.

## Validation

See the PR body for the numbers (ledger A/B, typed corpus, test262 A/B,
probes, gates).
