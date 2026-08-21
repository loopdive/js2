---
id: 4586
title: "Retry Binaryen O4 without Flatten for standardized try_table modules"
status: done
created: 2026-08-21
updated: 2026-08-21
priority: high
feasibility: easy
reasoning_effort: medium
task_type: performance
area: optimizer, standalone, npm-compat
language_feature: exception handling
goal: performance
sprint: current
depends_on: [2997]
related: [3780, 4157, 4578]
assignee: ttraenkler/codex
horizon: s
origin: "Acorn npm-compat O4 failure after standardized standalone EH exposed Binaryen Flatten's unsupported try_table path."
files:
  - src/optimize.ts
  - tests/issue-4586-o4-try-table-flatten.test.ts
---

# Retry Binaryen O4 without Flatten for standardized `try_table` modules

## Problem

Standalone/WASI output uses standardized Wasm exception handling so current
Wasmtime and Wasmer can load it. Binaryen 125 and current Binaryen main classify
`try_table` as control flow, but the O4-only `Flatten` pass implements only
block, if, loop, and legacy try. It aborts with `unexpected expr type` at
`Flatten.cpp:231` when optimizing a legal module containing `try_table`.

The optimizer currently treats that abort like every other failure and returns
the raw binary. Acorn therefore retains a 3,505,945-byte artifact even though
all other O4 passes can optimize it successfully.

## Scope

- Recognize only Binaryen's exact unsupported-`Flatten` failure at O4.
- Retry the same optimizer invocation with only `flatten` skipped.
- Keep every other optimizer failure loud and preserve the raw-binary fallback.
- Report that the successful optimized result omitted the unsupported pass.
- Pin a real standardized-EH module so the test proves the retry produced a
  smaller, runnable binary rather than silently returning the raw input.

## Acceptance criteria

- [x] A standalone module containing `try_table` optimizes successfully at O4.
- [x] The result is smaller than the raw module and preserves caught-exception behavior.
- [x] Ordinary O4 modules retain the normal invocation, including `flatten`.
- [x] Unrelated Binaryen failures still ship the raw binary with a loud warning.
- [x] Exact Acorn standalone-dynamic remains checksum-correct with zero imports.

## Measurement

On current main, the integrated retry produces a 2,129,709-byte Acorn binary
from the 3,505,945-byte raw module (39.3% smaller), with checksum 422/422 and
zero imports. It measures 57,876 us/op versus Node at 4,037 us/op (`0.06974x`
Node), recovering roughly 83x over the stale published `0.000838x` ratio. A
forced-legacy-EH/full-O4 control measures 58,717 us/op, showing that skipping
`flatten` is not a material runtime loss on this workload.

The pre-regression commit measures 29,518 us/op under full O4, so the remaining
roughly 2x Acorn runtime gap is independent of standardized EH and the skipped
pass. This issue restores the optimizer pipeline without claiming that separate
runtime regression is fixed.
