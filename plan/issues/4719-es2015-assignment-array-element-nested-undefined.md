---
id: 4719
title: "ES2015 assignment destructuring throws for nested array element undefined"
status: in-review
created: 2026-08-25
updated: 2026-08-25
priority: high
feasibility: medium
reasoning_effort: medium
es_edition: es2015
language_feature: destructuring-assignment
task_type: bug
area: codegen
depends_on: 4938
loc-budget-allow:
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileArrayDestructuringAssignment
  - src/codegen/expressions/assignment.ts::emitArrayDestructureFromLocal
files:
  - src/codegen/expressions/assignment.ts
  - tests/issue-4719.test.ts
---
# #4719 — ES2015 assignment destructuring: nested-array element `undefined`

Depends on #4938, which is the open upstream PR for the three sibling nested
assignment rows listed as controls below. This issue is deliberately limited
to the residual `array-elem-nested-array-undefined.js` root cause.

## Live baseline

Baseline was measured on upstream `main` at `aeaad6e90` with test262
submodule `b363f29d3c43c626dc852744ad64a0b48a003693`, using the in-process
`runTest262File` runner with a 30 s per-file timeout in both host and
`standalone` lanes.

| test262 row | host | standalone | role / observed result |
| --- | --- | --- | --- |
| `expressions/assignment/dstr/array-elem-nested-array-undefined.js` | fail | fail | residual: strict rerun performs the unresolved `x` check before the nested array can observe its missing element, so the assertion sees a non-`TypeError` throw |
| `expressions/assignment/dstr/array-elem-nested-array-undefined-own.js` | fail | fail | same strict nested-array ordering with an explicit `[undefined]` element |
| `expressions/assignment/dstr/array-elem-nested-array-undefined-hole.js` | pass | pass | nearby hole control already passes on the base |
| `expressions/assignment/dstr/array-elem-nested-array-null.js` | pass | pass | nearby null control |
| `expressions/assignment/dstr/array-elem-nested-array.js` | pass | pass | nearby positive nested-array control |
| `expressions/assignment/dstr/array-rest-nested-array-null.js` | fail | not captured | dependency control; its host baseline failed before #4938 was stacked |
| `expressions/assignment/dstr/array-rest-nested-array-undefined.js` | fail | fail | dependency control: empty nested rest leaves `null` instead of `undefined` |
| `expressions/assignment/dstr/obj-prop-nested-array-undefined.js` | fail | fail | dependency control: absent property skips nested pattern instead of throwing |

After stacking the open #4938 branch, all three dependency controls passed in
both lanes, while the two residual rows above still failed in both lanes. The
residual is a strict-mode ordering gap, not another missing-value conversion:
`compileArrayDestructuringAssignment` performs its unresolved-target preflight
before dispatching the nested pattern. The fix must let a nested pattern
observe a nullish outer element first, while retaining the existing early
strict error for leaf-only targets.

## Plan

1. Stack this branch on upstream PR #4938 and rerun the three #4938 controls
   plus the residual and nearby nested-array controls in host and standalone
   lanes.
2. Narrowly defer the strict unresolved-target preflight when the top-level
   assignment target contains a nested array/object pattern; let the existing
   nested nullish guard produce the required `TypeError`, without changing
   leaf-only strict assignment or ordinary array reads.
3. Add focused host/standalone regression coverage for the residual and retain
   all controls. Keep the source delta at or below 180 LOC.
4. Run the exact rows, then TS5/TS7 typechecks, targeted/full lint,
   format-check, and prepush checks with pinned pnpm 10.30.2.

If the residual cannot be fixed without unrelated source changes, revert
speculative edits, retain the baseline evidence, commit the issue-only record,
and report no PR.

## Implementation

The strict unresolved-target preflight in
`compileArrayDestructuringAssignment` now detects nested array/object elements
and defers that preflight for those patterns. In `[[x]] = []` and
`[[x]] = [undefined]`, the nested destructuring path therefore sees its nullish
source and emits the existing `TypeError` guard before strict-mode resolves the
leaf `x`. Leaf-only patterns retain the existing early strict `ReferenceError`
path.

Source delta in `src/codegen/expressions/assignment.ts`: 12 added lines and 1
removed line.

## Test Results

The exact 14-row matrix (the two residual rows, all three #4938 dependency
controls, and nearby nested-array controls) passed in both lanes through
`runTest262File` with a 30 s per-file timeout:

| lane | result |
| --- | --- |
| host | 14/14 pass |
| standalone | 14/14 pass |

The additional four nearby nested-object rows passed 4/4 in each lane. The
focused `tests/issue-4719.test.ts` suite passed 16/16 tests (8 rows in each
host and standalone lane). TS5 and TS7 typechecks, full Biome lint, full
Prettier format-check, and the repository pre-push hook all passed; the hook's
numeric-local regression gate also passed 18/18 tests.
