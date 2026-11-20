---
id: 7381
title: "Spike: a Prepared program calls a legacy-emitted runtime helper"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir, runtime
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Spike (one week): Prepared code borrows legacy's runtime library

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R4.

## Problem

By syntax, 6,761 of 8,717 positive ES5 files (77.6 %) use a built-in global or prototype method. The Prepared path's
native realm catalog (`src/runtime/contracts/native-realm-catalog.ts`) has 45 intrinsics, 42 marked `unavailable`,
and no String, Array, Number, Math, JSON, RegExp, Date or Error family. Standalone legacy has the whole ES5 library
(ES5 is a completed edition), in about 203k lines of runtime emitters (heuristic count) that all import
`src/codegen`. Pure builders shared by both today: 6,094 lines.

Moving the library family by family under "legacy bytes stay identical" is the long pole of the whole program. If
Prepared code could call the legacy-emitted helpers first, the library would arrive at once and the moves could
follow off the critical path.

## To decide (the spike answers these)

- Can a Prepared program link one context-emitted helper (target: `Object.keys({a:1}).length`, then
  `"abc".charAt(1)`, then `Math.abs(-1)`) with one adapter, without a second object layout?
- Do the two type spaces (Prepared reservations vs legacy registry) merge, and at what cost?
- How is "helpers still served by legacy" counted, so the metric shows legacy leaving?

## Acceptance criteria

1. A written result within one week: works / does not work, with the blocking reason and the measured cost.
2. If it works: the three programs above run through the Prepared entry with node's answers, and the stand-in pass
   count is re-measured with the adapter on.
3. If it does not: a measured cost (lines, days, byte-identity failures) for moving one whole family (proposal:
   `Object` statics) as the basis of a library plan.
4. No change to ordinary-pipeline output.
