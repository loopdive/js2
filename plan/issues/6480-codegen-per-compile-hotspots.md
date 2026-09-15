---
id: 6480
title: "Codegen per-compile hotspots: lib declaration scan re-run per compile, late-import index shifting walks every body per import"
status: in-progress
created: 2026-09-14
updated: 2026-09-15
assignee: ttraenkler/senior-dev
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
# 2026-09-15 (#6480 lever 1): the lib-scan memo keeps its bulk in the new
# src/codegen/lib-extern-scan-memo.ts, but the memo WRAPPER must live next to
# the scan it wraps — collectExternDeclarations is split into a thin memoised
# entry plus the unchanged impl, ~38 lines of wrapper, signature and the
# comment that explains why the `declare function` branch is excluded.
loc-budget-allow:
  - src/codegen/extern-declarations.ts
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

## Implementation Plan (2026-09-14, Fable lane; implementation: Opus)

Take the two levers in order; measure each with the same 12-file `--cpu-prof`
before and after (`node --cpu-prof --cpu-prof-dir=<dir> --import tsx <probe>`
over `built-ins/Array/prototype/map` bodies through `scripts/compiler-bundle.mjs`
`compile` with `skipSemanticDiagnostics: true`; `.tmp/profsum.cjs`-style
aggregation by self time is fine — record the two bucket totals).

1. **Lib declaration scan memo** (`src/codegen/extern-declarations.ts`).
   Find the entry that walks the lib composite's statements (the loop around
   L900–970 calling `collectExternFromDeclareVar` / `collectInterfaceMembers`
   with a `libIndex`). Everything it reads is (a) the lib `SourceFile`s, which
   `src/checker/index.ts` caches per process (`LIB_SOURCE_FILES`), and (b) the
   target profile; everything it writes lands on `ctx` maps
   (`ctx.externClasses`, `ctx.externClassParent`, any others — list them by
   reading the two collectors). Memoise the *written entries* per
   `(lib composite name, JSON of the target-profile fields the collectors
   read)` in a module-level `Map`, and on a hit copy the entries into the
   fresh `ctx` maps (shallow copies of the value objects if the collectors
   ever mutate them later — check with a grep of every writer). Guard: the
   memo must be keyed by the same `LIB_SOURCE_FILES` identity, so
   `preloadLibFiles` (which replaces lib sources) must clear it — export a
   `clearExternLibScanMemoForTests()` and call it from `preloadLibFiles`.
2. **Late-import shift batching** (`src/codegen/expressions/late-imports.ts`).
   `shiftLateImportIndices` walks every live body per late import. The
   `pending` path at ~L693 already defers one caller's shift; generalise:
   accumulate `added` for late imports minted while a function body is being
   compiled and apply ONE walk at the function's end (the existing
   `#1109`/`#1302` guards stay — one flush is one `+added` per instruction).
   Read all six call sites (`calls.ts:3709,7605,7698`, `assignment.ts:1247,2593`,
   `late-imports.ts:693`) and confirm none reads a function index between the
   mint and the flush; if one does, keep that site eager and batch the rest.
3. Tests: the equivalence gate (`node scripts/equivalence-gate.mjs`) and
   `tests/issue-1109*`, `tests/issue-1302*` are the correctness net; add a
   unit test for the memo (two `analyzeSource`+`generateModule` runs yield
   identical `externClasses` maps, and `preloadLibFiles` invalidates) and one
   for batching (a body minting two late imports compiles to the same bytes
   as before — compare against the pre-change binary captured in `.tmp/`).
