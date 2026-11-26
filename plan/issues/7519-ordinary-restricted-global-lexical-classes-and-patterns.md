---
id: 7519
title: "Ordinary pipeline: a Script's restricted global lexical class or binding pattern does not throw SyntaxError"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
goal: core-semantics
related: [7499]
---

# Ordinary pipeline: restricted global lexical classes and patterns do not throw

## Problem

A Script whose top-level lexical declarations bind `undefined`, `NaN` or `Infinity` must throw a SyntaxError at
GlobalDeclarationInstantiation (§16.1.7), before any statement runs. The ordinary pipeline does this only for a plain
`let`/`const` identifier: `noteRestrictedGlobalLexicalName` (`src/codegen/declarations.ts`) is called from the
identifier arm of a top-level `let`/`const` only. Class declarations and binding patterns slip through. Found by the
plan review of #7499 (PRV-7499), 2026-11-26.

## Repros (`995f3679`, compiled and run, default and standalone; node via `vm.runInNewContext`)

| Program | ordinary | node |
| --- | --- | --- |
| `let NaN = 1;` | throws (correct) | SyntaxError |
| `class NaN {}` | **returns** | SyntaxError |
| `class undefined {}` | **returns** | SyntaxError |
| `let {a: NaN} = {a:1};` | **returns** | SyntaxError |
| `let [Infinity] = [1];` | **returns** | SyntaxError |
| `const {Infinity} = {Infinity:1};` | **returns** | SyntaxError |

## Plan direction (lead decision, 2026-11-26)

Switch the ordinary pipeline to `restrictedGlobalLexicalName(sourceFile)?.text` (`src/shared/script-lexical-names.ts`,
introduced by #7499 for the Prepared path on top of the shared `scriptGlobalLexicalNames` walker), called once per
source, and delete the per-declarator `noteRestrictedGlobalLexicalName` call. This changes gc/standalone output for the forms above (they gain the
instantiation throw), so it is its own reviewed change with a byte diff limited to those programs.

## Acceptance criteria

- Every program above throws SyntaxError at the start of `__module_init`, default and standalone.
- One predicate for both pipelines; the per-declarator call is gone.
- Output unchanged for programs without a restricted lexical name.

## Implementation Plan

Written 2026-11-26, stacked on PR 7489 (#7499, head `1451f3b1`). That PR adds `src/shared/script-lexical-names.ts`
(`scriptGlobalLexicalNames`, `restrictedGlobalLexicalName`).

### Measured first (PR 7489 head; ordinary = `compile`, standalone, instantiated and run; Prepared = test262 entry)

| Program (`.ts` Script) | ordinary today | Prepared on PR 7489 |
| --- | --- | --- |
| `declare let NaN: number;` | runs | refused `restricted-global-lexical` |
| `declare class NaN {}` | runs | refused `restricted-global-lexical` |
| `declare const undefined: any;` | runs | refused `restricted-global-lexical` |
| `class NaN {}` (`.js`) | **runs** (this issue) | refused `restricted-global-lexical` |

An ambient declaration binds nothing at run time, so GlobalDeclarationInstantiation has no name to reject. The
ordinary pipeline already skips it: `hasDeclareModifier` at the top of the `VariableStatement` arm of
`collectDeclarations`. The shared predicate does not skip it. So switching the ordinary pipeline to the predicate as-is
would make these TS programs throw, a regression. On the Prepared path it is an over-refusal: no wrong value, but the
wrong label for a program that tsc rejects anyway (TS2451 against lib's `declare var NaN`).

### Target structure

1. **The ambient test moves to `src/shared`.** A plain `git mv src/ir/ambient-declarations.ts
   src/shared/ambient-declarations.ts`, with no re-export shim. Its three importers (`ir/identity.ts`,
   `ir/class-method-names.ts`, `ir/prepared-select-refusals.ts`) change only the import path. Its
   `compiler-boundaries.json` entry is re-pathed, keeps its classification, and its `nextBoundary` names the new user.
2. **Only the predicate filters ambient names (PRV-7499, lead decision 2026-11-26, option a).**
   `restrictedGlobalLexicalName` becomes
   `scriptGlobalLexicalNames(sourceFile).find((id) => GLOBAL_CONSTANTS.has(id.text) && !isAmbientDeclaration(id))`.
   `isAmbientDeclaration` walks from the identifier through its declaration's parents, so a pattern element or a class
   name under `declare` is ambient.
   - The walker is unchanged, and so is `recordSourceGlobalEnvironment` (`codegen/index.ts`). Its
     `ctx.globalLexicalBindings` feeds the eval machinery (`calls-guards.ts`, `ir-overlay-preparation.ts`,
     `runtime-eval-provider.ts`, `eval-inline.ts`, `index.ts`), which this change must not touch.
   - The Prepared rule (#7499) inherits the filter through the predicate.
3. **The ordinary pipeline asks the predicate once per source.** In `collectDeclarations`
   (`src/codegen/declarations.ts`), before the top-level statement loop:
   `ctx.restrictedGlobalLexicalName ??= restrictedGlobalLexicalName(sourceFile)?.text;`. `??=` keeps today's rule
   that the first collision across sources wins. Then:
   - `noteRestrictedGlobalLexicalName` and its per-declarator call in the `let`/`const` identifier arm are deleted.
   - Its spec comment (§16.1.7 steps 5.c-d, Module skip) is not lost: it already lives on the predicate and on the
     throw in `declarations/module-init-prologue.ts`.
   - The throw in that prologue and `moduleInitPrologueMayEmit` are unchanged; they read the same `ctx` field.

### Reuse and removal

- Reuses: the shared walker and predicate (#7499), the existing `ctx.restrictedGlobalLexicalName` field and its
  prologue throw, and `isAmbientDeclaration` (moved, not copied).
- Removes: `noteRestrictedGlobalLexicalName` (its own three-name test and Module check) and the per-declarator call.
- Code-quality acceptance:
  - one predicate serves both pipelines, and the restricted-name path uses one ambient test;
  - `GLOBAL_CONSTANTS` is the only list of the three names on this path;
  - no new `ctx` field, and no new filter at any caller.

### Acceptance

- **Correctness, ordinary pipeline, default and standalone, compiled and run:** these throw SyntaxError before any
  statement runs (the `__module_init` prologue): `class NaN {}`, `class undefined {}`, `let {a: NaN} = {a:1};`,
  `let [Infinity] = [1];`, `const {Infinity} = {Infinity:1};`, and still `let NaN = 1;`.
- **Not thrown:** `var NaN;`, a Module (`let NaN = 1; export {};`), `{ let NaN = 1; }`, and the three ambient `.ts`
  forms above.
- **Prepared:** the three ambient forms are no longer refused as `restricted-global-lexical`. The #7499 pin test gains
  them as "not refused by this rule".
- **Bytes:** ordinary output changes only for programs with a restricted class or pattern name. The byte check is
  default and standalone on a 100-file test262 sample. `ctx.globalLexicalBindings` must stay identical, since the walker
  is unchanged.

### Yield (measured with #7499's walker scan)

0 test262 files. The only Script with a top-level restricted lexical is `decl-lex-restricted-global.js` (`let undefined;`),
which the ordinary pipeline already throws on. This is a correctness fix for the class and pattern forms.

