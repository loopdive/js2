---
id: 1833
title: "Implicit subclass constructor forwarder truncates multi-arg super(...)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 60
---
# #1833 — implicit derived constructor forwards only the first arg

## Symptom
`class Sub extends DataView {}; new Sub(buf, 0, 16)` constructs the parent with
only `buf` — `0` and `16` are dropped.

## Location
`src/codegen/class-bodies.ts:1103-1131` (pre-reg `:345-354`): the synthetic
forwarder declares a single externref `__arg0` and forwards only the first
argument to `__new_<Parent>`.

## Spec
An implicit derived constructor is `constructor(...args){ super(...args) }`.
(Was deferred as #1366c, which has no file.)

## Fix
Forward the full argument list (rest/vec) to the parent constructor.

