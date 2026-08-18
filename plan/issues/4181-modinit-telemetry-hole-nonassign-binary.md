---
id: 4181
title: "module-init collection: non-assign binary statements skip the #3623 drop telemetry (uncounted silent drops), and `**=` is missing from the assignment-operator list entirely"
status: done
completed: 2026-08-06
assignee: ttraenkler/W6-dynamic-scope
sprint: 78
created: 2026-08-06
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: module-init
goal: standalone-gap
related: [3623, 4179, 1268, 2992, 3592, 3615]
# The telemetry snippet + `**=` arm live inside collectDeclarations' collection
# loop by necessity (same rationale as #4179's grant).
loc-budget-allow:
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
origin: "2026-08-06 W6-dynamic-scope — found while auditing the collection allow-list after #4179 (coordinator probe confirmed `a, b` / `x && f()` / `c ?? d()` top-level statements are dropped)."
---

# #4181 — the drop telemetry has a hole, and `**=` never made the operator list

## Two defects

1. **Telemetry hole (behaviour-unchanged fix).** In `collectDeclarations`'
   ExpressionStatement arm, `if (!isAssignOp) continue;` skips the #3623
   classifier at the end of the block — so a non-assignment binary statement
   (`a, b`, `x && f()`, `p || q()`, `c ?? d()`, comparisons) is dropped
   **uncounted**, invisible to the very telemetry (#3623
   `droppedModuleInitShapes`) built to make drops loud. The fix records the
   classification before the skip. Collection behaviour is unchanged — the
   #3623 "flip unhandled → compile" landing stays deferred (measured
   2026-08-06: the realistic corpus yield of collecting these shapes is
   ~40-70 files, none on the ES5 standalone lever; audit script
   `.tmp/w6/audit-drops.mts`, coordinator concurrence on deferral).

2. **`**=` was never in the local assignment-operator list** (its 15 siblings
   are, including the #1268 logical assigns), so a top-level `x **= 2` was
   silently dropped from `__module_init` — and because
   `module-init-collection.ts`' classifier calls every assignment operator
   "keep", the drop was invisible to the telemetry as well: the two lists
   disagreed exactly where it mattered. One-line behaviour fix; probed:
   top-level `x **= 3` on `x = 2` now yields 8 (was: 2, statement dropped).

## Statement-kind audit context (why this is the whole residue)

Post-#4179, an AST-scan of all 20,255 failing standalone-baseline files
against the collection logic found NO uncollected executable statement kinds
(sole hit: one illegal top-level `BreakStatement` test). The remaining
expression-shape drops (TaggedTemplate 32 files, bare-Identifier statements
22 files, comma/comparison ≤6 files each) are the deliberately deferred
#3623 population.
