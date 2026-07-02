---
id: 2988
title: "Standalone defineProperty on the global object (~10, blocked on #2907 global carriers)"
status: blocked
sprint: Backlog
priority: low
horizon: m
feasibility: hard
area: codegen, runtime
goal: standalone-mode
depends_on: [2907]
related: [2965, 2907]
origin: "#2965 descriptor-cluster triage — follow-up class 5 (global-object receivers)"
---

# #2988 — standalone defineProperty on the global object

## Problem

Follow-up from #2965. ~10 tests do `defineProperty` on the global object
(top-level `this`) and fail on standalone. This needs the global-property
carrier infrastructure tracked in #2907 — without a real global-object MOP
there is no own-property slot to define onto.

## Status

**Blocked on #2907** (standalone global carriers). Re-open to `ready` once
#2907 lands the global carrier substrate.

## Acceptance

- After #2907: `Object.defineProperty(this, k, desc)` at top level defines a
  global own property observable by later reads / gOPD; measured flip count with
  zero regressions; gc/host byte-inert.
