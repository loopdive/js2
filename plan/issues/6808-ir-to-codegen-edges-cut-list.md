---
id: 6808
title: "arch: cut the 74 ir → codegen value-import edges (cut list for #6797 item 2) — shared constants to src/shared/, helpers to src/backend/wasmgc/, legacy-pipeline calls behind IrBackend"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: compiler-architecture
parent: 6797
related: [3113, 6797]
requested_by: ttraenkler/claude-dev-6797
origin: "#6797 item 2 — the follow-up slice issue its Correction asks for"
---

# #6808 — cut list: the 74 ir → codegen value-import edges

## Problem

The IR is meant to replace the legacy AST→Wasm path
(`docs/architecture/codegen-axes.md`), but `src/ir/` has 74 file-level VALUE
imports of `src/codegen/` (measured 2026-10-02 by
`pnpm run check:import-cycles -- --verbose`, #6797). They are what welds
codegen, ir and frontend into one 697-file import cycle: as long as one IR
file imports codegen and codegen imports the IR, no layer can be removed on
its own. `scripts/import-cycles-baseline.json` tracks the count as
`twoWayDirEdges["ir->codegen"]`; the acceptance criterion of #6797 is that it
reaches 0. (`check:ir-layering`, #3113, counts the same boundary per import
LINE and includes `import type`; it measured 87 lines on 2026-10-02.)

## The edges, grouped by remedy

Each line: importer → imported (the value names imported). The grouping is a
first classification from the imported names; whoever takes a slice checks it
against the code before moving anything. Owners are assigned at dispatch
(`claim-issue.mjs`), one slice per owner.

### A. Shared vocabulary → `src/shared/` (9 edges)

Constants, naming functions and pure AST analysis — no Wasm emission. Moving
them below both layers is mechanical.

- `ir/backend/linear-integration.ts` → `codegen/fmod.ts` (FMOD_FN, FMOD_EARLY_MAGNITUDE_FN)
- `ir/fmod-selection.ts` → `codegen/fmod.ts` (FMOD_FN, FMOD_EARLY_MAGNITUDE_FN)
- `ir/from-ast.ts` → `codegen/dyn-ops.ts` (the eight IR_DYN_*_FN names)
- `ir/from-ast.ts` → `codegen/ir-native-map.ts` (IR_NATIVE_MAP_GET_NUM_FN, IR_NATIVE_MAP_NEW_FN, IR_NATIVE_MAP_SET_NUM_FN)
- `ir/from-ast.ts` → `codegen/statements/control-flow.ts` (evaluateConstantCondition)
- `ir/i32-pure-bitwise.ts` → `codegen/function-body.ts` (collectI32CoercedLocals)
- `ir/integration.ts` → `codegen/class-member-keys.ts` (classMemberFuncKey)
- `ir/integration.ts` → `codegen/ir-inline.ts` (parseInlineOptions)
- `ir/prepared-vector-support.ts` → `codegen/vec-access-exports.ts` (VEC_HOST_BRIDGE_ROLE, vecHostBridgeMaterializerOrdinal)

### B. Helpers both layers need → `src/backend/wasmgc/` (53 edges)

Type registration, function-index-space bookkeeping and `ensure*` Wasm
runtime emitters. `codegen/func-space.ts` alone is the target of 9 edges and
`codegen/registry/types.ts` of 3, so moving those two first removes 12.

- `ir/closure-struct-registry.ts` → `codegen/closures/funcref-wrapper-types.ts` (CLOSURE_CAPTURE_FIELD_BASE, getOrCreateFuncRefWrapperTypes)
- `ir/closure-struct-registry.ts` → `codegen/standalone-dom-callback-authority.ts` (resolveStandaloneDomCallbackClosureSubtype)
- `ir/compiler-timer-shim-preparation.ts` → `codegen/any-helpers.ts` (resolveIrDynamicCarrierType)
- `ir/compiler-timer-shim-preparation.ts` → `codegen/func-space.ts` (definedFuncAt, funcSignatureOf, isImportFuncIdx)
- `ir/compiler-timer-shim-preparation.ts` → `codegen/tonumber-fast-paths.ts` (prepareStandaloneExternrefToNumberProviders)
- `ir/dynamic-number-lowering.ts` → `codegen/coercion-engine.ts` (emitToNumber)
- `ir/dynamic-number-lowering.ts` → `codegen/tonumber-fast-paths.ts` (tryEmitFastToNumber)
- `ir/integration.ts` → `codegen/any-helpers.ts` (ensureAnyHelpers, ensureAnyValueType, ensureExternLooseEqHelper, ensureExternStrictEqHelper, resolveIrDynamicCarrierType)
- `ir/integration.ts` → `codegen/async-scheduler.ts` (getOrRegisterPromiseType, isStandalonePromiseActive)
- `ir/integration.ts` → `codegen/char-code-at-helpers.ts` (five ensure*CharCodeAt*/Substring helpers and six *_FN names)
- `ir/integration.ts` → `codegen/closures/funcref-wrapper-types.ts` (getFuncRefWrapperRootTypeIdx)
- `ir/integration.ts` → `codegen/coercion-engine.ts` (emitToBoolean)
- `ir/integration.ts` → `codegen/dyn-ops.ts` (ensureIrDynamicRuntime, plus the IR_DYN_*_FN names from group A)
- `ir/integration.ts` → `codegen/dyn-read.ts` (ensureDynMemberGet, ensureDynMemberSet)
- `ir/integration.ts` → `codegen/expressions/builtins.ts` (ensureDateCivilHelper)
- `ir/integration.ts` → `codegen/fmod.ts` (ensureFmodIntrinsic, isFmodIntrinsic)
- `ir/integration.ts` → `codegen/func-space.ts` (definedFuncAt, definedFuncHandleOf, nativeStrHelperHandle, replaceDefinedFuncAt)
- `ir/integration.ts` → `codegen/function-prototype-callable.ts` (ensureFunctionPrototypeCallHelper, FUNCTION_PROTOTYPE_CALL_HELPER)
- `ir/integration.ts` → `codegen/hof-native.ts` (ensureHoleyArrayFilter)
- `ir/integration.ts` → `codegen/ir-host-string-repeat.ts` (ensureIrHostStringRepeatProvider, hasExactIrStringRepeatProviderAbi)
- `ir/integration.ts` → `codegen/ir-native-async-runtime.ts` (ensureIrNativePromiseAllProvider)
- `ir/integration.ts` → `codegen/ir-native-map.ts` (ensureIrNativeMapAdapters, plus the IR_NATIVE_MAP_*_FN names from group A)
- `ir/integration.ts` → `codegen/ir-native-promise-delay.ts` (ensureIrNativePromiseDelayProvider)
- `ir/integration.ts` → `codegen/ir-native-string-repeat.ts` (ensureIrNativeCountedStringRepeatProvider, ensureIrNativeStringRepeatProvider, hasExactIrNativeCountedStringRepeatProviderAbi)
- `ir/integration.ts` → `codegen/map-runtime.ts` (ensureMapHelpers)
- `ir/integration.ts` → `codegen/native-batched-concat.ts` (ensureNativeBatchedConcat)
- `ir/integration.ts` → `codegen/native-string-literals.ts` (nativeStringLiteralMaterialization, nativeStringLiteralInstrs)
- `ir/integration.ts` → `codegen/native-strings.ts` (ensureNativeStringHelpers, standaloneConsoleSinkAvailable, STANDALONE_STDOUT_APPEND_FN)
- `ir/integration.ts` → `codegen/number-format-native.ts` (ensureIrNativeNumberToString, irNativeNumberToFixedAvailable, irNativeNumberToStringAvailable)
- `ir/integration.ts` → `codegen/object-runtime.ts` (ensureObjectRuntime)
- `ir/integration.ts` → `codegen/regexp-standalone.ts` (ensureStandaloneRegExpCarrierTestHelper)
- `ir/integration.ts` → `codegen/registry/error-types.ts` (emitWasiErrorConstructor)
- `ir/integration.ts` → `codegen/registry/imports.ts` (addStringConstantGlobal, ensureExnTag, localGlobalIdx)
- `ir/integration.ts` → `codegen/registry/types.ts` (addFuncType, getArrTypeIdxFromVec, getOrRegisterHoleyArrayType, getOrRegisterRefCellType, getOrRegisterVecType)
- `ir/integration.ts` → `codegen/shared.ts` (ensureLateImport, flushLateImportShifts)
- `ir/integration.ts` → `codegen/standalone-clock-capability.ts` (ensureStandaloneClockCapabilityImport, standaloneClockCapabilityImport)
- `ir/integration.ts` → `codegen/standalone-wrapper-instanceof.ts` (ensureStandaloneWrapperInstanceOfHelper)
- `ir/integration.ts` → `codegen/value-tags.ts` (boxToAny)
- `ir/integration.ts` → `codegen/vec-elem-set.ts` (ensureHoleyArrayNew, ensureVecElemSet, ensureVecElemSetForElement, ensureVecNewSized, ensureVecNewSizedForElement, VEC_ELEM_SET_PREFIX, VEC_NEW_SIZED_PREFIX)
- `ir/math-runtime-providers.ts` → `codegen/func-space.ts` (definedFuncAt)
- `ir/math-runtime-providers.ts` → `codegen/math-helpers.ts` (emitInlineMathFunctions)
- `ir/number-to-string-provider.ts` → `codegen/func-space.ts` (mintDefinedFunc, pushDefinedFunc)
- `ir/number-to-string-provider.ts` → `codegen/native-strings.ts` (ensureNativeStringHelpers)
- `ir/number-to-string-provider.ts` → `codegen/number-format-native.ts` (emitNativeNumberFormat, irNativeNumberToFixedAvailable)
- `ir/number-to-string-provider.ts` → `codegen/registry/types.ts` (addFuncType)
- `ir/number-to-string-provider.ts` → `codegen/shared.ts` (ensureLateImport)
- `ir/prepared-callable-resolution.ts` → `codegen/func-space.ts` (definedFuncAt, definedFuncHandleOf)
- `ir/prepared-closure-support.ts` → `codegen/closures/funcref-wrapper-types.ts` (getFuncRefWrapperRootTypeIdx)
- `ir/prepared-closure-support.ts` → `codegen/func-space.ts` (mintDefinedFunc, pushDefinedFunc)
- `ir/prepared-closure-support.ts` → `codegen/registry/types.ts` (addFuncType)
- `ir/prepared-component-sealing.ts` → `codegen/func-space.ts` (definedFuncAt)
- `ir/prepared-vector-support.ts` → `codegen/func-space.ts` (definedFuncAt)
- `ir/prepared-vector-support.ts` → `codegen/type-coercion.ts` (buildVecFromExternMaterializer, vecFromExternFuncIdx)

Some of these targets (`ir-native-*`, `ir-host-string-repeat`) are IR
lowering that only lives in `codegen/`; moving them into `src/ir/` itself
removes the edge just as well. Either way the target file's own imports
decide whether it can move: a helper that still imports codegen internals
moves the cycle instead of cutting it, which `check:import-cycles` reports.

### C. Calls back into the legacy pipeline → inject through `IrBackend` (12 edges)

The IR asks the legacy driver to plan or lower something. These need the
dependency inverted: the codegen side hands the capability to the IR through
the `IrBackend` interface instead of the IR importing it.

- `ir/integration.ts` → `codegen/index.ts` (addForInImports, addGeneratorImports, addIteratorImports, addStringImports, addUnionImports, TYPED_ARRAY_NAMES)
- `ir/integration.ts` → `codegen/async-ir-planning.ts` (preparedIrAsyncFromAstResolver)
- `ir/integration.ts` → `codegen/ir-async-frame.ts` (lowerPreparedIrAsyncFunction)
- `ir/integration.ts` → `codegen/ir-async-runtime-adapters.ts` (materializePreparedAsyncHostAdapters)
- `ir/integration.ts` → `codegen/ir-tail-call.ts` (applyIrTailCalls)
- `ir/integration.ts` → `codegen/multi-source-ir-integration.ts` (collectIntegrationFunctionDeclarations, makeMultiSourceOverrideResolvers, resolveIntegrationSourceFiles)
- `ir/integration.ts` → `codegen/program-abi-declared-globals.ts` (programAbiModuleDeclarations)
- `ir/integration.ts` → `codegen/program-abi-import-planning.ts` (catalogProgramAbiCallableImports, programAbiStringConstantRef)
- `ir/integration.ts` → `codegen/program-abi-planning.ts` (planProgramAbiGlobal, planProgramAbiSupportCallable, planProgramAbiSupportCallableAlias, PROGRAM_ABI_CALLABLE_ROLE, PROGRAM_ABI_GLOBAL_ROLE)
- `ir/prepared-callable-resolution.ts` → `codegen/program-abi-planning.ts` (planProgramAbiUnitCallable)
- `ir/prepared-component-sealing.ts` → `codegen/program-abi-planning.ts` (planProgramAbiUnitCallable)
- `ir/prepared-vector-support.ts` → `codegen/program-abi-planning.ts` (planProgramAbiEntrySourceSupportCallable, PROGRAM_ABI_CALLABLE_ROLE)

## Suggested slices

1. **S1 — group A** (9 edges): move the constants and pure helpers to
   `src/shared/`, re-exporting from the old module only where codegen still
   needs the old path.
2. **S2 — `func-space.ts` and `registry/types.ts`** (12 edges of group B),
   if their own imports allow it.
3. **S3 — `program-abi-planning.ts` behind `IrBackend`** (4 edges of group C).
4. **S4 — the rest of `ir/integration.ts`** (43 of the 74 edges start in that
   one file) — overlaps the #3113 S3 containment of `integration.ts`; run
   `node scripts/pre-dispatch-gate.mjs 3113` before starting.

## Acceptance

- `twoWayDirEdges["ir->codegen"]` in `scripts/import-cycles-baseline.json`
  reaches 0 (each slice lowers it; the post-merge job banks the drop).
- No slice raises `largestSccSize`, `sccCountOver1` or any other
  `twoWayDirEdges` entry (`pnpm run check:import-cycles` stays green without
  `--update`).
