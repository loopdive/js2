---
id: 4460
title: "Static member read off a class EXPRESSION yields null at runtime while typeof/length fold to the function"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: class-expression
goal: standalone-gap
related: [4455, 4440, 3976]
origin: "2026-08-15 ES5-standalone session — #4455 R1, narrowed out of #4440 R1's wrong gOPD grouping. Probe evidence in plan/issues/4455-class-proto-accessor-gopd.md R1."
---

# #4460 — class-expression static member read is null at runtime

## Problem

`var m1 = class { static m(x = 42) {} }.m` — a static member read directly
off a class EXPRESSION value — evaluates to **`null` at runtime**, while
`typeof m1` folds to `"function"` and `m1.length` folds to `0` at compile
time. Probe output, one module (recorded in #4455 R1):

```
typeof=function | ===undefined:false | ===null:true
call THREW TypeError: Cannot access property on null or undefined
hasOwn:false
```

The same class written as a DECLARATION passes:
`class C { static m(x = 42) {} } var m1 = C.m` works —
`language/statements/class/static-method-length-dflt.js` is green while
`language/expressions/class/static-method-length-dflt.js` fails. The
failing test dies on `__getOwnPropertyDescriptor`'s §19.1.2.8 ToObject
guard firing on the null.

**The real bug is the compile-time/runtime disagreement**: the checker
folds `typeof`/`length` from the static type while the value carrier for
the class-expression's static member produces null. The failing test262
row is one symptom; any consumer that passes the value onward (callbacks,
`Function.prototype.call`, gOPD) hits the null.

## Where to look

- Class-expression lowering vs. class-declaration lowering: find where a
  declaration's static members get their carrier (the `__class_<C>` value
  #3976 discusses; `src/codegen/expressions/new-super.ts`
  `emitDynamicNewFallback` `ref.test`s `$ClassName` structs) and diff what
  the EXPRESSION form emits for a member read on the immediate value.
- The fold sites: whatever answers `typeof (class {...}).m` as
  `"function"` and `.length` as `0` at compile time — those folds are
  reading the checker while the runtime read produces null, i.e. the two
  disagree on whether the member exists. Either the runtime carrier must
  produce the function value, or the folds must stop claiming it does.
- #4455's accessor-install machinery (`class-proto-accessors.ts`) is NOT
  involved — R1 explicitly disproved the gOPD grouping.

## Implementation Plan

1. Reproduce with the #4455 R1 probe shape in `.tmp/`:
   `var m1 = class { static m(x = 42) {} }.m; return typeof m1` plus the
   null-identity checks. Confirm declaration form passes, expression form
   nulls. Capture `.tmp/base-*.ts` revert copies at first edit.
2. Read the emitted WAT for both forms; find where the expression form's
   member read lowers (likely a missing arm: the class-expression value is
   not the `$ClassName` carrier the static-member read expects, or the
   read happens before static members are installed).
3. Fix at the emission site so the expression-form read yields the same
   function value the declaration form does.
4. Verify: probe passes both forms;
   `language/expressions/class/static-method-length-dflt.js` flips via
   `.tmp/run-one.mts`; scoped standalone run over
   `language/expressions/class/` for collateral; pins for #4455/#4440
   stay green.

## Acceptance criteria

- Expression-form static member read yields the callable function value
  (call succeeds, `=== null` false).
- `language/expressions/class/static-method-length-dflt.js` passes
  standalone; no regressions in `language/expressions/class/` scoped run.
