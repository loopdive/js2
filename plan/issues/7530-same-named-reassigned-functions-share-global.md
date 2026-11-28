---
id: 7530
title: "Same-named reassigned functions in different files share one live-binding global"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7470]
---

# #7530 — same-named reassigned functions share one live-binding global

## Problem

Found while planning #7470, which covers the same defect for top-level variable bindings. When two files of one
`compileMulti` program each declare `function f` and one of them reassigns it, both files read and write one
`__mod_f` live-binding global (`registerReassignedFunctionGlobals`, `src/codegen/index.ts` ~L9254). Measured on
50bce1ba04 (2026-11-26); gc and standalone give the same answers:

| shape | node | now |
| --- | --- | --- |
| dep reassigns its own `f`; entry calls its own `f` | 12 | 42 |
| entry reassigns its own `f`; dep calls its own `f` | 14 | 34 |

## Plan

Fix this after #7470 and reuse its per-module binding table (`src/codegen/source-module-globals.ts`). Do not add a
second keying scheme.

## Acceptance criteria

- Both rows, plus an imported reassigned function, answer like node on gc and standalone. Pin them with
  `compileMulti` tests that fail on main.
- Single-file output stays byte-identical.
