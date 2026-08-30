---
id: 5218
title: "Standalone: .sort(cmp) on a dynamic receiver is a silent no-op — array returned unsorted, no throw"
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5218 — standalone dynamic-receiver `.sort(cmp)` silently no-ops

## Problem

On the standalone lane, `t.sort((a,b) => …)` where `t` is an untyped/dynamic
receiver returns the array UNSORTED with no error: `[3,1,2]` in, `[3,1,2]`
out, at init and after init alike. A statically-typed receiver sorts
correctly. Silent wrong values.

Found by dev-5211 while validating PR #5314; verified PRE-EXISTING on
pristine origin/main; host-lane-independent.

## Acceptance criteria

1. Reduced repro sorts correctly on standalone (dynamic + static receivers,
   with and without comparator); new tests/issue-5218-*.test.ts failing on
   base for the dynamic rows.
2. No regressions in issue-5211 tests + array-method scoped runs (name
   them). Gates green.

## Notes

- Sibling filings from the same report: #5219 (omitted optional arg lowers
  to null), #5220 (init-marshal helper emission-condition gap).
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.
  Note: PR number 5218 exists and is unrelated (ids and PR numbers are
  independent sequences that collide numerically).
