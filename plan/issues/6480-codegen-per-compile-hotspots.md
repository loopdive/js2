---
id: 6480
title: "Codegen per-compile hotspots: lib declaration scan re-run per compile, late-import index shifting walks every body per import"
status: ready
created: 2026-09-14
updated: 2026-09-14
priority: low
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: perf
area: codegen
goal: test262-conformance
sprint: Backlog
es_edition: n/a
related: [3433, 3451, 6463, 1109, 1302]
---

# #6480 — codegen per-compile hotspots

## Measured (2026-09-10, `--cpu-prof` over 12 warm honest test262 compiles of `Array.prototype.map` bodies, ~650 ms each, 4-core container)

Self time summed over the 12 compiles, i.e. divide by 12 for per-compile:

| bucket | self ms / 12 compiles | per compile | share |
| --- | --- | --- | --- |
| late-import index shifting (`shiftInstrs`, `shiftGlobalIndices`, `fixupModuleGlobalIndices`, `shiftLateImportIndices`) | ~344 | ~29 ms | ~4.5 % |
| lib declaration scan (`mapLibTypeNodeToWasm`, `collectInterfaceMembers`, `collectExternFromDeclareVar`) | ~277 | ~23 ms | ~4 % |
| `collectOuterWrites` (full enclosing-body walk per lifted closure) | ~65 | ~5 ms | <1 % |
| GC | ~516 | ~43 ms | ~7 % |

Inclusive, the harness's `assert.x = function …` property assignments
(`compilePropertyAssignmentExternSet`, ~20 %) and closure lowering
(`compileArrowAsClosure`, ~20 %) dominate — that is inherent codegen work per
harness and is what #3451 removes by not recompiling the harness. Nothing
here is a single big hotspot; the two buckets below are the mechanical ones.

## Two mechanical levers

1. **Lib declaration scan is per compile but depends only on the lib
   composite.** `src/codegen/extern-declarations.ts` walks the lib
   `declare var` / interface declarations on every compile
   (`collectExternFromDeclareVar`, `collectInterfaceMembers`, typed through
   `mapLibTypeNodeToWasm` in `src/codegen/lib-decl-index.ts`). Its inputs are
   the lib source files (identical for every compile in a process) plus the
   target profile; its outputs land on `ctx.externClasses` and friends.
   Memoise the scan result per `(lib composite name, target-profile
   fingerprint)` and clone it into the fresh context. Gain: ~23 ms per
   compile for pooled callers (test262 workers: ~44k compiles per lane).
2. **Late imports shift every compiled body per import.**
   `shiftLateImportIndices` (`src/codegen/expressions/late-imports.ts:159`)
   walks all live instruction arrays on each late import, guarded against
   double shifting (#1109, #1302). With `n` late imports and `m` instructions
   that is `O(n·m)`. Either batch the shift (collect pending late imports
   during a function and shift once at function end — the `pending` path at
   line ~693 already exists for one caller) or emit function references
   symbolically and resolve indices once at emit time. Gain: ~29 ms per
   compile; the batching route is the smaller change.

## Acceptance

- Per-compile self time of the two buckets halves on the profile above
  (rerun the same 12-file `--cpu-prof`), output binaries byte-identical.
- `tests/equivalence` unchanged; `tests/issue-1109*`, `tests/issue-1302*`
  unchanged.
