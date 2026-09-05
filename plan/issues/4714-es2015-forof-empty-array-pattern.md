---
id: 4714
title: "ES2015 for-of empty array assignment pattern requires GetIterator"
status: in-review
created: 2026-08-25
updated: 2026-08-25
assignee: codex/4714-es6-forof-empty-array-pattern
priority: medium
horizon: s
feasibility: medium
task_type: conformance
area: codegen, destructuring, for-of
es_edition: es6
related: [4690, 4693, 4702, 4710]
loc-budget: 180
loc-budget-allow:
  - src/codegen/statements/for-of-destructuring.ts
---

# #4714 — empty array assignment pattern in for-of

## Scope and live baseline

The exact rows were run through the authoritative `runTest262File` seam from
upstream/main `598cb2f226dc1c60376a5d19f858b2db99f91b06` (2026-08-25). Both
the default host/GC lane and `target: "standalone"` were measured. The target
rows are the two named files; the directly related controls cover iterable
arrays/strings and the sibling non-iterable primitive/null values.

| file | host/GC baseline | standalone baseline | signature |
| --- | --- | --- | --- |
| `array-empty-val-num.js` | fail | fail | expected TypeError, no exception |
| `array-empty-val-undef.js` | fail | fail | expected TypeError, no exception |
| `array-empty-val-array.js` | pass | pass | empty array value completes one iteration |
| `array-empty-val-string.js` | pass | pass | string value completes one iteration |
| `array-empty-val-null.js` | fail | fail | expected TypeError, no exception |
| `array-empty-val-bool.js` | fail | fail | expected TypeError, no exception |
| `array-empty-val-symbol.js` | fail | fail | expected TypeError, no exception |

The two target failures are genuine behavior failures, not compile errors or
runner skips. Current lowering treats an empty assignment pattern as no work:
the externref path skips `__array_from_iter_n`, and the primitive path returns
without emitting the required non-iterable TypeError. This incorrectly avoids
`GetIterator` even though an empty `ArrayAssignmentPattern` still performs it.

## Implementation plan

1. In `src/codegen/statements/for-of-destructuring.ts`, route empty
   assignment-array patterns through the existing `__iterator` primitive,
   dropping its iterator record without reading an element. This performs the
   required `GetIterator` step on both host and standalone/WASI lanes while
   leaving the existing bounded materializer for non-empty patterns intact.
2. For statically primitive element types, emit the existing TypeError helper
   instead of silently returning. Keep binding allocation behavior and all
   non-empty paths unchanged.
3. Add exact seven-row host and standalone pins in a focused issue test. The
   two target rows must become pass; iterable controls must remain pass; the
   sibling non-iterable controls must become pass.
4. Re-run the focused seam, compiler/type checks, and adjacent empty-pattern
   controls after merging latest upstream/main. Keep changed compiler source
   below 180 lines.

## Non-goals and exclusions

This issue does not implement assignment-target writes (#4693), temporal-dead-
zone behavior (#4710), fresh per-iteration bindings (#4702), async/for-await,
collection iterators, or broad `IteratorClose` repair. The zero-step iterator
probe is used only to expose the iterator acquisition required by this empty
pattern; it does not broaden iterator destructuring ownership.

## Acceptance

- Both named rows pass in host/GC and standalone through the exact
  `runTest262File` seam.
- `array-empty-val-array.js` and `array-empty-val-string.js` remain passing in
  both lanes, and null/bool/symbol sibling controls pass by observing the
  expected TypeError.
- No unrelated source files are changed; compiler source growth is at most
  180 lines.
- Focused tests, typecheck/format checks, and the final upstream-main merge
  validation pass.

## Test Results

Baseline recorded above before source edits. After the fix, all eight focused
rows passed in both lanes through `runTest262File` (16/16): the two named
regressions, array/string iterable controls, null/bool/Symbol non-iterable
controls, and `array-empty-iter-get-err.js`. The focused Vitest file
`tests/issue-4714.test.ts` reproduced the same 16/16 result.

Additional checks:

- TypeScript 7: `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json` — pass.
- TypeScript 5: `node node_modules/typescript/lib/tsc.js --noEmit` — pass.
- Prettier check on the changed source/test files — pass.
- `git diff --check` — pass.
- Fetched and merged `upstream/main` at `598cb2f226dc1c60376a5d19f858b2db99f91b06`
  (`git merge upstream/main --no-edit` reported already up to date), then
  reran the focused Vitest pins — pass.

The compiler change is confined to `src/codegen/statements/for-of-destructuring.ts`
and is 19 net source LOC (26 additions, 7 deletions), below the 180-line
budget.
