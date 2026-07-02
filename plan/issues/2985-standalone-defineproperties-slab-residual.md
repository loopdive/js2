---
id: 2985
title: "Standalone defineProperties 5-b/6-a slab residual (~250: array/arguments own-prop MOP + accessor attribute fidelity + destructive verifyProperty)"
status: ready
sprint: Backlog
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2667]
origin: "#2965 descriptor-cluster triage — follow-up class 2 (typeof sub-cause already FIXED in #2965)"
---

# #2985 — standalone defineProperties 5-b/6-a slab residual

## Problem

Follow-up from #2965. The `defineProperties` 5-b/6-a slab (~300 tests) is a
mixed bucket. #2965 fixed the materialized-`typeof` sub-cause (the
`ref.null.extern` stub); the remaining ~250 need distinct MOP work:

- **array / arguments own-property MOP** — defineProperty(ies) on array indices
  and `length` with full attribute semantics.
- **accessor-attribute fidelity** — get/set descriptor round-trips through
  define → gOPD must preserve accessor identity and attribute flags.
- **destructive `verifyProperty`** — test262's `verifyProperty` mutates then
  restores the property; the standalone MOP must survive the
  define→delete→redefine cycle.

Also folds in the `__obj_find` illegal-cast on residual dynamic non-string keys
(2 files) noted in the #2965 triage.

## Acceptance

- Measured flip count on the `built-ins/Object/defineProperties` standalone
  subset, per sub-class, with zero regressions on a passing-test sweep.
- gc/host lane byte-inert (standalone-gated).

## Notes

Likely wants slicing (array-index MOP, accessor fidelity, verifyProperty
survival) into separate PRs — hard/large.
