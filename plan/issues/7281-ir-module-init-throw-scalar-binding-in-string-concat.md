---
id: 7281
title: "IR module-init: throw new X('…' + x) where x is a scalar module binding"
status: done
completed: 2026-11-06
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
  # 2026-11-06 (#7281): src/ir/select.ts +16 — two small selector predicates
  # beside their siblings: `throwValueReadsUnboxedModuleScalar` (+11 incl. doc) next to
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

- `isPhase1ThrowStatement` calls a new `throwValueReadsUnboxedModuleScalar(expr)`,
  which keeps the old test (`expressionTouchesScalarModuleBinding` and family
  not string) but, for a `new`, applies it to each argument instead of to the
  object (the callee is always a class/constructor name — `phase1NewExpression`
  admits nothing else). `throw new X(x)` (scalar argument) and `throw x`
  stay refused.
- The `isPhase1Expr` module-value guard exempts `isModuleStringConcat(expr)`:
  a `+` whose `obviousModuleValueFamily` is string. Boolean module operands are
  still refused by the next guard (`expr-module-boolean-nonboolean-op`); an
  extern or nullish operand never proves a string family, so it is unaffected.

Quality criterion: both changes extend the existing refusal in place; no new
lowering arm, no duplicated predicate.

## Validation (2026-11-06, base = main 8b349439)

- Wrapped stride-40 standalone ledger A/B: zero-legacy 32 → 34 (the two f64
  files above), compileOk 1118/1118, invariants 0/0, no other file's legacy
  units changed.
- Playground examples (13 files) × gc / standalone / wasi: byte-identical.
- Standalone test262 A/B, 652 files (all 454 of `compound-assignment`, the 6
  targets, 200 seeded-random): identical status and message on every row
  (554 pass / 73 fail / 24 CE / 1 skip on both).
- Probes (`-0`, `NaN`, `0.5`, `1e21`, compound-assigned, nested and
  number-first concats, right-hand concat, a throw inside a function,
  `new Error('' + x)`, string and boolean bindings, `throw new X(x)`,
  `throw x`): identical results base vs head on gc, standalone and wasi.
- `tests/issue-7281-throw-scalar-concat.test.ts`: 13 cases, standalone + gc.

## Adversarial review (fresh context, 2026-11-06)

Verdict: quality goal met, no blocking findings; soundness (a) the `+`
exemption admits only a proven string `+` over an f64 module scalar — boolean
is still refused by the next guard, extern/nullish/dynamic never prove a string
family; (b) spread and nested `new` arguments stay refused.

| # | finding | resolution |
| --- | --- | --- |
| 1 (should-fix) | no test covered the `+` exemption outside a throw | added module-init and function-body concat cases (IR, correct value) and a boolean-binding concat (stays refused) |
| 2 (nit) | `isModuleStringConcat` is a one-caller wrapper; comment unclear | comment rewritten; helper kept — inlining it grows `isPhase1Expr`, which sits at its function budget |
| 3 (nit) | the callee recursion is unreachable; name overstates | dropped the callee; renamed to `throwValueReadsUnboxedModuleScalar` |
