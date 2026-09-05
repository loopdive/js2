---
id: 4696
title: "ES2015 synchronous for-of generator IteratorClose on break and return"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: ES2015
language_feature: for-of-generator-iterator-close
goal: spec-completeness
source_cap: 180
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/generators-native.ts
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/statements/variables.ts::compileVariableStatement
---

## Scope

This bounded slice covers only synchronous ES2015 `for (… of …)` over a
generator when the loop exits through `break` or `return`, and the directly
related synchronous IteratorClose controls. It excludes destructuring,
`for-await-of`, `yield*`, and Map/Set iterator paths.

Exact official rows:

- `test/language/statements/for-of/generator-close-via-break.js`
- `test/language/statements/for-of/generator-close-via-return.js`

Direct controls:

- `test/language/statements/for-of/iterator-close-via-break.js`
- `test/language/statements/for-of/iterator-close-via-return.js`
- `test/language/statements/for-of/iterator-close-via-continue.js`
- `test/language/statements/for-of/iterator-close-via-throw.js`

## Baseline

At latest `upstream/main` `f13ddc11f51a30aaf55f96f825e037f54ecafa8b`
(2026-08-25), the normal harness reproduced the exact baseline:

- `generator-close-via-break.js`: `fail` (`returned 2`, assertion #1,
  `startedCount` should be 0).
- `generator-close-via-return.js`: `fail` (`returned 2`, assertion #1,
  `startedCount` should be 0).
- All four direct controls: `pass`.

The generator declarations were eagerly materialized by the host binding path;
the generic IteratorClose controls were already green.

## Root-cause plan

1. Run the two official rows through the normal test262 harness and inspect the
   generated Wasm/runtime path, preserving a known-good synchronous iterator
   control.
2. Trace generator creation, first `next`, loop abrupt completion, and the
   `IteratorClose`/`return` call. Compare the native generator state-machine
   path with the generic synchronous iterator path, without widening scope.
3. Implement the narrowest fix at the shared generator/for-of close seam, with
   focused regression coverage only if the defect is coherent and bounded.

## Root Cause

The host lane already had a native suspended generator state machine, but its
direct-call `for-of` lowering had no IteratorClose finalizer. More importantly,
the exact rows bind `values()` to `var iterable`: the checker reports
`Generator<T>` as `externref`, so both function-local and module-global binding
slots erased the native state struct and fell back to the host iterator bridge.
The bounded fix preserves the registered native state type for direct generator
bindings used only by synchronous `for-of`, adds a native close finalizer for
`break`/`return`/nested abrupt exits, and leaves spread, Array.from,
destructuring, async, yield-star, and Map/Set consumers on their existing paths.

## Acceptance

- Both exact official generator rows pass in the normal harness.
- All four listed synchronous IteratorClose controls remain passing.
- A focused test proves the generator starts suspended and its `finally`
  cleanup runs exactly once for both `break` and function `return` exits.
- No destructuring, async, `yield*`, or Map/Set behavior changes.
- Typecheck, focused tests, formatting, and the normal pre-push gates pass.
- Net source additions remain at or below the 180-line cap.

## Test Results

- Exact normal-harness rows: both `pass` (primary + strict rerun).
- Direct controls: all four `pass`.
- `tests/issue-4696.test.ts`: 2/2 focused tests pass (local binding on `break`,
  module binding on nested function `return`).
- Candidate source diff: 148 changed source lines (`git diff --numstat`), below
  the 180-line cap.
