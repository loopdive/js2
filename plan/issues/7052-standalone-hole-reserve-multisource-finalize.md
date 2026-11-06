---
id: 7052
title: "standalone multi-source: a runtime-keyed store as the only array-hole trigger fails to compile — `dynamic array length fill requires a pre-reserved Hole global` (multi-source runs `emitVecAccessExports` after `fillVecLengthDynamicArms`)"
status: done
sprint: current
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: arrays, holes
goal: standalone-gap
related: [7019, 7013]
# 2026-10-17 — +2 lines in the finalize fill that OWNS the read of `$__hole`:
# the reservation must sit immediately before the one consumer that may not mint.
func-budget-allow:
  - src/codegen/vec-length-set.ts::fillVecLengthDynamicArms
---

# Multi-source projects never reserved `$__hole` before the dynamic length fill

Split out of [#7019](./7019-standalone-module-init-traps-cjs-graphs.md) (the
reduction of axios `utils.toObjectSet`).

## Problem

`obj[value] = true` with a runtime key arms hole-aware reads in the
`scanForArrayHoles` pre-pass (`ctx.usesArrayHoles`): the key may be `"length"`,
and ArraySetLength writes the absence marker. The finalize-time dynamic
`length` arm (`fillVecLengthDynamicArms` → `buildVecLengthHoleFill(…,
finalized=true)`) may only READ the `$__hole` global and throws when none was
minted.

- Single-source: `emitVecAccessExports` runs earlier and mints `$__hole`
  whenever `usesArrayHoles` — the fill always finds it.
- Multi-source (`compileProject`, every npm package graph): the same export
  pass runs AFTER `fill-vec-length-dynamic-arms`, so a project whose only hole
  trigger is a runtime-keyed store failed with
  `Codegen error: dynamic array length fill requires a pre-reserved Hole global`.

## Implementation Plan

Reserve `$__hole` (`ensureHoleType`) immediately before the finalized fill when
`usesArrayHoles` is set and it is still absent. The multi-source pipeline mints
it a few phases later anyway (`emitVecAccessExports`), and the condition is
exactly the one under which the old code threw — so only previously-failing
compiles change. Standalone-only by construction (`externGetIdxReserved`).

## Resolution

`src/codegen/vec-length-set.ts`: one guarded `ensureHoleType(ctx)` before
`buildVecLengthHoleFill`. Test `tests/issue-7052-standalone-hole-reserve-multisource.test.ts`
(fails on parent with the compile error; control asserts a non-constant
answer). gc binaries byte-identical.
