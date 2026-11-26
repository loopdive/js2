---
id: 7457
title: "Fold the call planner's `reassigned` set and the script-binding writes query into one analysis"
status: done
created: 2026-11-23
updated: 2026-11-26
completed: 2026-11-26
priority: low
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7457 — Fold the call planner's `reassigned` set and the script-binding writes query into one analysis

## Problem

Two analyses answer "is this function binding reassigned": the call planner's `reassigned` set in `imported-functions.ts` (shared with the ordinary pipeline) and `preparedBindingRewritten` in `src/ir/module-binding-script-var.ts`. After #7354 H2 the Prepared path's soundness depends on both agreeing. They agree on every write form the path lowers today.

## Acceptance criteria

- One analysis, used by the planner and by the Prepared queries.
- Ordinary-pipeline output byte-identical.

## Implementation Plan

Planned together with #7455: one binding-write index per source file. See
`## Implementation Plan` in `plan/issues/7455-open-object-home-name-based-whole-program-scan.md`. This issue is
slice 2 there: the planner's private write scanner in `src/ir/imported-functions.ts` is replaced by the shared
index, after a committed differential test lists and classifies every disagreement.

## Done (PR 2 of the #7455 series, 2026-11-26)

- **Change.** The planner's private write scanner is replaced by `bindingWrites` over the resolver's source
  files. It was the `reassigned` set with `scanWrites`, `scanAssignmentTargetWrites` and
  `scanBindingNameWrites`. `src/ir/imported-functions.ts` drops 100 lines and gains 4.
- **Differential, before the fold.** A temporary probe compared both answers for every function declaration the
  resolver saw. The corpora were the equivalence corpus, the shared 411-row sample (Prepared and ordinary) and
  the playground examples. Result: 24,949 checks over 1,160 distinct function declarations, zero disagreements.
- **`function f(){} var f = 6;` is not a difference.** The plan expected one, but in `.ts` and `.js` the
  checker gives the declarator its own symbol, so neither analysis sees the write. That gap is #7480.
- **Byte identity vs PR 1.** 7,182 distinct equivalence-gate compiles are identical, and so are the 848 o411 and
  playground rows. The gate passes.
- **Tests.**
  - `tests/issue-7457-planner-write-forms.test.ts` has 11 tests. They pass on the old planner and on the new one.
  - The 19 related test files (428 tests) show 0 new failures.
