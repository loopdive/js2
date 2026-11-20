---
id: 7443
title: "Prepared path: the host-async dynamic carrier lane looks unreachable — prove it dead or give it a program"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, backend
goal: ir-full-coverage
related: [7380, 6979, 5385]
---

# Prepared path: the host-async dynamic carrier lane looks unreachable

## Problem

The Prepared planner keeps a lane that carries an unrefined `dynamic` value as `externref` across the
`wasmgc:host` async boundary:

- `src/ir/program/host-async-dynamic.ts` (`planHostAsyncDynamicUnits`, `preparedHostAsyncDynamicCarrier`);
- its use in `src/ir/program-physical-plan.ts` (`dynamicUnits`, the signature converter near line 998);
- `src/ir/program/prepared-async-frame-layout.ts` (`mode === "host"`).

#7380 (PR 3, review round 1) deleted the `wasmgc:standalone` guard of the stage 2 check "no `dynamic` type
survives legalization" because no program distinguishes it. That is only sound if this lane is dead.

## Evidence (2026-11-20, `claude/7380-validator-3`)

- The guard removed: `tests/issue-3525-prepared-pipeline-presentation.test.ts` and
  `tests/issue-3518-prepared-async-frame-plan.test.ts` stay green; the 804 proving programs and the 411-row ES5
  sample give the same outcome on every row with the validator on and off.
- Eight host-lane sources through `runPreparedIrPipelinePresentation` (JS target `gc`): an `any` parameter or result,
  sync or async, is refused before preparation ("complete synchronous numeric or Boolean function declarations are
  required"); an `any` local, an awaited `any`, an untyped `let` inside an async function, and an `any` helper beside
  an async function are `unsupported` before preparation; `async (value: number): Promise<number>` prepares, carries no `dynamic` type in its host
  projection, and fails at output on the retired host Promise imports (#6979).
- No test reaches `planHostAsyncDynamicUnits` with a candidate unit.

## To do

1. Search for a source program (any entry: strict Prepared, mixed presentation, `compileMulti`) whose host
   projection carries `dynamic` after preparation. If one exists, add it as a seed to
   `tests/issue-7380-prepared-validator.test.ts` and exempt that lane in stage 2a by name.
2. Otherwise delete the lane (the three places above) and its refusal "has no accepted host async dynamic carrier"
   becomes the planner's only answer for a `dynamic` body. The host Promise lane is retired (#6979); the native
   gap is #5385.

## Acceptance criteria

- Either a seeded program and a named exemption, or the lane deleted.
- Prepared bytes identical on the 804 proving programs; failing sets of the async-frame tests unchanged.
