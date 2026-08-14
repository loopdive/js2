---
id: 4407
title: "React and React DOM WasmGC capture forwarding"
status: in-review
sprint: current
created: 2026-08-14
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

# #4407 — React and React DOM WasmGC capture forwarding

## Problem

React DOM contains nested functions that capture a module binding while a
nearby function declares a local with the same name. The compiler previously
looked up the capture by name in the current frame and forwarded the shadowing
local instead of the leading capture cell. That produced an invalid WasmGC
call signature during React DOM compilation.

## Fix

At a capture boundary, prefer the recorded lifted-capture slot. When the slot
contains a raw value rather than the shared cell expected by the callee,
materialize the cell and update the local binding map so subsequent reads and
writes use the same storage.

## Verification

- React and React DOM compilation no longer fail with the invalid
  `externref`/`ref` call mismatch.
- The bridge regression suites for issues 2714 and 2804 pass with the real
  `setInstance` lifecycle hook.
