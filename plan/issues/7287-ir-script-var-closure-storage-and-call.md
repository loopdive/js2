---
id: 7287
title: "IR: a script `var` holding a function expression is storable and callable from IR units"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7198, 7195, 7271, 7284, 7286, 7252, 7274]
assignee: "ttraenkler/c-lead"
---

# #7287: a script `var` holding a function expression, callable from IR units

## Problem

The test262 runner prelude binds `var print = function (value) { console.log(value); };`.
`__consolePrintHandle__` calls `print(msg)`, which the selector marks
`external-call`; `$DONE` then stays legacy through the call-graph closure
(#7284, #7286).

## Implementation Plan

(in progress)
