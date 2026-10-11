---
id: 6480
title: "Codegen per-compile hotspots: lib declaration scan re-run per compile, late-import index shifting walks every body per import"
status: done
completed: 2026-09-15
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
related: [3433, 3451, 6463, 1109, 1302, 6481]
# 2026-09-15 (#6480 lever 1): the lib-scan memo keeps its bulk in the new
# src/codegen/lib-extern-scan-memo.ts, but the memo WRAPPER must live next to
# the scan it wraps — collectExternDeclarations is split into a thin memoised
# entry plus the unchanged impl, ~38 lines of wrapper, signature and the
# comment that explains why the `declare function` branch is excluded.
# 2026-09-15 (#6480 lever 2): +4 lines in registry/imports.ts — the indexed-loop
# rewrite of the module-global shift walk plus the three-line comment recording
# why the loop shape changed. The walk cannot move out of the file: it closes
# over `threshold`/`delta` and the two per-call visited sets.
loc-budget-allow:
  - src/codegen/extern-declarations.ts
  - src/codegen/registry/imports.ts
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

## Implementation (2026-09-15, Opus lane)

### Measured, this box (4-core container), same 12-file `--cpu-prof` probe

Three interleaved rounds per variant (base = `e1c92d52`, L1 = lever 1, L1+2 =
both), self time summed over 12 compiles, mean of 3:

| bucket | base | after L1 | after L1+2 | per compile (base → after) |
| --- | --- | --- | --- | --- |
| lib declaration scan | 273.8 ms | 33.0 ms | 39.8 ms | 22.8 → 3.3 ms (**−85 %**) |
| late-import / global index shifting | 236.7 ms | 238.0 ms | 213.9 ms | 19.7 → 17.8 ms (**−10 %**) |

All 12 output binaries byte-identical to the pre-change capture in
`.tmp/p6480/bins-base` at every step (`bins-l1`, `bins-l2`, `bins-l12`).
Run-to-run noise on the total is ±10 %, which is why the levers are scored
interleaved rather than one-shot; the lib-scan delta is far outside it, the
shift delta is at the edge of it.

### Lever 1 — landed as specced (`src/codegen/lib-extern-scan-memo.ts`)

The three extern-CLASS branches of `collectExternDeclarations` (`declare
namespace` / `declare class` / `declare var X: {new(): X}`) are replayed from a
recorded effect list; `buildLibDeclIndex` is cached on the lib source-file
identity list. Two deviations from the plan, both deliberate:

- **No `preloadLibFiles` hook.** The plan asked for `clearExternLibScanMemoForTests()`
  to be called from `preloadLibFiles`. Invalidation is structural instead: the
  memo is a `WeakMap` keyed on the lib `SourceFile` OBJECT, and `preloadLibFiles`
  already deletes those from `LIB_SOURCE_FILES`, so a replaced lib re-parses into
  a new object and misses by construction. Wiring the hook would also point
  `src/checker/` at `src/codegen/`. The seam is exported and used by the tests.
- **The effect list is captured by DIFFING the two maps** around the scan, not by
  instrumenting the collectors. Map iteration is insertion order and a re-`set`
  of an existing key keeps its slot, so replaying the diff in iteration order
  reproduces both the contents and the ORDER (which the import/type table
  depends on). The key pins the two maps' pre-state precisely because that
  pre-state decides the collectors' `has`-guards.
- Recorded `ExternClassInfo`s are cloned on replay (own object, own `methods`
  / `properties` maps, own `constructorParams`) so no later in-place mutation
  can leak between compiles. No such mutation exists today; the clone makes the
  memo robust to one appearing.

### Lever 2 — the specced batching does not exist to be done

**The plan's premise is wrong, and this is the main finding.** It reads
`shiftLateImportIndices` as being called once per late import with a `pending`
path that "already defers one caller's shift", and lists six call sites. In the
current tree:

- `shiftLateImportIndices` has exactly ONE caller, `flushLateImportShifts`;
- `ensureLateImport` ALWAYS defers (it opens `ctx.pendingLateImportShift` on the
  first addition of a batch) — the batching the plan asks for is already the
  universal mechanism;
- what costs is the FLUSH points, and there are **769 `flushLateImportShifts`
  call sites** across `src/`, not six. Each one exists because a `funcIdx` is
  about to be baked, and deferring it further means proving, per site, that no
  function index is read between the mint and the flush.

Measured on the probe: 395 flushes over 12 compiles (~33/compile) walking 642 k
instructions, plus 428 `fixupModuleGlobalIndices` calls (one per string constant
— `addStringConstantGlobals`' batching entry point has 369 single-value callers).
Converting either to a coarser batch is a compiler-wide refactor of the exact
invariant whose past breakages are cited in these files at −601 and −2 621
test262 passes, for a prize of ~9 ms out of a ~550 ms compile (1.6 %). Not taken
here; recorded rather than silently dropped.

What DID land is the same shape-only treatment #4415 gave the twin module-global
walk, now applied to the late-import walk (`"funcIdx" in instr` → direct
property read) plus indexed loops in both walks. −10 % of the bucket, byte
identical, no semantic change. Below the 30 % bar the acceptance asks for; the
number is stated rather than the bar being called met.

### Acceptance status

- Lib-scan bucket: **halved and then some** (−85 %). ✅
- Index-shift bucket: **−10 %, NOT halved.** ❌ — see above for why the specced
  route is unavailable; a real fix is a symbolic-funcIdx representation (the
  plan's own second option), which is its own issue.
- Output binaries byte-identical: ✅ (12/12, verified after each lever).
- `tests/issue-1109*`, `tests/issue-1302*`, `tests/multi-file`, the equivalence
  gate: unchanged. ✅

### Acceptance decision (2026-09-15, Fable lane)

Accepted as done with the shift-bucket target **retargeted**: the plan's
lever-2 route (coarser flush batching) does not exist as specced — deferral is
already universal and the 769 `flushLateImportShifts` sites each guard an
immediately-baked `funcIdx`, so the ~9 ms prize is not worth the invariant risk
(cf. the −601 / −2 621 test262 breakages cited above). The remaining fix is a
symbolic funcIdx resolved once at emit time, filed as #6481.
