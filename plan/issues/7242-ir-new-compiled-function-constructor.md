---
id: 7242
title: "IR: `new F(args)` of a compiled top-level function constructor (e.g. harness `Test262Error`) demotes the whole body"
status: ready
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7106, 7240, 7241, 3123, 2949, 4502]
assignee: "ttraenkler/c-lead"
---

# #7242: IR cannot construct a compiled function constructor

## Problem

When an IR body contains `new F(...)` and `F` is a top-level `function`
declaration (not a class) compiled by legacy, the selector claims the body,
but `ir/from-ast` cannot build the expression. It demotes the body with
`unknown-class-construction` (`src/ir/from-ast.ts` ~L8506:
`unknown class "F" in <fn>`), and the body falls back to legacy.

In test262 the main case is `throw new Test262Error(msg)`. In the authoritative
lanes `Test262Error` is a harness function constructor from `sta.js`, so every
test262 file carries it.

Measurements, from the harness-wrapped ledger (`--wrapped`, #7240, standalone)
and the #6583 claim notice 6655440988:
- 35 `extends Iterator` class members whose body is `throw new Test262Error()`
  are claimed and then demoted for exactly this reason.
- Elsewhere in the wrapped ledger, `unknown class "Test262Error" in assert`
  appears ×22, and harness functions show more rows of the same kind.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Measure and attribute first.**
   - Count every `unknown-class-construction` demotion on the wrapped ledger at
     stride 40, standalone, by constructor name and by unit origin
     (harness/test). Use `JS2WASM_IR_SHAPE_DIAG=1` or a throwaway counter at
     the demotion site; do not commit it.
   - Check why the selector claims `new F()` when the builder cannot build it.
     Selector and builder must agree. If the selector has an arm that admits
     `new <top-level function>`, the fix belongs behind exactly that arm.
2. **Find legacy's construct path for a function constructor.**
   - Locate it: `compileNewExpression` in `src/codegen/expressions/new-super.ts`
     and the fnctor machinery (#3123). Record which function legacy calls,
     how `this` is allocated (object runtime / `$Object` / externref), what
     the result type is, and how a non-object return value is handled
     (`return 5` is ignored and `this` is used; returning an object replaces
     `this`).
   - Write the finding into this file before coding.
3. **Lower `new F(args)` in IR by calling legacy's existing construct entry**
   through the existing IR→legacy call ABI, the same symbolic function-ref
   mechanism IR already uses to call legacy-compiled functions. Do not inline
   or re-implement construction. Keep these exactly as legacy does them: the
   arguments' representation (externref / boxing), arity padding, and the
   result's representation (the value the IR expression produces).
   - In scope: `F` is a top-level `function` declaration in the same
     compilation unit, legacy compiles it as a constructor-capable function,
     and it is not reassigned anywhere (no writes to `F`).
   - Out of scope: dynamic callees, `new` of a parameter or value, builtin
     error constructors (`error-constructor-unsupported`), classes (already
     handled), `new.target`-observing constructors unless legacy's entry
     already threads it, and the harness function bodies themselves (#7106).
4. **Do not touch** `dynamicUsesAreMoveOnly`, the async/generator lanes, or the
   Shepherd's getter-callable files: `class-bodies.ts`,
   `closures/method-trampolines.ts`, `program-abi-class-callable-planning.ts`,
   `method-receiver-this.ts`, `property-access-exact-shapes.ts`.
5. **Never worse than legacy.** Every newly IR-claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probe:
   - `throw new F(msg)` caught and inspected: `instanceof F`, `.message`,
     `.constructor`, `String(e)`;
   - `new F()` used as a value;
   - F returning an object vs. a primitive;
   - F reading `new.target` or `this`;
   - F called both with and without `new` in one program;
   - a subclass of F, if legacy supports it (#3123);
   - exceptions thrown inside F.

## Acceptance criteria

- Wrapped ledger A/B (stride 40, standalone) in the PR body: IR units rise,
  `unknown-class-construction` falls, 0 invariants, `compileOk` not lower.
  Report the raw-mode A/B too.
- Typed corpus is byte-identical on gc, standalone and wasi, or every changed
  binary is explained.
- test262 A/B on the route-changed files plus a sample: no test that passes on
  base fails on head (standalone).
- Test: `tests/equivalence/issue-7242-ir-new-compiled-function-constructor.test.ts`.
  It asserts the IR route (`trackIrOutcomes`) and the node/base result on all 3
  lanes, including the `throw new F()` / `instanceof` case.
