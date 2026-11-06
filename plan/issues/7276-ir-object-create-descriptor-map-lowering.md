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
loc-budget-allow:
  # 2026-11-06 (#7276): the plan and the lowering live in the new
  # src/ir/object-create-call.ts. What remains in the god-files is wiring
  # with no other home: select.ts +12, the selector adapter (lane + binding
  # facts) and the one Phase-1 call arm beside `Object.defineProperty`'s;
  # from-ast.ts +24, the resolver capability union, the from-ast adapter, the
  # arm at `lowerMethodCallWithSourcePlan` (the seam both call entries
  # share) and `lowerDataDescriptorFields`, which the #7128 open-carrier
  # define now shares instead of keeping its own copy.
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  # 2026-11-06 (#7276): one sibling arm in the flat call dispatch, beside
  # `Object.defineProperty`'s; splitting the dispatcher is its own refactor.
  - src/ir/select.ts::isPhase1Expr
---

# #7276: `Object.create(proto, {descriptor map})` in the IR

## Problem

#7275 measured 10 stride-40 files whose only legacy unit is `<module-init>`
and whose test body calls `Object.create({}, { <descriptor map> })`. Legacy
expands the descriptor map at compile time, so no runtime provider is needed
(`call-builtin-static.ts`, the `Object.create` arm).

## Measurement

In progress.
