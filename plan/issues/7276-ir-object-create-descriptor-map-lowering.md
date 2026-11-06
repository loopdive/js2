---
id: 7276
title: "IR module-init: `Object.create(proto, {descriptor map})` lowered the way legacy does, by compile-time expansion"
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
related: [7275, 7128, 7267, 7189]
assignee: "ttraenkler/c-lead"
---

# #7276: `Object.create(proto, {descriptor map})` in the IR

## Problem

#7275 measured 10 stride-40 files whose only legacy unit is `<module-init>`
and whose test body calls `Object.create({}, { <descriptor map> })`. Legacy
expands the descriptor map at compile time, so no runtime provider is needed
(`call-builtin-static.ts`, the `Object.create` arm).

## Measurement

In progress.
