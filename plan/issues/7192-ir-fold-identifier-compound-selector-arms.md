---
id: 7192
title: "IR: fold the selector's near-duplicate identifier compound-assignment arms (nontail / body) into one helper"
status: ready
created: 2026-10-29
updated: 2026-10-29
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
language_feature: compound-assignment
goal: ir-full-coverage
sprint: Backlog
parent: 7183
related: [7183, 3787, 2856]
---

# #7192 — IR: fold the selector's identifier compound-assignment arms

## Problem

Filed from the adversarial review of PR #6963 (#7183, finding 3). The
selector admits `x op= e` on an identifier in two near-identical arms of
`src/ir/select.ts`:

- the nontail statement walker (`nontail-*` labels, the `#3787 / #2856`
  top-level-in-body arm);
- the body statement walker (`body-*` labels).

Both run the same checks in the same order: unrepresentable module binding,
module binding outside module init, scope, projection-binding mutation, RHS
`isPhase1Expr`, then `clearProjectionBinding`. They differ only in the
rejection label prefix and in whether a scope miss is labelled.

PR #6963 folded the matching from-ast duplicates: the two statement
dispatchers now reach `lowerCompoundAssignment` through
`lowerAdoptedMutatingStatement`. `lowerForUpdateExpr` keeps its own
identifier arm, because the update-clause grammar admits no member targets.

## Why not in #7183

Folding the selector arms renames rejection labels, which moves
`check:ir-fallbacks` buckets and the #7143 census rows. That is its own
reviewed change, not part of a semantic PR.

## Implementation Plan

- **Module:** `src/ir/select.ts`, next to `isSelectableNumberCompound`.
- **Change:** one `identifierCompoundStatementAdmissible(expr, scope,
  localClasses, labelPrefix)` that both arms call. Keep each arm's label
  prefix, so the histogram stays readable; if a label must change, refresh the
  fallback baseline in the same PR with `--update` and list the moved buckets.
- **Removes:** the second copy of the six-step check.
- **Acceptance:**
  - correctness: the selected function set is identical on the playground,
    cutover and equivalence corpus (`scripts/legacy-reach-corpus.mjs`), both
    lanes;
  - quality: one admission helper for identifier compounds; no label-only
    duplicate arm remains.
