---
id: 4705
title: "ES2015 for-of head RHS nullish values must throw TypeError via ToObject"
status: in-review
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: test262-conformance
lane: B
language_feature: for-of
related: []
files:
  - src/codegen/statements/loops.ts
  - tests/issue-4705.test.ts
loc-budget-allow:
  - src/codegen/statements/loops.ts
source-loc-budget: 180
---

# #4705 — synchronous `for-of` head RHS ToObject on `null`/`undefined`

## Baseline (current `upstream/main`)

Verified on `upstream/main` commit `34b083771` (2026-08-25), using the
authoritative `runTest262File` js-host runner:

| test | baseline |
| --- | --- |
| `language/statements/for-of/head-expr-to-obj.js` (exact) | **fail** — `assert.throws(TypeError, ...)` receives a non-object thrown value |
| `language/statements/for-of/head-expr-obj-iterator-method.js` (object with no `@@iterator`) | pass |
| `language/statements/for-of/head-expr-primitive-iterator-method.js` (boolean/number) | pass |
| `language/statements/for-of/cptn-expr-itr.js` (array RHS iteration) | pass |
| `language/statements/for-of/cptn-expr-no-itr.js` (empty array RHS) | pass |
| `language/statements/for-of/generic-iterable.js` (custom synchronous iterator) | pass |
| `language/statements/for-of/array.js` (array fast path) | pass |

The exact test fails after both `for (x of null)` and `for (x of undefined)`
reach the iterator lowering's null guard: the guard throws the raw exception
payload instead of a TypeError instance, so Test262 reports “Thrown value was
not an object!”. The object, primitive, array, and generic-iterator controls
confirm that ordinary synchronous iterator selection and iteration remain
working.

## Scope and exclusions

This slice covers only synchronous `for-of` RHS nullish ToObject behavior and
its directly adjacent iterator controls. It excludes lexical TDZ/fresh
bindings (#4700/#4702), binding or assignment destructuring, async iteration,
Set/Map lowering, and IteratorClose semantics.

## Implementation plan

1. Reconfirm the exact failure and controls on the isolated branch before
   source edits.
2. Replace the synchronous for-of nullish guard's raw exception payload with the
   existing canonical catchable TypeError emission, preserving the existing
   guarded-cast distinction and iterator/array/string dispatch.
3. Add a focused regression test that runs the exact Test262 file and the
   synchronous iterator controls through `runTest262File`.
4. Re-run the focused controls plus 3–5 related synchronous for-of files,
   compile/type checks, and source LOC budget. Acceptance requires the exact
   test and all controls to pass with no new failures; changed source stays at
   or below 180 lines.

## Implementation Summary

- **What was done:** Reused the canonical `buildThrowJsErrorInstrs` TypeError
  lowering for every synchronous for-of nullish guard (string, array, array
  keys/entries, direct iterator, and host iterator paths). The existing backup
  distinction for failed guarded casts remains unchanged: only a genuinely
  nullish RHS throws, while a wrong struct cast skips the native fast path.
- **What worked:** Keeping the change at the existing guard sites preserves
  iterator dispatch and late-import index flushing. The exact Test262 failure
  now reaches `assert.throws(TypeError, ...)` with a real TypeError instance.
- **What did not work:** No alternative implementation was needed; the prior
  raw `ref.null.extern` exception payload was the complete defect.
- **Files changed:** `src/codegen/statements/loops.ts`,
  `tests/issue-4705.test.ts`.

## Test Results

- `node_modules/.bin/vitest run tests/issue-4705.test.ts --reporter=verbose`:
  **7/7 passed** (exact test plus six synchronous controls).
- `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`:
  **passed**.
- `node_modules/.bin/prettier --check` on changed TypeScript and plan files:
  **passed**.
- Source diff: `18` added / `14` removed lines in `loops.ts`, well below the
  180-line source budget.

## Acceptance

- `head-expr-to-obj.js` passes in the authoritative js-host runner.
- The listed synchronous object/primitive/array/generic-iterator controls stay
  passing.
- No files in the excluded async, destructuring, Set/Map, IteratorClose, or
  lexical-binding families are changed or admitted by this slice.
- No more than 180 source lines are changed.
