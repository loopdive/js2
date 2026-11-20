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

`scripts/compiler-boundaries.json` lists the file (`state: unmigrated`, `layer: mixed-needs-split`, next boundary
"Separate AST/context-driven generation, physical resources and generated native runtime"), so the inventory
allows a frontend import here. The test is stricter: it requires the physical planning leaves to load without the
frontend, and it passed until #5334 added the import. The inventory entry is the recorded debt, not the designed end
state, so the red test is a real regression, not a stale expectation.

## Evidence

`tests/issue-3518-runtime-producers-import-boundaries.test.ts` "loads the physical type, closure, and ABI planning
leaves without the frontend".

## Acceptance criteria

1. `funcref-wrapper-types.ts` has no value import from the frontend (the `ts` use moves to the caller or becomes a
   type-only import).
2. The file is split as its inventory entry says, and the entry moves out of `mixed-needs-split`, so the inventory
   rejects the next frontend import into it.
3. The red test passes unchanged.
