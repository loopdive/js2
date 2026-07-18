---
id: 3412
title: "Script top-level function redeclarations are rejected as duplicate lexical bindings"
status: done
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler, early-errors
language_feature: script-declarations
goal: test262-conformance
assignee: codex/root
related: [3370, 1931]
files:
  - src/compiler/early-errors/duplicates.ts
  - tests/issue-3412.test.ts
---

# #3412 — permit legal top-level function redeclarations in scripts

## Problem

The oracle-v8 literal Test262 harness exposed a high-volume early-error bug.
`checkDuplicateLexicalDeclarations` treats every top-level
`FunctionDeclaration` as lexical, including declarations in Script code.
ECMAScript Script top-level functions are var-scoped and may be redeclared;
Module top-level functions remain lexical declarations and may not be
duplicated.

The real Test262 harness combines `assert.js` and helpers such as
`testTypedArray.js`. Both legally declare a top-level `function isPrimitive`.
The compiler therefore reports `Duplicate identifier 'isPrimitive'` before
executing otherwise valid tests.

Measured against the saved oracle-v8 GC run:

- 2,051 files fail with the exact spurious duplicate error.
- 1,788 of those files were passes under the previous oracle.

The synthetic wrapper hid this language bug by changing the declaration
context. The literal harness is correct and must remain unmodified.

## Acceptance criteria

- Repeated top-level function declarations compile in sloppy and strict Script
  code.
- Repeated top-level function declarations remain an early error in Module
  code.
- Duplicate lexical declarations and Script function-versus-lexical conflicts
  remain errors.
- The literal `assert.js` + `testTypedArray.js` harness assembly no longer
  fails with `Duplicate identifier 'isPrimitive'`.
- Add focused regression coverage and re-run representative affected Test262
  files through the authoritative project runner.

## Resolution

The duplicate checker now distinguishes var-scoped function declarations from
lexical declarations by statement-list context. Script and function-body
redefinitions are accepted, including sloppy Annex B blocks, while Module and
strict nested-block duplicates remain errors. Function-versus-lexical conflicts
remain errors in every context.

Verified by seven focused tests and by the literal-harness TypedArray batch.
