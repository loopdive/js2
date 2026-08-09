---
id: 3799
title: "Restore WASI warm array and string benchmark fast paths"
status: done
completed: 2026-07-30
sprint: 77
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: ir, codegen, benchmarks
goal: performance
assignee: ttraenkler/codex-wasi-warm-array-string
branch: codex/wasi-warm-array-string
loc-budget-allow:
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/index.ts
  - src/codegen/property-access-dispatch.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::makeResolver
  - src/ir/select.ts::whyNotIrClaimable
---

# #3799 — Restore WASI warm array and string benchmark fast paths

## Problem

The landing-page Wasmtime warm lane measured `array-sum` at roughly 21.6 ms
against V8's 5.3 ms and `string-hash` at roughly 0.59 ms against V8's 0.34 ms.

The real timing wrapper kept `array-sum.run` on the legacy body through
call-graph closure even though its numeric ABI was exact. That body boxed every
addition and repeated the full JavaScript ToInt32 conversion in the hot loop.
The native string-builder path also flattened a provably flat const-literal
receiver for every `charAt` append and materialized a string view merely to
read the builder length in the hash-loop condition.

## Resolution

- Certify the exact numeric ABI used by the fused array fill-and-reduce shape.
- Fuse the non-escaping temporary array into its i32 reduction, with sized
  allocation and direct stores retained for observable dense fills.
- Keep counted `.push` loops on the legacy pre-sized path until IR owns the same
  capacity proof, and record that deferred selector outcome in the IR-only
  readiness baseline.
- Preserve nested bitwise values in native i32 form.
- Bypass flattening for `charAt` on const string-literal bindings.
- Read detected string-builder lengths directly from their synthetic i32 local.
- Cover selection, WAT shape, edge-case behavior, and the exact landing corpus
  shapes.

## Evidence

Same-machine Wasmtime/V8 A/B, using
`scripts/generate-wasmtime-hot-runtime.mjs`:

| Benchmark           | Main Wasmtime warm | Fixed Wasmtime warm | V8 warm |
| ------------------- | -----------------: | ------------------: | ------: |
| Array fill + sum    |           21.63 ms |             0.51 ms | 5.03 ms |
| String build + hash |            0.58 ms |             0.16 ms | 0.34 ms |
