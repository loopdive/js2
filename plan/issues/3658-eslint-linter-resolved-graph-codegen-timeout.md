---
id: 3658
title: "ESLint linter.js: resolved 149-file graph exhausts a 2 GB compiler heap"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: hard
reasoning_effort: max
task_type: performance
area: compiler, codegen, observability
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 76
required_by: [1400, 2693]
es_edition: n/a
related: [824, 1282, 1400, 1573, 1942, 3654, 3655, 3656, 3657]
---

# #3658 — Bound full codegen for the resolved ESLint Linter graph

## Problem

After #3654 restores ESLint's physical pnpm package context and exact virtual
module edges, direct `eslint/lib/linter/linter.js` analysis completes with 149
canonical sources. The entry has zero TS2307 diagnostics for the packages,
relative modules, type-only packages, and Node builtin owned by #3654; only
the static `../../package.json` edge owned by #3655 remains.

The honest next frontier is scale: this Node-host WasmGC probe does not return
within the 180-second budget used by the first ESLint integration test:

```sh
node --max-old-space-size=2048 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/eslint/lib/linter/linter.js \
  '{"allowJs":true,"target":"gc","platform":"node"}'
```

The bounded probe eventually exited 134 after about 45 minutes. V8 reported
repeated mark-compacts at 2,031 MB followed by:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

It emitted no structured compile result. This is not a TS2307 resolver failure
and must not be folded back into #3654.

## Required investigation

- Add phase timing and peak-memory telemetry around graph expansion, checker
  construction/diagnostics, reachability, declaration collection, function
  lowering, Wasm emission, and optimization.
- Determine whether the compiler is making forward progress, repeating work,
  or expanding code that is unreachable from the direct Linter entry.
- Record source/function counts entering each phase and identify the dominant
  files/functions.
- Keep the probe in the WasmGC JS-host lane under Node. Standalone/WASI work is
  not required for the first ESLint rung.
- Do not hide the problem by increasing the test timeout without a measured
  upper bound and a CI-safe regression budget.

## Acceptance criteria

- A deterministic reduced fixture reproduces the dominant repeated-work or
  reachability failure if one exists.
- The direct real `linter.js` child probe remains within an explicit,
  measured CI-safe time and memory budget and emits a structured result.
- The result records the compile/validate split even if a later semantic
  blocker still prevents execution.
- The Tier 1 test fails clearly on timeout or abnormal child exit; it never
  treats missing output as an expected compiler diagnostic.
- Phase timing and peak-memory evidence are recorded here before the issue is
  closed.
