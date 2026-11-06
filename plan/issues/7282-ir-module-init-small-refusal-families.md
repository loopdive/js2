---
id: 7282
title: "IR module-init: small sole-blocker families (operand coercion, RegExp constructor, call resolution)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7266, 7278, 7240]
assignee: "ttraenkler/c-lane-opus"
---

# #7282 — IR module-init: small sole-blocker families

## Problem

On the wrapped stride-40 standalone census, 23 test files have a single
legacy unit — `<module-init>` — refused by one of three small families:
`operand-coercion-unsupported` (6), `regexp-constructor-unsupported` (8) and
`call-resolution-unsupported` (9).

(Measurements, plan and acceptance criteria follow.)
