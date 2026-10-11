---
id: 6481
title: "Symbolic funcIdx: resolve late-import / global index shifts once at emit time instead of walking every body per flush"
status: ready
created: 2026-09-15
updated: 2026-09-15
priority: low
horizon: l
feasibility: hard
reasoning_effort: max
task_type: perf
area: codegen
goal: test262-conformance
sprint: Backlog
es_edition: n/a
related: [6480, 4415, 3433]
---

# #6481 — symbolic funcIdx for late-import index shifts

## Problem

Late imports (`ensureLateImport`) and string-constant globals
(`addStringConstantGlobals`) are minted mid-compile and shift every already
baked function / global index. #6480 measured the cost of the shift walks at
~18 ms per honest test262 compile (~3 %) after cheapening the walks themselves:

- 395 `flushLateImportShifts` per 12 compiles, walking 642 k instructions;
- 428 `fixupModuleGlobalIndices` calls (one per string constant; 369
  single-value callers of `addStringConstantGlobals`).

Coarser batching is not available: there are 769 `flushLateImportShifts` call
sites in `src/`, each because a `funcIdx` is read immediately after, and the
invariant has a history of expensive breakages (−601 / −2 621 test262, see
#6480). The plan's second option remains: make the index symbolic.

## Proposed direction

- Emit `call` / `ref.func` / `global.get|set` against a stable symbol (an
  import-slot id or a `FuncRef` object) instead of a numeric index.
- Resolve symbols to numeric indices once, in the final emitter pass, after
  all imports and globals are known — so no shift walk ever runs.
- Keep the numeric fast path for indices that are provably final (runtime
  functions emitted before user code) so the emitter change stays incremental.

## Acceptance

- `shiftLateImportIndices` / `fixupModuleGlobalIndices` walks are gone or run
  zero times on the #6480 12-file profile; bucket self time < 5 ms / compile.
- Output binaries byte-identical on the #6480 capture; equivalence gate,
  `tests/issue-1109*`, `tests/issue-1302*`, `tests/multi-file` unchanged.
- test262 net ≥ 0 in the merge group.
