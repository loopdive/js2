---
id: 2987
title: "Standalone defineProperty / gOPD on boxed-wrapper receivers (~18: new String/Number/Boolean)"
status: ready
sprint: Backlog
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2965, 1629]
origin: "#2965 descriptor-cluster triage — follow-up class 4 (boxed-wrapper receivers)"
---

# #2987 — standalone defineProperty / gOPD on boxed-wrapper receivers

## Problem

Follow-up from #2965. ~18 tests do `defineProperty` / `getOwnPropertyDescriptor`
on a boxed wrapper (`new String(...)`, `new Number(...)`, `new Boolean(...)`)
and fail on standalone — the wrapper receiver has no own-property MOP, and for
`new String` the exotic indexed own-properties (`"0".."n-1"` + `length`, all
`w:false, e:true, c:false`) are not modeled.

## Scope / mechanism

- defineProperty on boxed Number/Boolean wrappers (ordinary own-prop MOP on the
  wrapper struct).
- `new String` exotic string-index own properties per spec (10.4.3) for both
  gOPD and defineProperty (redefining an index must respect non-configurability).

## Acceptance

- Measured flip count on the boxed-wrapper defineProperty/gOPD standalone subset
  with zero regressions; gc/host byte-inert.
