---
id: 7539
title: "Legacy codegen: native `Promise.all` over an ordinary array needs the retired `env::Promise_all` host import"
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
related: [7533, 4110, 5385, 6979]
---

# #7539: native `Promise.all` over an ordinary array

## Problem

`tests/issue-4110-ir-fetch-all-parallel.test.ts`, row "ordinary array near miss", fails in legacy codegen on the
default target with "would need retired host imports: env::Promise_all". This was measured by lane S25 on main
`1a726b3e` (2026-11-26) while planning #7533.

- Cause: since #6979 S7 the host `Promise_all` import is gone, and the native core has no lowering for `Promise.all`
  over an ordinary (non-tuple) array, so the program refuses.
- Relation to #7533: separate from its guard fix. It stays red after #7533 and is not skipped or marked todo.
- Relation to #5385 (standalone natives): this is related work.

## Acceptance criteria

- `Promise.all(arr)` over an ordinary array compiles natively on the default and standalone targets and settles to the
  same array as JS.
- The 4110 "ordinary array near miss" row passes.
