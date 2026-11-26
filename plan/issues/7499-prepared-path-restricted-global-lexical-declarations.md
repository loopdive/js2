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
related: [7488, 7519, 7354]
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

Written 2026-11-26, stacked on PR 7469 (#7500, head `9fd3eb18`), whose `ownerAt` / `nodeLocation` and select-refusal
module this uses.

### Which pipeline, and what kind of error (measured)

It is a runtime SyntaxError raised at GlobalDeclarationInstantiation, before any statement runs (test262 marks it
`negative: phase: runtime`), not a compile-time early error. Measured on `995f3679` (the ordinary pipeline compiled
and run, default and standalone; the Prepared path standalone, Script goal):

| Program | ordinary | Prepared | node |
| --- | --- | --- | --- |
| `let NaN = 1;` | throws | **returns** | SyntaxError |
| `class NaN {}`, `class undefined {}` | **returns** | **returns** | SyntaxError |
| `let {a: NaN} = {a:1}`, `let [Infinity] = [1]`, `const {Infinity} = {Infinity:1}` | **returns** | refused (destructuring) | SyntaxError |
| `let undefined;`, `let x; let NaN;` | throws | refused (`Phase 1 requires an initializer`) | SyntaxError |
| `var NaN;` (not lexical) | — | refused (no typed storage) | returns |

- The ordinary pipeline is only partly right: `noteRestrictedGlobalLexicalName` (`src/codegen/declarations.ts`) runs
  only from the identifier arm of a top-level `let`/`const`, so class declarations and binding patterns slip through.
  That is a gc-output change, so it is filed separately as
  [#7519](7519-ordinary-restricted-global-lexical-classes-and-patterns.md) (PRV-7499, lead decision 2026-11-26).
- The Prepared path is wrong for the class forms, and right for the pattern forms only by accident (the destructuring
  producer is missing).

### Decision: one walker, moved to `src/shared`; the predicate and the Prepared rule build on it

- **One walker, moved.** `recordScriptGlobalLexicalBindingNames` (`src/codegen/source-scan-predicates.ts`) already
  walks a Script's top-level lexical declarations: the BoundNames of every top-level `let`/`const` (identifiers and
  nested binding patterns, holes skipped) and the names of class declarations. Its only caller is
  `recordSourceGlobalEnvironment` (`src/codegen/index.ts`). It moves to `src/shared/script-lexical-names.ts` as the
  pure `scriptGlobalLexicalNames(sourceFile): readonly ts.Identifier[]`, in source order. `recordSourceGlobalEnvironment`
  adds each identifier's `.text` to its set, so that caller's output is byte-identical.
- **The predicate on top.** `restrictedGlobalLexicalName(sourceFile): ts.Identifier | undefined`, next to the walker:
  `undefined` for a Module (a source with `externalModuleIndicator`), else
  `scriptGlobalLexicalNames(sourceFile).find((id) => GLOBAL_CONSTANTS.has(id.text))`. It returns the declaring
  identifier, so a caller can locate it without a second walk.
- **Prepared rule** in `src/ir/prepared-select-refusals.ts`, first in the per-source loop (instantiation precedes every
  evaluation): when `restrictedGlobalLexicalName(file)` returns an identifier, refuse with code
  `restricted-global-lexical`, stage `select`, detail "`NaN` is lexically declared in a Script: a SyntaxError at
  instantiation, which the Prepared path does not raise", located at that identifier through the module's existing
  `ownerAt(inventory, null, nodeLocation(sourceId, identifier))` (#7500). GlobalDeclarationInstantiation is no unit's
  code.
- **Ordinary pipeline unchanged in this PR** (byte-identical): `noteRestrictedGlobalLexicalName` stays for now.
  [#7519](7519-ordinary-restricted-global-lexical-classes-and-patterns.md) switches `declarations.ts` to
  `restrictedGlobalLexicalName(sourceFile)?.text`, once per source, and deletes the per-declarator call.
- **Why a refusal, not the SyntaxError, on the Prepared path:** the Prepared path can lower
  `throw new SyntaxError(…)` (probed: it throws), but raising it at instantiation means a synthetic throw ahead of
  `<module-init>`'s population, a lowering arm of its own, with no measurable gain today (yield below). The refusal
  makes the path sound now.

### Reuse and quality

- Reuses: the existing lexical-name walker (moved, not copied), `GLOBAL_CONSTANTS`, `ownerAt` and `nodeLocation` from
  #7500, the one select-refusal module.
- Removes: the walker's private home in codegen; after #7519, the per-declarator three-name test in `declarations.ts`.
- Quality acceptance: one walker for a Script's lexically declared names, used by `codegen/index.ts`, the Prepared
  rule, and (in #7519) `declarations.ts`; one predicate built on it; no second walk to locate the name; no new owner
  concept.

### Acceptance

- Correctness: refused by name (`restricted-global-lexical`) under both `unlowerableBodies` policies:
  `let NaN = 1`, `const Infinity = 0`, `class NaN {}`, `class undefined {}`, `let undefined;`, `let x; let NaN;`,
  `let {a: NaN} = {a:1}`, `let [Infinity] = [1]`, `const {NaN} = {NaN:1}`, `const {Infinity} = {Infinity:1}`.
- Not refused by this rule: `var NaN;`, a Module-goal `let NaN = 1` (with an `export`), `let x = 1`,
  `let {a: b} = {a:1}`, a `NaN` inside a function or block (`{ let NaN = 1; }`, not top-level).
- Ordinary pipeline byte-identical on a sample × (default, standalone).

### Yield (measured)

None. The only test262 file with a top-level restricted lexical in a Script is
`language/global-code/decl-lex-restricted-global.js` (`let undefined;`, `negative: phase: runtime`), refused on the
Prepared path both before (`Phase 1 requires an initializer`) and after (`restricted-global-lexical`). Soundness fix.
