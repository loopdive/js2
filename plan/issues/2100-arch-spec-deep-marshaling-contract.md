---
id: 2100
title: "architect spec: deep-marshaling contract at the host boundary (vec ⇄ array, closure ⇄ callback, struct ⇄ object)"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: host-interop
language_feature: compiler-internals
goal: core-semantics
related: [1996, 1969, 1998, 2028, 2015, 2025]
origin: "2026-06-11 analysis program (report 01 family F4 — unowned); stub 08-D15"
---

# #2100 — value conversion is decided ad hoc per call site

## Problem

Wasm↔host conversion has no declared contract — vecs cross opaque in some
bridges and converted in others (#1996/#1969/#1998), closures are
sometimes wrapped as host callbacks and sometimes not (host functions as
params trap, #2028), `this` routing diverges per bridge (#2015/#2025).
~14 June issues; the corpus marks this family entirely UNOWNED — the
upstream review graded the runtime on process and missed the semantics.

## Root cause

No conversion contract (vec ⇄ array, closure ⇄ callback, struct ⇄ object,
this-binding rules, depth/identity policy) with a single layer every
bridge routes through. `HOST_CALLBACK_METHODS` is dead code.

## Deliverable (spec only, no implementation)

`## Implementation Plan` here + a docs/architecture/ contract doc: the
conversion matrix, identity/round-trip rules, depth policy, one
`marshal(value, direction, depth)` layer, migration order over the
existing bridges, and which of the 14 member issues each phase retires.
Feeds sprint 64 consumers.

## Dupe check

Member issues filed individually; no family owner exists. New (analysis
program).
