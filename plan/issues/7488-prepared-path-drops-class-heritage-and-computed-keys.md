---
id: 7488
title: "Prepared path drops an unreferenced top-level class's extends expression and computed field keys"
status: in-progress
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
`extends Symbol` has no effect). That holds only because the other files hit unrelated refusals first (e.g.
`extends f()` refuses with "callable annotation … requires one non-constructing call signature"); the defect itself
is confirmed by `class C extends (n=7, Object) {}` and `extends (n=7, null)`, which return normally where node
throws. Soundness debt, not yield.

## Acceptance criteria

- A top-level class whose definition evaluates an `extends` expression or a computed key is either lowered with
  JavaScript's semantics or refused by name at compile time, never compiled with the evaluation missing.
- The probes above agree with node or are refused.
- Ordinary-pipeline output unchanged.

## Notes

- The inventory (`src/ir/identity.ts`, `processClass`) records only static initialization as `<module-init>`'s
  `directFailure`; widening that flag changes the ordinary pipeline's module-init outcome, so a Prepared-only refusal
  (or a separate inventory record) is the likely shape.

## Implementation Plan

Written 2026-11-26, stacked on PR 7440 (head `3d70c9c8`, the #7446 fix), which this change extends. Base main
`c3b7be66`.

### Where the evaluation is lost (measured)

`processClass` (`src/ir/identity.ts`) already collects exactly the expressions ClassDefinitionEvaluation runs:
`definitionExpressions` = class and member decorators, parameter decorators of constructors/methods/accessors, the
`extends` expression, and every computed member key. For a **top-level** class it scans them with no terminal owner
(`scanDefinitionExpressions(null)`): in the ordinary pipeline legacy emits the class definition itself. The Prepared
`<module-init>` lowers `collectModuleInitPopulation`, which excludes class declarations, so nothing runs or refuses
them. A file whose only runtime code is such a class (`class C extends 5 {}`) has **no terminal unit at all**: its
inventory is one root `class-implicit-constructor` support unit.

Classes elsewhere are already sound: inside a function from-ast refuses the `ClassDeclaration` statement (abort body),
in a top-level block likewise, and a class expression is refused by from-ast.

### Decision: refuse at select, Prepared-only

Lowering ClassDefinitionEvaluation is not cheap: the Prepared path has no class binding (`C` is "not in scope"), no
class object and no constructor value. Widening the inventory's `<module-init>` `directFailure` would change the
ordinary pipeline's selection (bytes). So the refusal is the Prepared producer's own, keyed on the inventory's own
list.

1. **Shared list, no duplicate.** Move the `definitionExpressions` construction out of `processClass` into one pure
   exported function `classDefinitionExpressions(node)` in a new module `src/ir/class-definition-expressions.ts`.
   `processClass` calls it (same expressions, same order, so the ordinary inventory is unchanged).
2. **Prepared rule.** A new module `src/ir/prepared-select-refusals.ts` owns the select-stage refusals the Prepared
   producer applies before any body is lowered, as one function returning `{ unitId, failure } | undefined`:
   - the inventory's `directFailure` (moved here from the three lines #7446 added to `prepareIrProgramSources`);
   - a top-level `ClassDeclaration` (a direct statement of a source file, exported or not) with a non-empty
     `classDefinitionExpressions`, refused with a new `IrUnsupportedCode` `class-definition-evaluation`, stage
     `select`, detail naming the class and what it evaluates (`extends` expression, computed key, decorator).
   `prepareIrProgramSources` calls it once, where #7446's check stands now (right after the identity context), and
   returns `locatedFailure(...)`. Net change in `program-source.ts`: about zero lines.
3. **Owner.** The class's constructor unit: the one unit with `lexicalOwnerId === classId` and kind
   `class-constructor` or `class-implicit-constructor` (every non-`declare` class has exactly one). It is terminal when
   the class has an explicit constructor or instance initializers, otherwise a root support unit
   (`terminalOwnerId: null`). `preparedIrProgramOwner` (`src/ir/program/owner.ts`) gains one rule: a unit with no
   terminal owner owns itself (it already carries `line`/`column`/declaration span). No existing caller passes such a
   unit (they pass function units), so their results do not change. The refusal then points at the class, also in a
   file with no `<module-init>`.

### Reuse and quality

- Reuses: the inventory's expression list (moved, not copied), `locatedFailure`/`preparedIrProgramOwner`, the #7446
  refusal point.
- Removes: the inline list-building in `processClass` becomes a call; the #7446 lines in `program-source.ts` move into
  the new module next to the new rule, so the producer has one call for its select-stage refusals.
- Quality acceptance: one list of definition-time expressions in the codebase; one module for Prepared select-stage
  refusals; no new branch in from-ast; `program-source.ts` does not grow; no filter by failure code.

### Correctness acceptance

- Each probe agrees with node or is refused by name (`class-definition-evaluation`), under both `unlowerableBodies`
  policies: `class C extends 5 {}` alone (no `<module-init>`), `extends g()`, `extends (n=7, Object)`,
  `extends (n=7, null)`, `static [f()];`, `[f()];`, computed method key, a decorated class, an exported and a default
  exported class with `extends`.
- Inert classes still compile and run: `class C {}`, `class C { static x; }`, `class C { m() {} }` unreferenced is
  still refused as before (no body producer), unchanged.
- Pin tests fail on the PR 7440 head and pass after.
- Ordinary pipeline: byte-identical on a 100-file sample of the affected test262 files × (default, standalone);
  `check:ir-fallbacks` unchanged; `tests/issue-3519-ir-outcomes.test.ts` green.

### Yield (measured)

Census of the 969 test262 files with a top-level class that has a heritage clause (786), a computed key (192) or a
decorator (11), `scripts/ir-census/prepared-census.mts --harness real` (standalone), before = PR 7440 head `3d70c9c8`
(main `c3b7be66` + #7446), 2026-11-26:

| Prepared verdict | before | after (derived) |
| --- | ---: | ---: |
| pass | 7 | 0 |
| fail | 6 | 0 |
| named refusal | 909 | 922 |
| skip (negative / async) | 47 | 47 |

The after-state is derived: the refusal runs before any other producer step, so every compiled row becomes a
`class-definition-evaluation` refusal. It is re-measured on the implementation.

- **fail → refusal: 6** (`annexB/built-ins/RegExp/legacy-accessors/*/this-subclass-constructor.js`): abort traps
  today, not wrong values.
- **pass → refusal: 7, all accidental.** In each one the code the path drops would run user code or could throw, and
  the test passes only because it never looks:
  - six `language/statements/class/decorator/syntax/valid/decorator-*-identifier-reference*.js`: `@$() class C {}`
    must call `decorator()` at definition, and the path never calls it;
  - `language/statements/class/subclass/builtin-objects/Symbol/symbol-valid-as-extends-value.js`: `extends Symbol`
    is never evaluated.
  None is ES5 or in a completed edition. This needs the lead's sign-off, as for #7446's 7.
- No wrong value on test262 today, because these files hit other refusals first. The probes in the table above are
  the soundness evidence.
