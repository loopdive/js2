---
id: 7511
title: "IR no longer emits comma-sequence functions that call console.log, nor `\"x\" in o` on `any`, under the native core"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: ir-full-coverage
related: [5164, 6979, 6708]
---

# #7511: IR coverage gap for #5164's comma and `in` cases under the native core

## Problem

`tests/issue-5164-comma-and-in.test.ts` checks three-way parity (JS, legacy, IR) and that the named functions were
genuinely emitted by the IR, not just claimed. Until #6979 S7 its runtime cases were pinned to
`semanticProviders: "host-assisted"`, where `console.log` and `"x" in o` lowered through host imports
(`__extern_has`). That mode is gone. On the native core (measured by lane S25 on main `1a726b3e`, 2026-11-26):

- the values and side-effect order now match JS and legacy;
- the IR no longer emits these 5 cases, so the "genuinely IR-emitted" assertion fails:

| case | IR verdict |
|---|---|
| `commaOrder` (comma sequence with `console.log`) | `unsupported` / `host-surface-unavailable` |
| `commaTry` | `unsupported` / `host-surface-unavailable` |
| `commaForIncr` (n = 3) | `unsupported` / `host-surface-unavailable` |
| `commaForIncr` (n = 0) | `unsupported` / `host-surface-unavailable` |
| `hasX(o: any) { return "x" in o; }` | `body-shape-rejected` |

The test stays red until the IR covers these natively. Lane S25 leaves the file out of its harness PRs.

## Acceptance criteria

- The IR claims and emits all 5 functions on the native core (default JS target), with the same values and log order.
- `tests/issue-5164-comma-and-in.test.ts` passes once its `host-assisted` pin is removed. That removal ships with
  this fix.
