---
id: 7292
title: "IR module-init: script-var array-literal storage (`var values = [2, 1, 3]`)"
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
related: [7252, 7128, 2949, 7274]
assignee: "ttraenkler/c-lane-opus"
---

# #7292 — IR module-init: script-var array-literal storage

## Problem

A script `var` holding an array literal (`var values = [2, 1, 3]`,
`var arr = []`, `var invalidStrings = ["…", …]`) is refused in module-init as
`vardecl-module-storage-unrepresentable`: the IR has no module-binding value
kind for legacy's array slot.

(Measurements, plan and acceptance criteria follow.)
