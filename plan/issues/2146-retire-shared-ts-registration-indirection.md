---
id: 2146
title: "Retire the registration-indirection layer in codegen/shared.ts"
status: ready
sprint: 65
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1916, 1899]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N3)"
---

# #2146 — function-pointer DI slots make call order a runtime trap

## Problem

`flushLateImportShifts` / `registerAddStringImports` /
`registerAddUnionImports` are function-pointer slots that throw
"not yet registered" until index.ts wires them
(`src/codegen/shared.ts:242-264`) — a circular-import workaround that
hides the real dependency graph and turns initialization order into a
runtime trap.

## Approach

Extract the shared state these functions close over into a module both
sides can import — or fold into #1916's handle resolver, which deletes
most callers. Sequence AFTER the #1916 A2 spec is ratified so this doesn't
churn twice.

## Acceptance criteria

- Zero `register*` DI slots in shared.ts; or the issue is explicitly
  absorbed into #1916 phase 1 with a pointer.

## Notes

Routine dev, S-size, sprint 63 (sequenced behind #1916's spec).
