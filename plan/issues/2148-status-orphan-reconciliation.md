---
id: 2148
title: "Status-orphan reconciliation: 60 in-review issues with no open PR + reset dead in-progress need re-validation"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
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

## Notes

Routine PO work but scheduled in 62 Tier 0 — dispatch hygiene protects the
whole sprint. #2147 (reconciler extension) prevents recurrence.
