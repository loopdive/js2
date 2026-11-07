---
id: 7280
title: "IR module-init: script-var object literals (`var obj = {}`, `{0: …}`, `{length: …}`) as the open `$Object` carrier"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7276, 7288, 7128, 2949, 7252]
assignee: "ttraenkler/c-lead"
---

# #7280: script-var object literals in `<module-init>`

## Problem

The census behind #6583 counts these as sole blockers of the test262 `<module-init>` unit:

- `var obj = {}` (`objectlit-empty`): 29 files;
- `obj = {}` (`vardecl-module-storage-unrepresentable`): 15 files;
- `{0: …}`: 6 files;
- `{length: …}`: 5 files;
- `proto = {}`: 3 files;
- 66 two-unit files paired with `formatPropertyName`.

Stacked on #7288 (and through it on #7276, whose `Object.create` lowering builds the same open `$Object` carrier).

## Measurement

In progress.
