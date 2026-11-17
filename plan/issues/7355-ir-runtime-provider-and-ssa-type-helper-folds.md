---
id: 7355
title: "Fold the duplicated canonical-provider comparisons and SSA value-type maps of the IR runtime"
status: ready
sprint: Backlog
created: 2026-11-17
updated: 2026-11-17
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
related: [7354, 3518]
---

# #7355 — Fold the duplicated provider comparisons and SSA value-type maps

## Problem

Two helper families are copied across the IR runtime. #7354 D1 extracted one
shared helper for each but could not fold every copy in that slice:

1. **Canonical provider comparison.** `src/ir/runtime/canonical-provider-mismatch.ts`
   (`canonicalProviderMismatch`) serves the ordinary-object and dynamic-value
   families. Three families keep their own copy:
   - `vectorProviderMismatch` (`src/ir/runtime/vector-callables.ts`);
   - `nativeAsyncProviderMismatch` (`src/ir/runtime/native-async-callables.ts`),
     which also answers "foreign clock projection" for a non-canonical
     `standalone-clock-zero` row;
   - `numberRemainderProviderMismatch` (`src/ir/runtime/number-remainder-callables.ts`),
     which compares with its own `sameData` instead of JSON equality.
2. **SSA value-type maps.** `irValueTypes` (`src/ir/analysis/value-types.ts`)
   is the neutral map of each SSA value's defining type.
   `nativeAsyncCallableValueTypes` (`src/ir/runtime/native-async-callables.ts`)
   is the same walk, plus a conflict check that throws the async family's error.
   About ten more modules keep a private `valueTypesOf`, among them
   `generator-support.ts`, `intrinsic-preparation.ts`, `async-prepare-ir.ts`
   and `prepared-component-dependencies.ts`.

## Why it was not done in D1

- `vectorProviderMismatch` and `nativeAsyncProviderMismatch` are source-hash
  pinned by the #3518 historical reconstruction
  (`tests/issue-3518-historical-runtime-reconstruction.test.ts`). Folding them
  needs a reviewed replay step for those receipts, the same mechanism as
  `tests/helpers/same-value-nan-correction.ts`.
- `numberRemainderProviderMismatch` first needs a decision: is `sameData` or
  JSON equality the canonical comparison? They differ on key order and on
  `undefined` fields.
- Most `valueTypesOf` copies sit under relocation receipts too.

## Acceptance criteria

1. One canonical-provider comparison serves every family; family-specific
   answers, such as the foreign clock row, stay in the family's module.
2. `nativeAsyncCallableValueTypes` is `irValueTypes` plus the family's conflict
   check, and at least the unpinned `valueTypesOf` copies call `irValueTypes`.
3. Pins change only by reviewed replay steps; no behaviour or byte change.
   Failing-test sets of `tests/issue-3518*` and `tests/issue-3526*` match main.
