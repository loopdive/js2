---
id: 7400
title: "Split `materializePhysicalProgram` (program-consumer.ts) by its numbered emission steps"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
goal: ir-full-coverage
depends_on: []
related: [7365]
---

# #7400 — split `materializePhysicalProgram` by its numbered steps

## Problem

`materializePhysicalProgram` in `src/ir/program-consumer.ts` is one function
of about 300 lines. It runs the whole physical emission in numbered steps
(reserve, freeze, fill the native packs, fill the source bodies, the startup
adapter and exports, seal and the completion checks, the ownership receipts).
#7365 part A pushed it to 303 lines under a `func-budget-allow:` grant, because
its one-caller completion-check block is inline at the reviewer's request.

## Implementation Plan

- Module: `src/ir/program-consumer.ts`.
- Give each numbered step its own function, in program order, taking the
  emission's shared state (reservations, plan, packs) explicitly. No new
  module and no behaviour change.
- Quality criterion: no unit over the function budget; the grant from #7365
  part A is removed. Bytes are identical on the Prepared suites, and those
  suites keep their pass/fail set.
