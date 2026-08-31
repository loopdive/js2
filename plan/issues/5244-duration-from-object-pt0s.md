---
id: 5244
title: "Temporal.Duration.from({days: 1}) answers 'PT0S' — object-form Duration construction loses every field, single-module"
status: ready
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5244 — `Duration.from(object)` drops all fields

## Problem

`Temporal.Duration.from({days: 1}).toString()` answers `"PT0S"` (a zero
duration) instead of `"P1D"`, single-module, measured by dev-5242b on both
sides of PR #5354 (pre-existing, unchanged by the constructor bridge).
`new Temporal.Duration(0, 0, 0, 1)` answers `"P1D"` correctly, so the loss is
in the `.from(object)` field-extraction path — likely the same
absent-property / destructuring family as #5221 defect 1 or the #5243 bridge
argument marshalling, but with a silent zero instead of a throw.

## Direction

Probe after #5243 lands — it may be the same defect (the fields object
arriving null/opaque and every read defaulting to 0). If it survives #5243,
reduce inside the polyfill's `ToTemporalDuration` field reads and fix at the
general site.

## Acceptance criteria

1. `Temporal.Duration.from({days: 1}).toString()` → `"P1D"`; several field
   combinations covered; test failing on base.
2. No regressions in the issue-5221…5243 family. Gates green.

## Notes

- Found by dev-5242b (PR #5354), recorded so it is not rediscovered as a
  regression. Re-triage against #5243 first.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
