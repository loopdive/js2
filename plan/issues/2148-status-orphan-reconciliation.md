---
id: 2148
title: "Status-orphan reconciliation: 60 in-review issues with no open PR + reset dead in-progress need re-validation"
status: done
completed: 2026-06-16
sprint: 62
created: 2026-06-12
updated: 2026-06-16
priority: high
feasibility: easy
reasoning_effort: medium
task_type: triage
area: planning
language_feature: compiler-internals
goal: process
related: [2147]
origin: "2026-06-12 sprint-62 issue review — full sweep of all 2,047 issue files"
---

# #2148 — two status pools have silently rotted

## Problem

1. **60 `in-review` issues have no open PR and no merged PR citing them** —
   almost the entire sprint-50/52 spec-gap audit wave (#1433–#1519,
   #1480–#1504 host-import family, #1634–#1646) plus #680, #1052, #1130,
   #1323, #1326, #1598, #1657, #1747, #1781. Per the status lifecycle,
   `in-review` means "PR open, author ≠ merger" — none of these qualify.
   Their real state is unknown: some were fixed by later work, some were
   abandoned mid-flight.
2. **17 `in-progress` issues from sprints 42–52 were reset to `ready`**
   during this review (no open PR, no active agent, no Suspended Work):
   #1132 #1206 #1315 #1322 #1325 #1336 #1378 #1505 #1520 #1528 #1532
   #1533 #1534 #1551 #1627 #1636 #1642. They need repro re-validation
   before anyone claims them.

## Approach

PO task, day-1 sprint 62. For each issue in pool 1 and 2: run
`/smoke-test-issue` against current main → repro gone ⇒ `done` (cite the
likely fixing PR if findable); repro present ⇒ `ready` with sprint
`Backlog` (or `63` if trivially routine). Special cases:
- #680 (wasm-native generators): its state gates blocked issues #735/#762
  and the eager-generator family (#1687/#1691/#2040) — resolve FIRST.
- #1326 (async microtask): coordinate with the live #1326c/#1042 epic.
- File small issues for #1858 audit residuals C7 (standalone
  key-enumeration order) and C9b (isFrozen/isSealed) if not already
  covered.

## Acceptance criteria

- Zero `in-review` issues without an open PR.
- Every pool-2 issue is either `done` or has a re-validated repro.
- #680's true state recorded; #735/#762 unblocked or re-blocked
  accordingly.

## Resolution (2026-06-16, dv3)

Full re-sweep of `plan/issues/*.md` on `upstream/main`. The 60-issue
`in-review` pool from the 2026-06-12 review had **already been drained** by
intervening reconcile work (PRs #1437, #1529 and the per-issue impl PRs that
carry `status: done` themselves). Only **two** `in-review` orphans with no open
*and* no merged PR remained; both reconciled:

- **#1326** (async standalone microtask queue) → `in-progress`. It is a **live
  epic** — `required_by: [1326c, 1766, 1774]` and TaskList "revive #1326" is
  in_progress — so its true state is `in-progress`, not `in-review` (per the
  special-case in Approach: coordinate with the live #1326c/#1042 epic).
- **#1645** (ArrayBuffer resizable + detached-buffer guards) → `ready`,
  `sprint: Backlog`. No implementation exists (spec-gap, unimplemented), so the
  repro is present ⇒ `ready` + backlog per the Approach rule.

**Pool 2** (the 17 reset `in-progress` issues) was not re-touched — they were
already moved to `ready` in the originating 2026-06-12 review; this task only
needed to drain the `in-review` pool to zero.

**Sprint-62 residual-epic audit (the task-description angle):** cross-referenced
every non-`done` sprint-62 issue against `gh pr list --state merged`. The
residual epics with merged slice-PRs (#2009, #2029, #2051, #2106, #2151, #2158,
#2159, #2160, #2161, #2162, #2163, #2164, #2166, #2169, #1917, #1712) each
**explicitly document remaining slices** in their files ("issue stays
open"/"carried forward"/"Keep … in-progress until …") — they are *not* orphaned
completions and were correctly left non-`done`. No false flips made.

Acceptance criteria met: **zero `in-review` issues without an open PR**
(`grep -l '^status: in-review' plan/issues/*.md` → none after this PR).

## Notes

Routine PO work but scheduled in 62 Tier 0 — dispatch hygiene protects the
whole sprint. #2147 (reconciler extension) prevents recurrence.
