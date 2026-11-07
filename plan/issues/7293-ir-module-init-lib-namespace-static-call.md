---
id: 7293
title: "IR module-init: static calls on unshadowed lib namespace globals (`Object.keys(o)`, `JSON.stringify(v)`, …)"
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
related: [7253, 7267, 7276, 7128, 7278]
assignee: "ttraenkler/c-lane-opus"
---

# #7293 — IR module-init: static calls on unshadowed lib namespace globals

## Problem

`expr-ident-not-in-scope:Identifier «Object»` (and `String`, `Date`, `JSON`,
`Reflect`, …) refuses test module-inits that call a static method on an
unshadowed lib namespace global.

(Measurements, plan and acceptance criteria follow.)
