---
id: 4717
title: "ES2015 assignment destructuring preserves undefined in nested arrays"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
feasibility: medium
reasoning_effort: medium
es_edition: es2015
language_feature: destructuring-assignment
task_type: bug
area: codegen
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileDestructuringAssignment
files:
  - src/codegen/expressions/assignment.ts
  - tests/issue-4717.test.ts
---
# #4717 — ES2015 assignment destructuring: nested-array `undefined`

## Live baseline

Baseline was measured on upstream `main` at `598cb2f22` with test262
submodule `b363f29d3c43c626dc852744ad64a0b48a003693`, using the in-process
`runTest262File` runner (30 s/file) in both host and `standalone` lanes.

| test262 row | host | standalone | observed result |
| --- | --- | --- | --- |
| `expressions/assignment/dstr/array-rest-nested-array-null.js` | fail | fail | nested rest `[x, y]` leaves the missing `y` as `null`, not `undefined` |
| `expressions/assignment/dstr/array-rest-nested-array-undefined.js` | fail | fail | empty nested rest `[x]` leaves `x` as `null`, not `undefined` |
| `expressions/assignment/dstr/obj-prop-nested-array-undefined.js` | fail | fail | missing object property is skipped; nested destructuring does not throw `TypeError` |

Nearby controls pass in both lanes: `array-rest-nested-array.js`,
`array-rest-nested-array-undefined-own.js`,
`array-elem-nested-array-null.js`,
`array-elem-nested-array-undefined-hole.js`,
`obj-prop-nested-array-null.js`, and
`obj-prop-nested-array-undefined-own.js`.

The two rest failures share the missing-value boundary in nested array
assignment: the nested `emitBoundsCheckedArrayGet` calls do not request the
JS `undefined` sentinel or normalize a `$Hole`. The object-property failure is
the corresponding absent-property case: the typed object assignment path
skips a missing field instead of forwarding an `undefined` source into the
nested array pattern. The implementation must keep these as one bounded
source-level contract—materialize absent nested-array inputs as JS
`undefined`—and must not broaden into unrelated destructuring forms.

## Plan

1. Confirm the baseline and inspect the assignment-only nested-array reads and
   typed-object field-miss path, retaining the passing controls above.
2. Thread the existing undefined-sentinel read option through the nested-array
   assignment path and make the missing object-property branch dispatch the
   nested pattern against a materialized undefined value.
3. Add focused host/standalone regression coverage and retain the controls.
4. Run the exact rows in both lanes, then TS5/TS7 typechecks, lint, Prettier,
   format, and prepush checks. Keep the source delta under 180 LOC.

If these rows require unrelated fixes after the diagnosis, revert speculative
source edits, retain this evidence, and close with an issue-only commit rather
than opening a PR.

## Implementation

The shared fix is limited to the nested-array assignment read boundary:

- Nested `emitBoundsCheckedArrayGet` calls now request the existing undefined
  sentinel and normalize sparse-array `$Hole` values.
- Object assignment now prefers the actual emitted RHS struct fields when the
  checker has erased contextual object-literal fields, allowing a missing
  property to reach the nested pattern and raise the required `TypeError`.

Source delta in `src/codegen/expressions/assignment.ts`: 15 added lines and 5
removed lines.

## Test Results

At the post-fix worktree, the three target rows and all six controls were run
through `runTest262File` with a 30 s per-file timeout. Every row passed in both
host and standalone lanes:

| lane | targets | controls |
| --- | --- | --- |
| host | 3/3 pass | 6/6 pass |
| standalone | 3/3 pass | 6/6 pass |

The focused regression suite `tests/issue-4717.test.ts` passed 8/8 tests (four
cases in each `gc` and `standalone` target). TypeScript 5 and TypeScript 7
typechecks, targeted and full Biome lint, and full Prettier format checks also
passed. The unrelated `array-elem-nested-array-undefined.js` row remains
outside this bounded cluster and was not changed.
