---
id: 2136
title: "IR loop conditions: lower non-i32 conds through ToBoolean instead of bailing to legacy"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: compiler
language_feature: loops
goal: ir-adoption
related: [1980, 1804]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N3)"
---

# #2136 — numeric-truthiness loops should claim, not demote

## Problem

#1980's fix direction is bail-to-legacy for `while (k)` with an f64
condition (which previously emitted `i32.eqz` on f64 → invalid Wasm that
bricked the module). Bailing keeps those loops permanently in the
`body-shape-rejected` fallback bucket.

## Approach

Lower non-i32 loop conditions via the same coercion the `if`/ternary path
already uses (`from-ast.ts:620-623` pattern, `f64 != 0`), so the loop
claims and runs correctly through IR.

## Acceptance criteria

- `while (k)` with `k: number` claims through IR and runs correctly
  (test alongside #1980's regression guard).
- `body-shape-rejected` bucket does not grow; ideally shrinks.

## Notes

Routine dev work (no Fable needed); sequence after #1980's correctness fix
lands.
