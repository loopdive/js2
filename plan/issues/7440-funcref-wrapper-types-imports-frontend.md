---
id: 7440
title: "`codegen/closures/funcref-wrapper-types.ts` imports the frontend (`ts-api`): layering violation"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: medium
horizon: s
task_type: bug
area: codegen, architecture
goal: ir-full-coverage
related: [7380, 5334]
---

# #7440 — a physical planning leaf imports the TypeScript frontend

## Problem

`src/codegen/closures/funcref-wrapper-types.ts` has `import { ts } from "../../ts-api.js"` since `708382dc7c`
(#5334, "rest-param callable values dispatch by runtime disambiguation"). It is one of the physical type, closure and
ABI planning leaves that must load without the frontend. Loading it under the frontend barrier fails with
"blocked frontend module: src/ts-api.ts".

`scripts/compiler-boundaries.json` does not catch it: the inventory has no rule for this leaf.

## Evidence

`tests/issue-3518-runtime-producers-import-boundaries.test.ts` "loads the physical type, closure, and ABI planning
leaves without the frontend".

## Acceptance criteria

1. `funcref-wrapper-types.ts` has no value import from the frontend (the `ts` use moves to the caller or becomes a
   type-only import).
2. The rule is in the compiler-boundaries inventory, so the next such import fails `quality`.
3. The red test passes unchanged.
