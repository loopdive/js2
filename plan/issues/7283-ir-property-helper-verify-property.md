---
id: 7283
title: "IR: propertyHelper verifyProperty (and the other 130-file harness units) on the IR path"
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
parent: 7250
related: [7269, 7272, 7266, 2949, 7106]
assignee: "ttraenkler/c-r11"
---

# IR: propertyHelper verifyProperty on the IR path

## Problem

After #7272, every propertyHelper includer still compiles seven harness
units legacy. That keeps the whole ~130-file block (wrapped stride 40) out of
`ir_only_pass`. The seven are `verifyProperty`, `verifyCallableProperty`,
`verifyAccessorProperty`, `verifyEqualTo`, the two `verifyPrimordial*` units
and `<module-init>`. verifyProperty is the unit every includer calls.

## Measurement

To be filled: the full refusal chain of each unit on the real assembled
harness, peeled with stubs.
