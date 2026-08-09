---
id: 3104
title: "Re-split codegen/index.ts (16,566 LOC, regrown 2.6x) into subsystem modules; driver-only index"
status: ready
sprint: current
created: 2026-07-09
updated: 2026-07-17
priority: high
horizon: l
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
depends_on: [2710]
related: [1013, 1172, 3102, 3106]
---

# #3104 — Re-split `src/codegen/index.ts` into subsystem modules

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`src/codegen/index.ts` is **16,566 LOC** — the #1013 split (done 2026-04-14,
14,344 → 6,368) has fully regrown and overshot (+2,187 LOC in the last 12 days
alone). It is simultaneously the module driver and a dumping ground for six
unrelated subsystems. Measured regions (current main, line anchors from the
top-level function map):

| Region                                                | Lines       | Size       | Anchors                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IR-overlay glue (lattice→IR typing, overlay planning) | ~534–1683   | ~1,150     | `latticeToIr`, `buildIrClassShapes`, `planIrOverlay`                                                                                                                                                                |
| Driver                                                | 1683–2986   | ~1,300     | `generateModule` (965 lines), `assertNoLeakedHostImports`, `addWasiStartExport`                                                                                                                                     |
| Export emitters                                       | 2986–6884   | **~3,900** | `emitStructFieldGetters/Setters`, `emitIteratorMethodExport`, `emitToPrimitiveMethodExport(s)`, `emitClosureCallExport{1..N}`, `emitIsClosureExport`, `_emitVecAccessExportsInner` (629), `emitDataViewByteExports` |
| Multi-module driver + console imports                 | 6884–7377   | ~490       | `generateMultiModule`                                                                                                                                                                                               |
| WASI runtime helpers                                  | 7377–9684   | **~2,300** | `registerWasiImports` (550), `emitWasi*`, `ensureWasi*`, `buildWasiStringEncodeToScratch`                                                                                                                           |
| Late-import collect/add suites                        | 9685–12894  | **~3,200** | `collect{String,Math,Parse,Promise,Json,Callback,Generator,FunctionalArray,Union,Iterator}Imports`, `addStringImports`, `addUnionImports`, `addUnionImportsAsNativeFuncs` (945)                                     |
| Type registry                                         | 12895–13840 | ~950       | `getOrRegisterTupleType`, `resolveWasmType` (313), `ensureStructForType` (347)                                                                                                                                      |
| Extern-class registry                                 | 13841–15525 | ~1,690     | `registerBuiltinExternClasses` (~400), `collectExternDeclarations`, `collectDeclaredGlobals`                                                                                                                        |
| Hoisting / TDZ scan                                   | 15526–16363 | ~840       | `hoistVarDeclarations`, `walkStmtForVars`, `walkStmtForLetConst`, `hoistLetConstWithTdz`                                                                                                                            |
| String-literal cache + modifier predicates            | 16363–16566 | ~200       | `cacheStringLiterals`, `hasExportModifier` …                                                                                                                                                                        |

Consequences: every leaf module that imports one helper from `./index.js`
pulls the 16.5k-line driver into its dependency graph; unrelated subsystems
share one file's merge-conflict surface (this file is the top conflict site in
`[CONFLICT]` tasks); and the late-import region hosts the index-shift bug
class (#2710's target).

## Target structure

`src/codegen/index.ts` keeps ONLY: `generateModule`, `generateMultiModule`,
the IR-overlay glue, and re-exports (one deprecation cycle). Moves:

```
src/codegen/wasi/helpers.ts          <- WASI region (~2,300)  [self-contained; imports registry]
src/codegen/registry/late-import-suites.ts <- collect*/add*Imports (~3,200)
src/codegen/registry/type-resolve.ts <- tuple/struct/wasm-type resolution (~950)
src/codegen/extern-registry.ts       <- extern-class + declared-globals (~1,690)
src/codegen/emit-exports.ts          <- export emitters (~3,900)
src/codegen/hoist-scan.ts            <- hoisting/TDZ scanning (~840)
src/codegen/builtins-tables.ts       <- STRING_METHODS, MATH_HOST_METHODS_*, KNOWN_CONSTRUCTORS, FUNCTIONAL_ARRAY_METHODS, WASI_* consts
```

This is #1172 Slices A/B/H re-grounded on the 2026-07-09 tree (the old line
numbers are all stale; region boundaries above are current).

## Safety story (byte-identity provable)

Pure code MOTION: no function body changes, no reordering of emission. Proof
protocol per region move:

1. `npx tsx scripts/prove-emit-identity.mjs` (golden baseline) on the branch
   BEFORE the move.
2. Move one region; keep `index.ts` re-exporting the moved names (zero import
   churn in the same commit; migrate importers in a follow-up commit).
3. `npx tsx scripts/prove-emit-identity.mjs check` — must print IDENTICAL.
4. `npx tsc --noEmit` + scoped vitest.

One region per commit; any drift pinpoints the exact move that broke.
Watch for module-scope state in the moved regions (memo Maps, counters):
each state cell must move with its region, never be duplicated.

**Ordering constraint / #2710:** the late-import suite region
(`addUnionImports`, `addStringImports`, the in-place `shiftFuncIndices`
blocks) is exactly what #2710 (late-bind module indices, in-progress) is
rewriting. Do NOT move that region while #2710 is in flight — sequence this
issue's region moves so `registry/late-import-suites.ts` lands AFTER #2710's
producer-file slices, or coordinate with the #2710 owner. All other regions
(WASI, extern registry, export emitters, hoist scan, type registry) are safe
to move now.

## Estimated LOC delta

Net ≈ 0 (motion) − duplicate-block dedup opportunities inside the moved
regions (index.ts has 1,594 lines inside duplicated 8-line windows — the
`emitClosureCallExport{1,2,3,4}` family and getter/setter emitters are
near-copies) ≈ **−400 to −800** in follow-ups. `index.ts` 16,566 → ~2,700.

## Acceptance criteria

1. `prove-emit-identity check` IDENTICAL after every region-move commit.
2. `index.ts` < 3,000 LOC; no new module > 4,000 LOC.
3. All moved names re-exported from `codegen/index.ts` for one cycle
   (`@deprecated` JSDoc pointing at the new home).
4. test262 CI: no regression.
5. #3102 baseline updated (if landed).

## Progress — Slice 1 (dev-l, recovered + landed by dev-k, 2026-07-17)

**Landed:** first bounded, byte-identical slice — the 5 whole-program AST
pre-scan predicates lifted verbatim out of `src/codegen/index.ts` into a new
sibling module `src/codegen/source-scan-predicates.ts`.

| New module | Extracted | Wiring |
| --- | --- | --- |
| `src/codegen/source-scan-predicates.ts` | `sourceContainsClass`, `sourceContainsDelete`, `sourceHasDynamicTaConstruct`, `sourceContainsBindingPattern`, `sourceOverridesArrayIterator` | imported back into `index.ts`; `sourceOverridesArrayIterator` also re-exported (external consumer `tests/issue-1719-s1.test.ts`) |

`index.ts` shrinks by 235 lines (block 426-659 removed). These predicates are
pure, cheap `ts.SourceFile` walks with **no dependency on `CodegenContext`** —
they only import `ts`/`forEachChild` and `TYPED_ARRAY_NAMES`. The
`index.ts ⇄ source-scan-predicates` import edge is load-safe (predicates run only
at codegen time, never at module init).

**Safety (REFACTOR — zero behavior change):** bodies moved verbatim. `tsc
--noEmit`: clean. `check:loc-budget`: green. Targeted vitest
(`issue-1719-s1`, `issue-1364b-class-method-delete`): 21/21 passed.
