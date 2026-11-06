---
id: 7288
title: "IR module-init: a nested top-level `var` (block / `for` / `for-in` head) lowers to its module binding instead of withdrawing"
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
related: [7276, 3523]
assignee: "ttraenkler/c-lead"
---

# #7288: nested top-level `var` in `<module-init>`

## Problem

from-ast withdraws a selector-claimed `<module-init>` with
`ir/from-ast: module-init unit contains a nested var declaration`: a `var`
declared inside a block, a `for` head or a `for-in` head at script top level
is still a module binding (hoisted), but the lowering refuses it. This is a
claim-then-withdraw. #7276 measured it on the 7 `built-ins/Object/create`
for-in files.

## Measurement

In progress.
