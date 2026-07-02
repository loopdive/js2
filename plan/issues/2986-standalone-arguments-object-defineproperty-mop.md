---
id: 2986
title: "Standalone defineProperty on mapped arguments object (~82, #2667 lineage)"
status: ready
sprint: Backlog
priority: medium
horizon: m
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2667]
origin: "#2965 descriptor-cluster triage — follow-up class 3 (arguments-object receivers)"
---

# #2986 — standalone defineProperty on mapped arguments object

## Problem

Follow-up from #2965. ~82 tests do `defineProperty` on a (mapped) `arguments`
object and fail on the standalone lane. The arguments-object receiver has no
own-property MOP on standalone, so the define is dropped or throws opaquely.
Continues the #2667 arguments lineage.

## Scope / mechanism

- `Object.defineProperty(arguments, k, desc)` with data and accessor
  descriptors.
- Mapped-arguments semantics: for a mapped index, redefining as a data
  descriptor with `configurable:false` / accessor breaks the parameter map per
  spec (10.4.4 `[[DefineOwnProperty]]`).

## Acceptance

- Measured flip count on the arguments-object defineProperty standalone subset
  with zero regressions on a passing-test sweep; gc/host byte-inert.
