---
id: 7267
title: "IR: ambient global object statics (`Object`, `String`, `Date`, `JSON`, `Reflect`, `Function`, `Array`) refused as `expr-ident-not-in-scope`"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7253, 7264, 7106]
assignee: "ttraenkler/c-lead"
---

# #7267: ambient global object statics refused as `expr-ident-not-in-scope(<Name>)`

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units, harness
included) is the goal metric. The wrapped stride-40 census shows module-init
and test units refused as `expr-ident-not-in-scope(<Name>)` where `<Name>` is
an ambient global object (`Object`, `String`, `Date`, `JSON`, `Reflect`,
`Function`, `Array`) used as the receiver of a static call or read.

## Measurement

(in progress)
