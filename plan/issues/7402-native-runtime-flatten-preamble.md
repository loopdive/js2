---
id: 7402
title: "Native runtime: fold the flatten preamble into one runtime helper"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: runtime
goal: ir-full-coverage
related: [7350]
---

# #7402 — Native runtime: fold the flatten preamble into one runtime helper

## Problem

The native runtime bodies under `src/runtime/wasmgc/values/` each open with their own copy of the same
preamble: cast the `externref` argument to `$AnyString`, call `__str_flatten`, cast to `$NativeString`, and
load `data`, `off` and `off + len` into locals; then read one code unit with `array.get_u` per step.

- `json-bodies.ts`: `flatStringPreamble` and `readCodeUnit` (#7350 B2c-2, PR #7330).
- `string-number-bodies.ts`: the preamble of the `StringToNumber` body (lines 52 to 80 at PR #7323).
- `parse-number-bodies.ts`: the preamble near line 77 at PR #7323 (#7350 B2c-1), which keeps `len` and
  starts its cursor at 0 instead of `off`.

Found by review RV7330 of PR #7330 (should-fix S1). The copies differ in which locals they write and where the cursor starts.

## Fix

One exported builder in the native runtime (next to `emit-idioms.ts`) that takes the bindings and the local
indices, plus a code-unit read helper; the three bodies call it. Emitted bytes stay identical (check the
test262 harness corpus on default, standalone and linear before and after).

Do it after PRs #7323 and #7330 are both on main.

## Acceptance

- One flatten-preamble builder and one code-unit reader under `src/runtime/wasmgc/values/`; no body keeps a
  private copy.
- Binaries byte-identical before and after on the harness corpus, all three targets.
- No file or function grows past its budget.
