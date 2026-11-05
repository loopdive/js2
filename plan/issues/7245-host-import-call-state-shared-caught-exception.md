---
id: 7245
title: "Runtime: the declared-function call wrapper keeps the caught exception in shared state — a fresh `createHostImportCallState()` still reports the previous overflow"
status: ready
created: 2026-11-05
updated: 2026-11-05
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [3518, 6979, 7095]
---

# #7245 — per-instance caught-exception state for host import calls

Found by the S7-b fix-on-touch pass (2026-11-05) in
`tests/issue-3518-host-async-imports.test.ts`, row "shares one recursion
counter, retains the overflow object, and recovers after unwinding". The
row fails on main before and after S7 (it is marked `it.fails` on PR 6705
so it flips red when fixed): after a `RangeError` overflow inside a wrapped
`declared_func` import, `state.getCaughtException()` correctly returns the
RangeError, but a **fresh** `createHostImportCallState()` also returns it —
the caught exception lives in module-level state shared by every call-state
instance instead of in the instance.

## Plan

1. Measure: a `.tmp` probe creating two call states, overflowing one, and
   reading both; confirm which field is module-level (`src/runtime/*`
   host-import call-state module, the `getCaughtException` / wrap path).
2. Fix: move the caught-exception slot into the per-instance state object
   (the recursion counter is per instance already); the facade adapters that
   read it (`env.caught`) read their own instance's slot.
3. Tests: turn the `it.fails` row back into a normal row; add a two-instance
   row.
4. Acceptance: equivalence gate "No new equivalence regressions"; Wasm bytes
   unchanged (runtime-only).
