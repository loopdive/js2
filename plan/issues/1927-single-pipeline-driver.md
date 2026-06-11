---
id: 1927
title: "One front-end pipeline driver — compileSourceSync/compileMultiSource/compileFilesSource are divergent clones"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: correctness
---
# #1927 — Single front-end pipeline driver

## Problem

The compile pipeline exists as three ~450-line near-clones with **divergent
feature sets** (`src/compiler.ts:467` `compileSourceSync`, `:894`
`compileMultiSource`, `:1195` `compileFilesSource`):

- `detectEarlyErrors`, `rewriteEvalSuperCall`, hardened mode,
  `preprocessImports`, the JS-mode retry, and the timer shim run **only** on
  the single-source path. Multi-file compiles silently skip ES early errors
  entirely.
- `compileFilesSource` also skips define substitution and the CJS rewrite.
- `generateMultiModule` is not passed `experimentalIR`, `nodeBuiltins`,
  `wasiNodeFsFuncs`, `allowFs`, or `jsxRuntime` (`compiler.ts:1013-1022` vs
  `:701-720`) — multi-file users silently get a weaker, different compiler.
- The ~25-line error-return object is copy-pasted **14 times** across the file.
- Doc drift: `index.ts:213-216` says `experimentalIR` "Defaults to off";
  `compiler.ts:714` defaults it on.

Every new option or phase must be added in three places; missing one is
silent.

## Proposed approach

1. Extract `runPipeline(ast: TypedAST | MultiTypedAST, opts)` with an
   explicit ordered phase list (rewrites → parse/check → diagnostic triage →
   early errors → safe/hardened validation → codegen → post passes → emit).
2. Entry points differ only in how they build the AST(s); everything below
   the parse is shared.
3. One `failResult(errors)` helper replaces the 14 copies.
4. Phase applicability (e.g. CJS rewrite per-file in multi mode) is data on
   the phase, not a fork of the driver.
5. Fix the `experimentalIR` doc/default mismatch while there.

## Acceptance criteria

- Multi-file compile reports ES early errors (regression test: duplicate
  `let` in a second file).
- Option-plumbing parity test: the options object reaching codegen is
  identical for equivalent single/multi invocations.
- `compiler.ts` shrinks by ≥800 lines; equivalence + test262 green.

## Source

Compiler quality review 2026-06. Related: #1931 (early-error decomposition
rides on this), #1929.
