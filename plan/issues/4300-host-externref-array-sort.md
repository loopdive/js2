---
id: 4300
title: "codegen: preserve host-array sort dispatch"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: xs
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays, host interop, method calls
goal: dogfood
related: [1286, 1967, 4286, 4297]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/array-methods.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/array-methods.ts::compileArraySortExtern
---

# codegen: preserve host-array sort dispatch

## Problem

`Object.keys(any)` returns a real JavaScript array through the host boundary.
The array-method selector correctly detected that result as `externref`, but
still routed `.sort(...)` to the native WasmGC-vector implementation. Its
receiver cast trapped because a host array is not js2's internal vector struct.
This stopped Hono while sorting its middleware route keys.

## Resolution

In the JS-host target, route an externref receiver's `sort` call through the
ordinary host receiver-method boundary. That preserves JavaScript comparator
semantics, mutation, and alias identity. Native Wasm arrays still use the
existing native sort, while standalone/WASI retain their host-free policy. The
existing externref-to-vector coercion then materializes a typed local when the
source binding is statically inferred as an array.

## Acceptance criteria

- [x] `Object.keys(any).sort(comparator)` runs without a Wasm cast trap.
- [x] The comparator determines the host array's ordering.
- [x] Native Wasm arrays continue to use an in-place native sort.
- [x] Hono advances past its middleware-key sort.

## Verification

- `tests/issue-4300-host-externref-sort.test.ts`
- `node tests/dogfood/hono-workload-harness.mjs`
