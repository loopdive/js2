---
id: 7368
title: "Prepared path: Object.defineProperty / defineProperties / getOwnPropertyDescriptor through the Object statics table"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7364]
related: [7354, 7338, 7339, 7350]
# 2026-11-19 (WIP save, NOT a reviewed grant): prepareIrProgramSources 305 > 300 at the point the work stopped;
# the function is to be split before this branch is offered for review.
func-budget-allow:
  - src/ir/program-source.ts::prepareIrProgramSources
---

# #7368 — Object statics on the Prepared path

## Problem

The Prepared whole-program path has no selector and no `Object` statics: `Object.defineProperty` refused or (before
#7364) crashed. 1,760 positive ES5 test262 files call `Object.defineProperty`, 638 `getOwnPropertyDescriptor`, 622
`defineProperties`; `propertyHelper.js` (905 includers) calls them through stored aliases.

## Implementation Plan

Approved by the lead (2026-11-19): one admission table (`objectStaticCallPlan`), one emitter (`emitObjectStaticCall`)
whose "apply a definition" step is the parameter (ordinary: descriptor + `__obj_define_from_desc`, byte-identical;
Prepared: the literal's mask + `js.object.define-data` / `define-accessor` / `define-attributes`), one adapter row per
new contract (`js.object.get-own-property`, `has-own`, `property-is-enumerable`) on lane S3's ADAPTERS table, and the
selector-assuming arms through `refuseUnselected`. `getOwnPropertyNames` refuses by name (needs array results).

## Status

Work in progress, saved where the implementing agent stopped (2026-11-19). Not for review.
