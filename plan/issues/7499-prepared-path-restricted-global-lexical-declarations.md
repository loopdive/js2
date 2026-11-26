---
id: 7499
title: "Prepared path accepts lexical declarations of NaN / Infinity / undefined that must throw"
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
related: [7488, 7354]
---

# Prepared path accepts lexical declarations of NaN / Infinity / undefined

## Problem

A Script that declares a lexical binding named `NaN`, `Infinity` or `undefined` must fail at
GlobalDeclarationInstantiation (§16.1.7: `HasRestrictedGlobalProperty` is true for these non-configurable
properties of the global object, so the Script throws a SyntaxError before any statement runs). On the Prepared
whole-program path (`wholeProgram: {kind: "prepared-program-required", version: 1}`) these programs compile and run
normally. Found by the plan review of #7488 (PRV-7488), 2026-11-26.

## Repro (PR 7440 head `3d70c9c8`, main `c3b7be66` + #7446; standalone; node via `vm.runInNewContext`)

| Program | node | Prepared |
| --- | --- | --- |
| `class NaN {}` | throws SyntaxError | **returns** |
| `let NaN = 1;` | throws SyntaxError | **returns** |
| `class undefined {}` | throws SyntaxError | **returns** |
| `class Infinity {}` | throws SyntaxError | **returns** |

## Acceptance criteria

- Each program above throws a SyntaxError at start, or is refused by name at compile time; never runs.
- `var NaN` in sloppy mode keeps its current, correct behaviour; the restriction is for lexical declarations.
- The ordinary pipeline's output is unchanged.

## Notes

- The dead-binding elision already treats these names specially (`GLOBAL_CONSTANTS` in `src/deadcode-elide.ts`:
  "`let undefined` is a SyntaxError of GlobalDeclarationInstantiation"). Look for where the Prepared front end
  checks GlobalDeclarationInstantiation early errors before adding a new check.

## Implementation Plan

Written 2026-11-26, stacked on PR 7469 (#7500, head `995f3679`), whose `sourceOwner` and select-refusal module this
uses.

### Which pipeline, and what kind of error (measured)

- **Ordinary pipeline: already correct.** `noteRestrictedGlobalLexicalName` (`src/codegen/declarations.ts`) records
  the first top-level lexical name that is `undefined`, `NaN` or `Infinity` in a Script (a source without
  `externalModuleIndicator`), and `module-init-prologue.ts` makes `throw SyntaxError` the first instruction of
  `__module_init`. It is a runtime SyntaxError at GlobalDeclarationInstantiation, not a compile-time early error
  (test262 marks it `negative: phase: runtime`). Its name test is an inline copy of `GLOBAL_CONSTANTS`
  (`src/shared/ambient-intrinsics.ts`).
- **Prepared path: wrong.** On `995f3679` (standalone, Script goal):

  | Program | Prepared | node |
  | --- | --- | --- |
  | `let NaN = 1;`, `class NaN {}`, `const Infinity = 0;`, `class undefined {}` | **returns** | SyntaxError |
  | `let undefined;`, `let x; let NaN;` | refused (`Phase 1 requires an initializer`) | SyntaxError |
  | `var NaN;` (not lexical: no error in node either, sloppy) | refused (no typed storage) | returns |

### Decision: refuse at select on the Prepared path, sharing one predicate with the ordinary pipeline

- **Shared predicate** in `src/shared/ambient-intrinsics.ts`, next to `GLOBAL_CONSTANTS`:
  `isRestrictedGlobalLexical(sourceFile, name)`: a Script source (no `externalModuleIndicator`) and a name in
  `GLOBAL_CONSTANTS`. `noteRestrictedGlobalLexicalName` calls it instead of its inline test, so ordinary output is
  unchanged (same condition), and the two pipelines cannot disagree. (Coordinated with S17 / #7439 so there is one
  predicate for "restricted global name".)
- **Prepared rule** in `src/ir/prepared-select-refusals.ts`: the first top-level `let`/`const` declaration or class
  declaration of a source whose name satisfies the predicate is refused, code `restricted-global-lexical`, stage
  `select`, detail "`let NaN` in a Script is a SyntaxError at instantiation, which the Prepared path does not raise".
  Located at the declaration name through `sourceOwner` (#7500): GlobalDeclarationInstantiation is no unit's code.
  It runs before the class rules, matching the spec, where instantiation precedes every evaluation.
- **Why a refusal, not the SyntaxError:** the Prepared path can lower `throw new SyntaxError(…)` (probed: it throws),
  but raising it at instantiation means prepending a synthetic throw to `<module-init>` ahead of its population, a
  lowering arm of its own. The only test262 file with this shape (below) is a negative test that the harness prelude
  already stops on the Prepared path, so the throw would gain nothing measurable today. The refusal makes the path
  sound now; lowering the throw can follow when the prelude compiles.

### Acceptance

- Correctness: the six lexical programs above are refused by name (`restricted-global-lexical`) under both
  `unlowerableBodies` policies; `var NaN;` and a Module-goal `let NaN` are not refused by this rule; a non-restricted
  `let x = 1` is unchanged.
- Ordinary pipeline byte-identical on a sample × (default, standalone), and `decl-lex-restricted-global.js` keeps its
  ordinary verdict.
- Code quality: one predicate for restricted global lexical names (the inline copy in `declarations.ts` removed); the
  rule sits in the one select-refusal module; no new owner concept.

### Yield (measured)

None. The only test262 file with a top-level restricted lexical in a Script is
`language/global-code/decl-lex-restricted-global.js` (`let undefined;`, `negative: phase: runtime`), refused on the
Prepared path both before (`Phase 1 requires an initializer`) and after (`restricted-global-lexical`). Soundness fix.
