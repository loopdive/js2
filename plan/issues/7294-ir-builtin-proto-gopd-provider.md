---
id: 7294
title: "IR: `Object.getOwnPropertyDescriptor(<Builtin>.prototype, \"m\")` via a shared compile-time descriptor provider"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7275, 7267, 7127, 7293]
assignee: "ttraenkler/c-lane-opus"
---

# #7294 — IR: builtin-prototype `getOwnPropertyDescriptor` provider

## Problem

`Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<literal>")` in test
module-init has no IR lowering (#7275 shape 2). Legacy synthesises the
descriptor at compile time from the `$NativeProto` glue.

(Measurements, plan and acceptance criteria follow.)
