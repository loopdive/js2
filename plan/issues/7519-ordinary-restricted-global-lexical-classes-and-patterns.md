---
id: 7519
title: "Ordinary pipeline: a Script's restricted global lexical class or binding pattern does not throw SyntaxError"
status: ready
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

Switch the ordinary pipeline to `restrictedGlobalLexicalName(sourceFile)` (`src/shared/ambient-intrinsics.ts`,
introduced by #7499 for the Prepared path), called once per source, and delete the per-declarator
`noteRestrictedGlobalLexicalName` call. This changes gc/standalone output for the forms above (they gain the
instantiation throw), so it is its own reviewed change with a byte diff limited to those programs.

## Acceptance criteria

- Every program above throws SyntaxError at the start of `__module_init`, default and standalone.
- One predicate for both pipelines; the per-declarator call is gone.
- Output unchanged for programs without a restricted lexical name.
