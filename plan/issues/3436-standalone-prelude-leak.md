---
id: 3436
title: "Eliminate standalone harness-prelude host-import leak (console_log_externref + structuredClone)"
status: done
created: 2026-07-17
completed: 2026-07-18
assignee: ttraenkler/senior-dev-3436
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: standalone, console, structuredClone
goal: standalone-conformance
related: [3380, 3381]
sprint: current
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/typeof-delete.ts
---

# #3436 — Eliminate standalone harness-prelude host-import leak

## Problem

`scripts/test262-fyi-runtime.js` (the harness prelude prepended to every
standalone test262 compile) references `print` and `$262.detachArrayBuffer`.
Under `target: "standalone"` those lowered to host imports —
`env::console_log_externref` (from `print` → `console.log`) and
`env::structuredClone` (from `$262.detachArrayBuffer`). A standalone module is
pure WasmGC with **no** JS host, so any `env::*` import makes instantiation
fail. This single leak failed **32,245** standalone test262 records that would
otherwise pass — the largest standalone-conformance lever after the oracle-v8
rebaseline reclassified the standalone lane.

## Fix

Make `console.*` and `structuredClone` standalone-native, mirroring the existing
dual-mode precedents (`parseInt`/`parseFloat`, `escape`/`unescape`):

- `src/codegen/declarations/import-collector.ts` — the console host-import gate
  `if (!ctx.wasi)` becomes `if (!ctx.wasi && !ctx.standalone)`; structuredClone
  follows the escape/unescape dual-mode precedent (no host import under
  standalone/WASI).
- `src/codegen/expressions/builtins.ts` — standalone `console.*` calls lower to a
  native no-op sink: args are still evaluated for their side effects, then
  dropped (no host call emitted).
- `src/codegen/extern-declarations.ts` — the structuredClone ambient stub is
  skipped under standalone/WASI (mirrors the parseInt/parseFloat handling).
- `src/codegen/typeof-delete.ts` — `typeof structuredClone` reports `"undefined"`
  under standalone/WASI, on both the plain and comparison-optimizer paths.

## Acceptance

- A standalone compile of `print(1); console.log(2);` emits **zero** `env::*`
  imports (verified: no `console_log_externref`, no `structuredClone`).
- `typeof structuredClone === "undefined"` in standalone.
- `tests/issue-3436-standalone-prelude-leak.test.ts` passes.

## Implementation notes

The growth in the four god-files (`typeof-delete.ts` +37,
`builtins.ts` +19, `extern-declarations.ts` +11, `import-collector.ts` +8) is the
intended cost of adding standalone-native lowering arms alongside the existing
host arms; the additions are guarded dual-mode branches, not new subsystems, so
splitting them into a separate module would fragment the host/standalone
decision that must stay co-located with each builtin's existing lowering. Hence
the `loc-budget-allow:` grant for exactly these four paths (#3102/#3131).
