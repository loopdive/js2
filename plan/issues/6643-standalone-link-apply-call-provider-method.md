---
id: 6643
title: "standalone: `Function.prototype.apply`/`.call` on a PROVIDER-OWNED method value returns `null` (or throws `called on non-callable receiver`) — killing the first assertion of test262's `checkSubclassingIgnoredStatic`"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
requested_by: ttraenkler/fable-lead
created: 2026-09-19
# (#5383 S65, 2026-09-19) Grant restated HERE, not left to #5383: CI diffs the
# merge preview against `main`, where #5383's grant does not cover this path
# (stranded-grant class).
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  # The one existing decision point the new arm must splice into: the
  # `__apply_closure` peer-dispatch arm added by #6420 lives inside this
  # builder, and the #6643 preference has to be evaluated there, before it.
  - src/codegen/object-runtime.ts::fillApplyClosure
---

# #6643 — `apply`/`call` on a linked-provider method value answers `null`

## Target (S65 dispatch)

`test/built-ins/Temporal/PlainDate/from/subclassing-ignored.js` and
`test/built-ins/Temporal/Duration/from/subclassing-ignored.js`.

## Status

In progress — re-derivation of the container-killed S65 lane's hypothesis.
