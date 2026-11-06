---
id: 7286
title: "IR: `string + <dynamic>` concatenation (legacy `+` semantics: ToPrimitive default hint, then ToString)"
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
related: [7284, 7277, 2949]
assignee: "ttraenkler/c-lead"
---

# #7286: `string + <dynamic>` concatenation

## Problem

A `+` with one string-family operand and one dynamic operand
(`'…' + error.name + ': ' + error.message` in `$DONE`, `'Expected ' + x` across
the harness) refuses the unit (`move-only[concrete]` on the BinaryExpression).
It needs legacy's `+`: ToPrimitive (default hint) on the dynamic operand, then
ToString — not `dyn.to_string`.

## Measurement

(in progress)
