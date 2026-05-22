---
id: 779a
title: "class/dstr method-tramp residual (gen / async-gen / private / static) (~727 fails)"
status: ready
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: property-model
parent: 779
es_edition: ES2017
language_feature: class-destructuring-methods
test262_fail: 727
created: 2026-05-21
---

# #779a — class/dstr method-tramp residual

## Problem

~727 test262 `assertion_fail` failures under
`language/{statements,expressions}/class/dstr/*` whose filename prefix is one of:

- `gen-meth-*` (~120) — generator instance methods with destructuring params
- `gen-meth-static-*` (~81) — generator static methods with destructuring params
- `gen-meth-dflt-*` (~39) — generator instance methods with default-init dstr
- `async-gen-meth-*` (~125) — async-gen methods with destructuring params
  (the `dflt-*-init-unresolvable` subset is already routed to #820d)
- `private-meth-*` and `private-gen-meth-*` (~86 + 86) — private (gen) methods
- `async-private-gen-meth-*` (~86) — private async-gen methods
- `meth-static-*`, `meth-dflt-*`, `meth-ary-*`, `meth-obj-*` (~109) —
  plain class-method dstr residuals after #1543/#1544 landed

All produce `returned 2 — assert #1` (first assertion fails) without
crashing. The class method runs, but the destructuring of parameters does
not bind the expected values.

This is the residual umbrella covering class-method dstr cases that are
neither the parsing bug routed to #779b nor the `unresolvable` illegal-cast
routed to #820d, nor the null-deref subset routed to #820c/#820e.

## Sample failing tests
- `test/language/expressions/class/dstr/gen-meth-dflt-ary-ptrn-empty.js`
- `test/language/statements/class/dstr/private-gen-meth-static-ary-ptrn-elem-ary-rest-init.js`
- `test/language/expressions/class/dstr/meth-static-dflt-ary-ptrn-rest-id.js`
- `test/language/statements/class/dstr/async-private-gen-meth-dflt-ary-ptrn-rest-id-elision.js`

## Suspected source

Class-method body emission shares a destructuring path through the
object-method trampoline builder. The candidates are:

- `src/codegen/closures.ts` — `__obj_meth_tramp_*` builder (around L3019/L3085
  per #820c/#820d notes) — does not propagate the binding-pattern
  parameter resolution for generator/async-gen wrapped shells.
- `src/codegen/destructuring-params.ts` — binding-element default-init
  closure typing; routing in decl-mode (referenced by #1553d).
- `src/codegen/literals.ts` — binding-element pattern emission inside
  class-method method-definition.

Likely root cause: the binding-element lowering used for class-method
formal parameters takes a different path than the function-decl path that
#1543/#1544 fixed. The class-method path needs the same destructuring
helper applied through the (async-)generator shell.

## Spec reference

- ECMAScript §15.7 ClassDefinitions (ClassElementEvaluation,
  DefineMethod, DefineMethodProperty)
- §14.1.18 IteratorBindingInitialization (binding-element default)
- §27.6 AsyncGenerator Abstract Operations (wrapper shell)

## Acceptance criteria

- [ ] At least 600 of the ~727 listed tests flip to `pass`.
- [ ] No regression in already-passing `class/dstr` tests.
- [ ] Implementation routes class-method binding-pattern params through the
      same path as `destructureParamArray` / `destructureParamObject`.
- [ ] Fix covers all four shell variants: plain method, generator method,
      async method, async-gen method, both instance and static, both public
      and private.

## Notes

- This is a parent-of-parents for several already-filed narrower issues:
  #1543 (closed), #1544 (closed), #1553x (in flight), #820d. The remaining
  727 are the tests that none of those cover.
- Coordinate dispatch with #1553x to avoid duplicate diagnosis.
- High-volume; consider splitting further if dev finds the gen / async-gen /
  private paths diverge significantly during implementation.
