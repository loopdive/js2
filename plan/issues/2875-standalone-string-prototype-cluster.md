---
id: 2875
title: "Standalone: String.prototype.* cluster (159 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2885]
umbrella: 2860
blocked_on: 2885
---

> **Blocked on #2885** (standalone descriptor-reflection core). The reflective
> descriptor reads over `String.prototype` members (sub-cluster b) share the
> builtin-proto intrinsic-accessor defect specced there; land #2885's core
> (PR1+PR2) first, then fill in the String per-builtin glue member bodies.

# Standalone: String.prototype.\* failures (de-masked)

## Problem

~**159** `built-ins/String/prototype/**` (plus ~25 `built-ins/String/**`) tests
are host-pass but standalone-fail, de-masked by #2870 from the phantom
ToPrimitive signature (#2862).

## Triage needed

Likely sub-clusters: (a) `this`/argument `ToString`/`ToPrimitive` coercion of
object args in String prototype methods, (b) reflective descriptor reads over
`String.prototype` members (overlaps native-proto glue), (c) RegExp-arg methods
(`split`/`replace`/`match`) routing through `__str_flatten` (overlaps the
invalid-Wasm #2868 carrier). Triage with
`runTest262File(file, cat, undefined, "standalone")`, group by method.

## Test plan

Per sub-cluster: standalone fail → pass, verify-first, full `merge_group` +
standalone high-water. `ctx.standalone` only.
