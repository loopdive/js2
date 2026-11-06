---
id: 7284
title: "IR: async-test harness units `$DONE` / `__consolePrintHandle__` (doneprintHandle.js)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7277, 7253, 7251]
depends_on: [7277]
assignee: "ttraenkler/c-lead"
---

# #7284: async-test harness units `$DONE` / `__consolePrintHandle__`

## Problem

`test262/harness/doneprintHandle.js` defines `$DONE(error)` and
`__consolePrintHandle__(msg)`. On main's wrapped stride-40 standalone ledger
both are legacy in 139 of 1296 files (in 35 of them among ≤ 3 remaining legacy
units). Both first refuse at `param-dynamic-carrier-diverges-from-legacy: msg`,
which #7277 (string-slot params projected as IR strings) addresses; this
branch is stacked on #7277's branch.

## Measurement

(in progress)
