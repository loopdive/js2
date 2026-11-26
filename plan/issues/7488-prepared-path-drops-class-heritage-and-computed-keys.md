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
   exported function `classDefinitionExpressions(node)` in a new module `src/ir/class-definition-expressions.ts`. It
   returns tagged entries `{ kind: "decorator" | "extends" | "implements" | "computed-key", expression }` in exactly
   today's order: class decorators, every heritage clause's types, then per member its decorators, its parameter
   decorators, its computed key. `processClass` scans every entry's expression as today, so the ordinary inventory is
   unchanged. `implements` is kept in the list because the inventory scans those identifiers today; only the Prepared
   rule ignores it.
2. **Prepared rule.** A new module `src/ir/prepared-select-refusals.ts` owns the select-stage refusals the Prepared
   producer applies before any body is lowered, as one function returning the program's refusal or `undefined`:
   - the inventory's `directFailure` (moved here from the three lines #7446 added to `prepareIrProgramSources`);
   - a top-level class definition that evaluates code: a source file's direct `ClassDeclaration` statement (the same
     condition under which `processClass` runs with `topLevelDeclaration = true`), not `declare`, with an entry that
     is a decorator, an `extends` expression, or a computed key whose expression is not a literal (string, numeric or
     no-substitution template: these evaluate nothing, and `['x']`, `static [1]`, `` [`x`] `` give the right answer
     today). `implements` evaluates nothing and is ignored. New `IrUnsupportedCode` `class-definition-evaluation`,
     stage `select`, detail naming the class and the first entry's kind.
   `prepareIrProgramSources` calls it once, where #7446's check stands now (right after the identity context). Net
   change in `program-source.ts`: about zero lines.
3. **Owner, without widening `preparedIrProgramOwner`.** The refusal is located at the class's constructor unit: the
   one unit with `lexicalOwnerId === classId` and kind `class-constructor` or `class-implicit-constructor` (every
   non-`declare` class has exactly one; `declare` classes are skipped above). It is terminal when the class has an
   explicit constructor or instance initializers, otherwise a root support unit, and a file whose only code is the
   class (`class C extends 5 {}`) has no terminal unit at all. `src/ir/program/owner.ts` is split along its two
   existing steps, with no change in behaviour:
   - `unitOwner(inventory, record)`: a unit record and its source as a `PreparedIrProgramOwner`. This is the second
     half of `preparedIrProgramOwner`, which keeps its terminal-owner lookup and calls it.
   - `failureAt(owner, failure)`: the failure shaping. This is the second half of `locatedFailure`, which keeps its
     "cannot locate" guard and calls it.
   The new rule calls `failureAt(unitOwner(inventory, constructorUnit), failure)`. The "cannot locate" guard and the
   monomorphization-owner guard (`program-middleend-ir.ts:91`) are untouched.

### Reuse and quality

- Reuses: the inventory's expression list (moved, not copied), the owner and failure shaping in `owner.ts` (split,
  not copied), the #7446 refusal point.
- Removes: the inline list-building in `processClass` becomes a call; the #7446 lines in `program-source.ts` move into
  the new module next to the new rule, so the producer has one call for its select-stage refusals.
- Quality acceptance: one list of definition-time expressions in the codebase; one module for Prepared select-stage
  refusals; no owner guard weakened; no new branch in from-ast; `program-source.ts` does not grow; no filter by
  failure code.

### Correctness acceptance

- Each probe agrees with node or is refused by name (`class-definition-evaluation`), under both `unlowerableBodies`
  policies: `class C extends 5 {}` alone (no `<module-init>`), `extends g()`, `extends (n=7, Object)`,
  `extends (n=7, null)`, `extends Symbol`, `static [f()];`, `[f()];`, a computed method key, a decorated class, and a
  default-exported class with `extends`.
- Unchanged (not refused by this rule): `class C {}`, `class C { static x; }`, literal computed keys (`['x']`,
  `static [1]`, `` [`x`] ``), `class C implements I {}` (.ts), `declare class B {} declare class C extends B {}` (.ts).
  `class C { m() {} }` unreferenced stays refused as before (no body producer).
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

The after-state is derived: the refusal runs before any other producer step, so every compiled row whose class
evaluates code becomes a `class-definition-evaluation` refusal. None of the 13 compiled rows relies only on a literal
computed key. It is re-measured on the implementation. Because the rule runs first, many of the 909 rows refused today
change their first refusal label to the new code; the PR reports a before/after label histogram, not only verdicts.

- **fail → refusal: 6** (`annexB/built-ins/RegExp/legacy-accessors/*/this-subclass-constructor.js`): abort traps
  today, not wrong values.
- **pass → refusal: 7, all accidental.** In each one the code the path drops would run user code or could throw, and
  the test passes only because it never looks:
  - six `language/statements/class/decorator/syntax/valid/decorator-*-identifier-reference*.js`: `@$() class C {}`
    must call `decorator()` at definition, and the path never calls it;
  - `language/statements/class/subclass/builtin-objects/Symbol/symbol-valid-as-extends-value.js`: `extends Symbol`
    is never evaluated.
  None is ES5 or in a completed edition. This needs the lead's sign-off, as for #7446's 7. PRV-7488 confirmed all 7
  are accidental, and the only sound skips it found are literal computed keys (adopted above); `extends Object` and
  `extends Symbol` are rightly refused.
- No wrong value on test262 today, because these files hit other refusals first. The probes in the table above are
  the soundness evidence.

### Out of scope (found by PRV-7488, for separate issues)

- `class NaN {}` and `let NaN` return where node throws SyntaxError.
- A plain `export class C {}` crashes today ("alias … targets unplanned binding").
