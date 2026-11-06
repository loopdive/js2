---
id: 7266
title: "IR module-init: admit truthiness tests of non-boolean module values"
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
related: [4512, 7240, 7124]
assignee: "ttraenkler/c-lane-opus"
---

# #7266 — IR module-init: admit truthiness tests of non-boolean module values

## Problem

`isPhase1ConditionExpr` (`src/ir/select.ts`) refuses every condition whose
truthiness operand is a module value with a non-boolean representation
(`condition-module-value-nonbool`, `-truthiness`, `-extern-truthiness`). The IR
already owns a canonical §7.1.2 ToBoolean per carrier
(`lowerToBooleanForCondition`, #4512), so for carriers it can lower host-free
the refusal is stale.

(Measurements, plan and acceptance criteria follow.)
