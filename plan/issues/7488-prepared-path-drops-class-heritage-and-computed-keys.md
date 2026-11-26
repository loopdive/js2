---
id: 7488
title: "Prepared path drops an unreferenced top-level class's extends expression and computed field keys"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
goal: backend-agnostic-ir
related: [7446, 7354]
---

# Prepared path drops a class's `extends` expression and computed field keys

## Problem

On the Prepared whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`), `<module-init>`
lowers `collectModuleInitPopulation`, which excludes class declarations. A top-level class that nothing references and
that has no member the path refuses (methods, constructors and accessors have no body producer and refuse) compiles
with its ClassDefinitionEvaluation missing. Two parts of that evaluation run code and are dropped:

- the `extends` expression (`class C extends g() {}`, `class C extends 5 {}` must throw a TypeError);
- computed keys of fields (`static [f()];`, `[f()];`), evaluated at definition time.

Static blocks and static field initializers had the same defect; #7446 refuses them through the inventory's existing
`static-class-initialization` failure. Found while fixing #7446.

## Probes (main `c3b7be66`, against node)

| Program | node | Prepared |
| --- | --- | --- |
| `class C extends 5 {}` | throws | **returns** |
| `var n=0; function B(){} function g(){ n=1; return B; } class C extends g() {} if (n !== 1) throw 0;` | returns | **throws** |
| `var n=0; class C { static [(n=1, 'x')]; } if (n !== 1) throw 0;` | returns | **throws** |
| `var n=0; class C { [(n=1, 'x')]; } if (n !== 1) throw 0;` | returns | **throws** |
| computed key on a method | returns | refused (no body producer) |

## Measured test262 impact (main `c3b7be66`, `prepared-census --harness real`)

Of the 786 files with a top-level class with heritage and the 172 with a computed key, none gives a wrong value today:
6 heritage-only files trap in an abort body, and 1 passes by accident
(`language/statements/class/subclass/builtin-objects/Symbol/symbol-valid-as-extends-value.js`: the dropped
`extends Symbol` has no effect). Soundness debt, not yield.

## Acceptance criteria

- A top-level class whose definition evaluates an `extends` expression or a computed key is either lowered with
  JavaScript's semantics or refused by name at compile time, never compiled with the evaluation missing.
- The probes above agree with node or are refused.
- Ordinary-pipeline output unchanged.

## Notes

- The inventory (`src/ir/identity.ts`, `processClass`) records only static initialization as `<module-init>`'s
  `directFailure`; widening that flag changes the ordinary pipeline's module-init outcome, so a Prepared-only refusal
  (or a separate inventory record) is the likely shape.
