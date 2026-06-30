---
id: 2873
title: "Standalone: language/expressions cluster (276 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862]
umbrella: 2860
---

# Standalone: language/expressions failures (de-masked)

## Problem

~**276** `test/language/expressions/**` tests are host-pass but standalone-fail,
de-masked by #2870 from the phantom ToPrimitive signature (#2862). Plus ~108
`language/statements/**` and ~57 `language/function-code/**` in the same surface.

## Triage needed

This is a broad bucket — expression-level coercions/operators that throw a Wasm
exception standalone. Likely sub-clusters: object→primitive in operators
(`+`/`==`/relational), `ToPropertyKey` in member access, default-value/`ToNumber`
coercions. Triage with `runTest262File(file, cat, undefined, "standalone")`,
cluster by the operator/feature directory under `language/expressions/`, and
split into focused sub-tasks.

## Test plan

Per sub-cluster: standalone fail → pass, verify-first, full `merge_group` +
standalone high-water. `ctx.standalone` only.
