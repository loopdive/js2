---
id: 7499
title: "Prepared path accepts lexical declarations of NaN / Infinity / undefined that must throw"
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
