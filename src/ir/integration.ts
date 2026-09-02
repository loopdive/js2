// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Integration point between the legacy codegen pipeline and the IR path.
//
// `compileIrPathFunctions` runs after `compileDeclarations`. It now runs in
// three explicit phases — driven by spec #1167b, which added module-scope
// inlining that requires seeing every IR function at once before any of
// them lower to Wasm:
//
//   1. Build — lower every selected AST function to an `IrFunction` and
//      collect them into an `IrModule`.
//   2. Pass — run per-function hygiene (CF → DCE → simplifyCFG), then
//      module-scope inlining (`inlineSmall`), then re-run hygiene on any
//      modified function. Each stage verifies.
//   3. Lower — replace each selected function's entry in `ctx.mod.functions`
//      with the Wasm body produced by `lowerIrFunctionToWasm`, keeping the
//      pre-allocated funcIdx/typeIdx/export state intact so the legacy
//      late-repair passes see a consistent module.
//
// Because the IR lowerer resolves IrFuncRef/IrGlobalRef symbols at this
// integration point (AFTER all imports have been registered), the legacy
// `shiftLateImportIndices` pass is a no-op for every body produced here.
// That's the whole point of the symbolic-ref design — spec #1131 §1.2.

import { ts } from "../ts-api.js";
import type { IrIntegrationOptions } from "./integration-options.js";
export type { IrIntegrationOptions } from "./integration-options.js";
import { acceptsStaticNumericArrayParam, staticNumericArrayGlobalMatches } from "./select-vector-slots.js";
import { makeIrHostDateSnapshotResolver } from "./host-date.js";
import { ClosureStructRegistry } from "./closure-struct-registry.js";
import { irTypeKey } from "./type-key.js";
export { irTypeKey } from "./type-key.js";
import {
  ensureStandaloneClockCapabilityImport,
  standaloneClockCapabilityImport,
} from "../codegen/standalone-clock-capability.js";
import { makeCalendarIrSelectionSupport } from "./calendar-selection-support.js";
import { makeIrStandaloneDomCapabilityPlan, type IrStandaloneDomCapabilityPlan } from "./dom-capability.js";
import {
  projectIrBackendTargetProfile,
  supportsIrBackendTargetCapability,
  type IrBackendTargetCapability,
} from "./backend/legality.js";

import {
  ensureAnyHelpers,
  ensureAnyValueType,
  ensureExternLooseEqHelper,
  ensureExternStrictEqHelper,
  resolveIrDynamicCarrierType,
} from "../codegen/any-helpers.js"; // (#2949) boxed-any carrier for IrType.dynamic
import { ensureDynMemberGet, ensureDynMemberSet } from "../codegen/dyn-read.js"; // (#3053 U1) / (#3795)
import { ensureDateCivilHelper } from "../codegen/expressions/builtins.js";
import {
  ensureIrDynamicRuntime,
  IR_DYN_ADD_FN,
  IR_DYN_GE_FN,
  IR_DYN_GT_FN,
  IR_DYN_LE_FN,
  IR_DYN_LT_FN,
  IR_DYN_METHOD_CALL_0_FN,
  IR_DYN_METHOD_CALL_1_FN,
  IR_DYN_STRING_REPLACE_FN,
  type IrDynamicRuntimeNeed,
} from "../codegen/dyn-ops.js";
import { ensureLateImport, flushLateImportShifts } from "../codegen/shared.js"; // (#2949 S5.2) host __host_eq / __host_loose_eq registration; (#3143) flush the __extern_is_undefined batch pre-Phase-3
import { getOrRegisterPromiseType, isStandalonePromiseActive } from "../codegen/async-scheduler.js";
import {
  addGeneratorImports,
  addForInImports,
  addIteratorImports,
  addStringImports,
  addUnionImports, // (#2949 slice 3) host-mode dynamic op imports (__box_number/__typeof_* family)
  TYPED_ARRAY_NAMES,
} from "../codegen/index.js";
import { ensureObjectRuntime } from "../codegen/object-runtime.js";
import { ensureMapHelpers } from "../codegen/map-runtime.js"; // (#4461) native $Map module-binding storage
import {
  ensureIrNativeMapAdapters,
  IR_NATIVE_MAP_GET_NUM_FN,
  IR_NATIVE_MAP_NEW_FN,
  IR_NATIVE_MAP_SET_NUM_FN,
} from "../codegen/ir-native-map.js"; // (#4461) externref-ABI adapters over the $Map helpers
import { ensureIrNativePromiseDelayProvider } from "../codegen/ir-native-promise-delay.js";
import { ensureIrNativePromiseAllProvider } from "../codegen/ir-native-async-runtime.js";
import {
  ensureIrNativeCountedStringRepeatProvider,
  ensureIrNativeStringRepeatProvider,
  hasExactIrNativeCountedStringRepeatProviderAbi,
} from "../codegen/ir-native-string-repeat.js";
import {
  ensureIrHostStringRepeatProvider,
  hasExactIrStringRepeatProviderAbi,
} from "../codegen/ir-host-string-repeat.js";
import {
  ensureStandaloneWrapperInstanceOfHelper,
  type StandaloneWrapperConstructorName,
} from "../codegen/standalone-wrapper-instanceof.js";
import {
  ensureFunctionPrototypeCallHelper,
  FUNCTION_PROTOTYPE_CALL_HELPER,
} from "../codegen/function-prototype-callable.js";
import { boxToAny } from "../codegen/value-tags.js"; // (#2949 slice 3) THE canonical boxing entry point (D4)
// (#2949 S5.1) THE canonical ToBoolean engine — one truthiness path for legacy and IR (D4).
import { emitToBoolean as emitCoercionToBoolean } from "../codegen/coercion-engine.js";
import { JsTag, jsTagUnboxKind } from "./js-tag.js";
import {
  ensureHoleyArrayNew,
  ensureVecElemSet,
  ensureVecElemSetForElement,
  ensureVecNewSized,
  ensureVecNewSizedForElement,
  VEC_ELEM_SET_PREFIX,
  VEC_NEW_SIZED_PREFIX,
} from "../codegen/vec-elem-set.js"; // (#2856 C2) on-demand vec helpers
import { ensureHoleyArrayFilter } from "../codegen/hof-native.js";
import { getOrRegisterHoleyArrayType } from "../codegen/registry/types.js";
import { classMemberFuncKey } from "../codegen/class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import {
  ensureNativeStringHelpers,
  standaloneConsoleSinkAvailable,
  STANDALONE_STDOUT_APPEND_FN,
} from "../codegen/native-strings.js";
import { ensureNativeBatchedConcat } from "../codegen/native-batched-concat.js";
import {
  nativeStringLiteralMaterialization,
  nativeStringLiteralInstrs,
  type NativeStringLiteralMaterialization,
  type StringEncoding,
} from "../codegen/native-string-literals.js";
import { STANDALONE_REGEXP_CARRIER_TEST_HELPER } from "./regexp-runtime-contract.js";
import { ensureStandaloneRegExpCarrierTestHelper } from "../codegen/regexp-standalone.js";
import { addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../codegen/registry/imports.js";
import { emitWasiErrorConstructor } from "../codegen/registry/error-types.js";
import {
  planProgramAbiSupportCallableAlias,
  planProgramAbiSupportCallable,
  planProgramAbiGlobal,
  PROGRAM_ABI_CALLABLE_ROLE,
  PROGRAM_ABI_GLOBAL_ROLE,
} from "../codegen/program-abi-planning.js";
import {
  catalogProgramAbiCallableImports,
  programAbiStringConstantRef,
} from "../codegen/program-abi-import-planning.js";
// (#2856) Console-variant parity with the legacy collectConsoleImports scan.
import { isBooleanType, isNumberType, isStringType } from "../checker/type-mapper.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
} from "../codegen/registry/types.js";
import type { CodegenContext, FunctionContext } from "../codegen/context/types.js";
import { applyIrTailCalls } from "../codegen/ir-tail-call.js";
import { parseInlineOptions } from "../codegen/ir-inline.js";
import { lowerPreparedIrAsyncFunction } from "../codegen/ir-async-frame.js";
import { preparedIrAsyncFromAstResolver } from "../codegen/async-ir-planning.js";
import { getFuncRefWrapperRootTypeIdx } from "../codegen/closures/funcref-wrapper-types.js";
import { ensureFmodIntrinsic, isFmodIntrinsic } from "../codegen/fmod.js"; // #2945 — on-demand `%` helper materialization
import {
  ensureIrNativeNumberToString,
  irNativeNumberToFixedAvailable,
  irNativeNumberToStringAvailable,
} from "../codegen/number-format-native.js"; // #4462 — host-free Number formatting for the IR string carrier
import { IR_CONSOLE_SINK_APPEND_FN, IR_NUMBER_TO_STRING_NATIVE_FN } from "./host-free-runtime.js";
import { IR_NATIVE_PROMISE_DELAY_FN } from "./promise-delay-lowering.js";
import {
  ensureHostCharCodeAtGuarded,
  ensureHostCharCodeAtTrusted,
  ensureHostSubstringGuarded,
  ensureNativeCharCodeAtHelper,
  ensureNativeFlatCharCodeAtHelper,
  JSSTR_CHARCODEAT_FN,
  JSSTR_CHARCODEAT_TRUSTED_FN,
  JSSTR_SUBSTRING_FN,
  NATIVE_CHARCODEAT_FN,
  NATIVE_FLAT_CHARCODEAT_FN,
  NATIVE_FLATTEN_FN,
} from "../codegen/char-code-at-helpers.js";
import {
  IR_STRING_COMPARE_FN,
  lowerFunctionAstToIr,
  lowerImplicitConstructorAstToIr,
  STRING_METHOD_TABLE,
  type AstToIrOptions,
  type IrFromAstResolver,
  type LoweredFunctionResult,
  type ModuleBindingGlobal,
} from "./from-ast.js";
import { collectIrClassInstanceInitializers } from "./class-instance-initializers.js";
import { prepareSuspendingIrFunction } from "./async-prepare.js";
import { parseIrDateSnapshotGetter } from "./date-runtime.js";
import {
  collectIrDirectCallLoweringPlans,
  collectIrDirectCallLoweringPlansByIdentity,
  irDirectCallLoweringPlanEquals,
  type IrDirectCallLoweringPlan,
  type IrDirectCallTarget,
  type IrFnctorParameterPreselectionPlan,
  type IrIntegrationLoweringPlans,
  type IrCountedStringAppendLoweringPlan,
  type PreparedCountedStringAppendReceipt,
} from "./ast-lowering-plans.js";
import {
  associateFinalIrCountedStringAppendSites,
  collectFinalIrCountedStringAppendInstructions,
  requireValidPreparedCountedStringAppendReceipt,
} from "./counted-string-append-provenance.js";
import {
  irGlobalBindingKey,
  irSourceGlobalRef,
  irSupportGlobalRef,
  irSupportTypeRef,
  irTypeBindingKey,
} from "./abi-bindings.js";
import {
  irCallableBindingKey,
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "./callable-bindings.js";
import {
  buildIrUnitInventory,
  indexIrTerminalDeclarations,
  type IrBindingId,
  type IrClassId,
  type IrUnitInventory,
  type IrUnitId,
} from "./identity.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import {
  buildIrPlanningIdentityContext,
  buildIrLegacyUnitProjection,
  type IrLegacyUnitProjectionEntry,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import { validateIrIntegrationPopulation } from "./integration-identity.js";
import {
  preparedUnitProgramAbiBinding,
  resolvePreparedSupportCallable,
  resolvePreparedUnitCallable,
  settlePreparedDerivedCallable,
  type PreparedIrUnitCallableSlot,
} from "./prepared-callable-resolution.js";
export { exactPreparedUnitCallableBindingId } from "./prepared-callable-resolution.js";
import { prepareIrVectorSupport } from "./prepared-vector-support.js";
import {
  makeIrArrayExpressionPredicate,
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrModuleBindingResolver,
  makeIrPrimitiveExpressionClassifier,
  makeIrRegExpExpressionPredicate,
  type IrLegacyModuleBindingIdentity,
  type IrLegacyModuleBindingResolver,
  type IrFnctorArrayMethodPlan,
  type IrModuleBindingIdentity,
  type IrModuleBindingResolver,
  type IrRetainedFunctionMethodPlan,
  type IrStaticNumericArrayPlan,
  type IrStaticRegExpTestPlan,
} from "./module-bindings.js";
import {
  lowerIrFunctionToWasm,
  lowerIrTypeToValType,
  type IrClassLowering,
  type IrClosureLowering,
  type IrDynamicLowering,
  type IrFnctorLowering,
  type IrLowerResolver,
  type IrObjectStructLowering,
  type IrRefCellLowering,
  type IrUnionLowering,
} from "./lower.js";
import {
  asVal,
  forEachInstrDeep, // (#2949 slice 3) deep instr walk for preregisterDynamicSupport
  irDynamic,
  irVal,
  irTypeEquals,
  mapNestedBuffers,
  type IrClassMemberKind,
  type IrClassShape,
  type IrClosureSignature,
  type IrDomCallbackAuthority,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrInstrStringConst,
  type IrModule,
  type IrObjectShape,
  type IrStringLengthProvider,
  type IrType,
  type IrTypeRef,
  type IrValueId,
} from "./nodes.js";
import { analyzeEscape } from "./analysis/escape.js";
import { analyzeOwnership } from "./analysis/ownership.js";
import { constantFold } from "./passes/constant-fold.js";
import { deadCode } from "./passes/dead-code.js";
import { batchStringConcat } from "./passes/batch-string-concat.js";
import { inlineSmall } from "./passes/inline-small.js";
import { monomorphize } from "./passes/monomorphize.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { gvnFromEnv } from "./passes/gvn.js"; // #4424
import { UnionStructRegistry } from "./passes/tagged-union-types.js";
import { runTaggedUnions } from "./passes/tagged-unions.js";
import type { IrFnctorShape } from "./fnctor-abi.js";
import {
  collectModuleInitPopulation,
  makeModuleInitSynthetic,
  MODULE_INIT_UNIT_NAME,
  planIrCompilation,
  type IrSelection,
} from "./select.js";
import { verifyIrFunction } from "./verify.js";
import { programAbiModuleDeclarations } from "../codegen/program-abi-declared-globals.js";
import {
  prepareIrRuntimeManifest,
  preparedGeneratorNumberBoxProvider,
  preparedStringCharCodeAtProvider,
  preparedStringCompareProvider,
  preparedStringConcatProvider,
  preparedStringEqProvider,
  preparedStringLenProvider,
  type PreparedIrRuntimeManifest,
} from "./intrinsic-support.js";
import { attachIrExternSupport } from "./extern-support.js";
import {
  attachIrGeneratorSupport,
  collectAttachedGeneratorProviders,
  irGeneratorNumberBoxDemand,
} from "./generator-support.js";
import {
  isIntrinsicId,
  type BooleanBoundaryIntrinsicId,
  type ExternBoundaryIntrinsicId,
  type IntrinsicId,
  type NumberBoundaryIntrinsicId,
} from "./intrinsics.js";
import { materializePreparedMathProviders, preparedMathProviderIndex } from "./math-runtime-providers.js";
import { materializePreparedAsyncHostAdapters } from "../codegen/ir-async-runtime-adapters.js";
import type {
  BooleanBoundaryPolicy,
  ExternIsUndefinedPolicy,
  GeneratorNumberBoxPolicy,
  NumberBoundaryPolicy,
  RuntimeProviderPlan,
  StringCharCodeAtPolicy,
  StringComparePolicy,
  StringConcatPolicy,
  StringEqPolicy,
  StringLenPolicy,
} from "./runtime-manifest.js";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "./alloc-registry.js";
import { analyzeEncoding } from "./analysis/encoding.js";
import { assertAllocProvenance, assertFinalAllocProvenance } from "./verify-alloc.js";
import type { FieldDef, FuncTypeDef, GlobalDef, Import, Instr, StructTypeDef, ValType, WasmFunction } from "./types.js";
import {
  collectIntegrationFunctionDeclarations,
  definedFuncAt,
  definedFuncHandleOf,
  makeMultiSourceOverrideResolvers,
  nativeStrHelperHandle,
  replaceDefinedFuncAt,
  resolveIntegrationSourceFiles,
} from "../codegen/func-space.js"; // (#1916 S2) positional read/write chokepoints
// (#4467) per-lane §7.1.17 Number::toString provider (host import / native thunk)
import {
  ensureIrNumberToFixedProvider,
  ensureIrNumberToStringProvider,
  IR_NUMBER_TO_FIXED_FN,
  IR_NUMBER_TO_STRING_FN,
} from "./number-to-string-provider.js";
import {
  classifyIrFailure,
  IrInvariantError,
  IrUnsupportedError,
  type IrInvariantCode,
  type IrPreparationFailure,
  type IrPreparationStage,
} from "./outcomes.js";
import {
  buildIrIntegrationReport,
  caughtIntegrationFailure,
  integrationFailure,
  IrIntegrationFailureLog,
  type IrIntegrationCompiledArtifactEvidence,
  type IrIntegrationError,
  type IrIntegrationReport,
  type IrIntegrationTerminalFailureEvent,
} from "./integration-report.js";
import {
  allocatePreparedDerivedCallableSlots,
  lowerPreparedClosureSupportType,
  prepareDependencyCompleteClosureSupport,
  type PreparedDerivedCallableSlot,
} from "./prepared-closure-support.js";
import type { PreparedClassAccessorWritebackEvidence } from "./prepared-component-dependencies.js";
import type {
  PreparedComponentOpenScope,
  PreparedComponentScopeLookup,
  PreparedComponentSealFailureHandler,
} from "./prepared-component-sealing.js";
import {
  createPendingPreparedProgramComponentReceipt,
  type PendingPreparedProgramComponentReceipt,
  type PreparedComponentDetachedPatch,
} from "./prepared-component-publication.js";
import {
  createCompilerTimerShimLoweringBoundary,
  prepareCompilerTimerShimLateSealTransaction,
} from "./compiler-timer-shim-preparation.js";
import { emitExternrefDynamicToNumber } from "./dynamic-number-lowering.js";
import type { PreparedIrPendingPatch } from "./prepared-lowering-patch.js";
import { attachIrStringCarrier } from "./string-carrier.js";
import { attachIrStringLengthProvider, attachIrStringSupport } from "./string-support.js";
import { attachIrPhysicalRefTypeRefs } from "./physical-ref-support.js";
import {
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_PROMISE_ALL_NATIVE_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "./async-semantic-runtime.js";
import {
  IR_HOLEY_ARRAY_ELEM_SET,
  IR_HOLEY_ARRAY_NEW,
  IR_VEC_ELEM_SET_PREFIX,
  IR_VEC_NEW_SIZED_PREFIX,
  parseIrVectorRuntimeElement,
} from "./vector-runtime.js";
import {
  IR_STRING_CHAR_AT_FN,
  IR_STRING_CHAR_CODE_AT_FN,
  IR_STRING_CONCAT_FN,
  parseIrStringConcatManyArity,
  IR_STRING_CONCAT_OWNED_FN,
  IR_STRING_EQUALS_FN,
  IR_STRING_ITERATOR_CHAR_AT_FN,
  IR_STRING_LITERAL_MATERIALIZE_FN,
  IR_STRING_REPEAT_COUNTED_NATIVE_FN,
  IR_STRING_REPEAT_FN,
} from "./string-runtime.js";
export {
  buildIrIntegrationReport,
  caughtIntegrationFailure,
  integrationFailure,
  invariantIntegrationFailure,
  IrIntegrationFailureLog,
  type IrIntegrationCompiledArtifactEvidence,
  type IrIntegrationError,
  type IrIntegrationReport,
  type IrIntegrationTerminalFailureEvent,
  type IrIntegrationTerminalEvidence,
} from "./integration-report.js";

function prepareSuspendingAsyncLowering(
  lowered: LoweredFunctionResult,
  ownerUnitId: IrUnitId,
  name: string,
  suspendingOwners: ReadonlySet<IrUnitId> | undefined,
  numberBoundary: NumberBoundaryPolicy,
): LoweredFunctionResult {
  if (!suspendingOwners?.has(ownerUnitId)) return lowered;
  const prepared = prepareSuspendingIrFunction(lowered.main, numberBoundary);
  if (!prepared) {
    throw new IrUnsupportedError(
      "body-shape-rejected",
      "build",
      `async-plan producer could not split the certified suspending body ${name}`,
    );
  }
  return {
    main: prepared.main,
    lifted: [...lowered.lifted, ...prepared.stateFunctions],
    liftedUnitProvenance: [...lowered.liftedUnitProvenance, ...prepared.provenance],
    ...(lowered.countedStringAppendPlans ? { countedStringAppendPlans: lowered.countedStringAppendPlans } : {}),
  };
}

function isLiftedExecutableRole(role: ProgramAbiDerivedUnitRecord["role"]): boolean {
  return role === "lifted-closure" || role === "ir-async-state";
}

function lowerIrEntryFunction(
  ctx: CodegenContext,
  fn: IrFunction,
  resolver: IrLowerResolver,
  existing: WasmFunction,
): WasmFunction {
  return fn.asyncPlan
    ? lowerPreparedIrAsyncFunction(
        ctx,
        fn,
        {
          resolveFunc: (ref) => resolver.resolveFunc(ref),
          callResultAdapter: (ref) => resolver.callResultAdapter?.(ref),
        },
        existing,
      )
    : lowerIrFunctionToWasm(fn, resolver).func;
}

/**
 * Find checker-certified ambient Date snapshots in owners that have already
 * been selected. Production selection should reject these on host-free
 * targets; this integration guard keeps a stale/external selection from
 * discovering the target gap in helper registration or emission.
 */
function collectSelectedHostDateSnapshotOwners(
  sourceFile: ts.SourceFile,
  selection: IrSelection,
  resolveSnapshot: ReturnType<typeof makeIrHostDateSnapshotResolver>,
): ReadonlySet<string> {
  const owners = new Set<string>();
  const scan = (ownerName: string, root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (owners.has(ownerName)) return;
      if (node !== root && ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node) && resolveSnapshot(node)) {
        owners.add(ownerName);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      selection.funcs.has(statement.name.text)
    ) {
      scan(statement.name.text, statement.body);
    }
  }
  if (selection.moduleInit?.reason === null && selection.moduleInit.stmtCount > 0) {
    for (const statement of collectModuleInitPopulation(sourceFile)) {
      scan(MODULE_INIT_UNIT_NAME, statement);
    }
  }
  return owners;
}

/**
 * Per-function IR type overrides sourced from the Phase-2 propagation
 * pass. Indexed by function name. When present for a selected function,
 * these types are used in place of (or alongside) any explicit TS
 * annotations. They are also used to derive the `calleeTypes` map that
 * the AST→IR lowerer consults when lowering `CallExpression`.
 */
export interface IrTypeOverrideMap {
  // Slice 14 (#1228) — `returnType: IrType | null` where `null` means a
  // void-returning function (zero Wasm result types). Plumbs through to
  // `from-ast.ts` so the IR builder can be constructed with `[]` results.
  get(name: string): { readonly params: readonly IrType[]; readonly returnType: IrType | null } | undefined;
}

interface BuiltFn {
  /** Exact pass-created/source artifact identity. */
  readonly artifactUnitId: IrUnitId;
  /** Exact R0 terminal owner; labels below are compatibility metadata only. */
  readonly terminalOwnerUnitId: IrUnitId;
  readonly name: string;
  /** Public/legacy terminal-owner label; synthesized artifacts never become rows. */
  readonly ownerName: string;
  readonly fn: IrFunction;
  readonly countedStringAppendPlans?: readonly IrCountedStringAppendLoweringPlan[];
  /** Complete Program ABI provenance when this artifact was lifted from a source unit. */
  readonly derivedUnit?: ProgramAbiDerivedUnitRecord;
  /** True when a pass-created artifact owns a fresh callable slot. */
  readonly synthesized?: boolean;
  /** True when the artifact patches a preallocated class-member slot. */
  readonly classMember?: boolean;
  /** True when the artifact patches the exact module-initializer slot. */
  readonly moduleInit?: boolean;
}

interface PreparedClosureTransaction {
  readonly registry: ClosureStructRegistry;
  readonly refCells: RefCellRegistry;
  readonly freshSlots: readonly PreparedDerivedCallableSlot[];
  readonly componentIds: ReadonlyMap<IrUnitId, string>;
  readonly openScopes: readonly PreparedComponentOpenScope[];
  readonly preparedScopeLookup?: PreparedComponentScopeLookup;
  readonly abortOpenScopes: () => void;
  sealCompilerTimerShim(): void;
  bindLowerResolver(resolver: IrLowerResolver): void;
}

function exactAccessorWritebackGlobals(
  instrs: readonly IrInstr[],
  valueParam: IrValueId,
): { readonly valueGlobalBindingId: IrBindingId; readonly tdzGlobalBindingId?: IrBindingId } | undefined {
  const write = instrs.at(-1);
  if (write?.kind !== "global.set" || write.target.binding.kind !== "source" || write.value !== valueParam) {
    return undefined;
  }
  const valueGlobalBindingId = write.target.binding.bindingId;
  if (instrs.length === 1) return { valueGlobalBindingId };
  if (instrs.length !== 4) return undefined;
  const [tdzRead, tdzMissing, guard] = instrs;
  if (
    tdzRead?.kind !== "global.get" ||
    tdzRead.target.binding.kind !== "source" ||
    tdzRead.target.binding.bindingId === valueGlobalBindingId ||
    tdzRead.result === null ||
    asVal(tdzRead.resultType!)?.kind !== "i32" ||
    tdzMissing?.kind !== "unary" ||
    tdzMissing.op !== "i32.eqz" ||
    tdzMissing.rand !== tdzRead.result ||
    tdzMissing.result === null ||
    asVal(tdzMissing.resultType!)?.kind !== "i32" ||
    guard?.kind !== "if.stmt" ||
    guard.cond !== tdzMissing.result ||
    guard.else.length !== 0 ||
    guard.then.length !== 3
  ) {
    return undefined;
  }
  const [missingValue, constructError, abrupt] = guard.then;
  if (
    missingValue?.kind !== "const" ||
    missingValue.value.kind !== "null" ||
    asVal(missingValue.value.ty)?.kind !== "externref" ||
    missingValue.result === null ||
    asVal(missingValue.resultType!)?.kind !== "externref" ||
    constructError?.kind !== "call" ||
    constructError.target.binding.kind !== "runtime" ||
    constructError.target.binding.symbol !== "__new_ReferenceError" ||
    constructError.args.length !== 1 ||
    constructError.args[0] !== missingValue.result ||
    constructError.result === null ||
    asVal(constructError.resultType!)?.kind !== "externref" ||
    abrupt?.kind !== "throw" ||
    abrupt.value !== constructError.result
  ) {
    return undefined;
  }
  return {
    valueGlobalBindingId,
    tdzGlobalBindingId: tdzRead.target.binding.bindingId,
  };
}

/**
 * Prove the one dynamic prepared class-member shape without trusting the
 * compatibility label or the original AST: one exact setter terminal, one
 * class-typed dummy/self parameter, one dynamic value parameter, and one
 * unchanged write to a source global before a void return.
 */
function prepareClassAccessorWritebackEvidence(
  ctx: CodegenContext,
  entries: readonly BuiltFn[],
  inventory: IrUnitInventory,
): ReadonlyMap<IrUnitId, PreparedClassAccessorWritebackEvidence> {
  const candidates = new Map<
    IrUnitId,
    { readonly valueGlobalBindingId: IrBindingId; readonly tdzGlobalBindingId?: IrBindingId }
  >();
  const classes = new Set(inventory.classes.map(({ id }) => id));
  for (const entry of entries) {
    const terminal = inventory.terminalUnits.find(({ id }) => id === entry.terminalOwnerUnitId);
    const block = entry.fn.blocks.length === 1 ? entry.fn.blocks[0] : undefined;
    const self = entry.fn.params[0];
    const value = entry.fn.params[1];
    const writeback = block && value ? exactAccessorWritebackGlobals(block.instrs, value.value) : undefined;
    if (
      entry.classMember !== true ||
      entry.derivedUnit !== undefined ||
      entry.artifactUnitId !== entry.terminalOwnerUnitId ||
      !terminal ||
      terminal.observedKind !== "class-member" ||
      (terminal.kind !== "class-instance-setter" && terminal.kind !== "class-static-setter") ||
      terminal.lexicalOwnerId === null ||
      !classes.has(terminal.lexicalOwnerId as IrClassId) ||
      entry.fn.funcKind === "async" ||
      entry.fn.funcKind === "generator" ||
      entry.fn.params.length !== 2 ||
      self?.type.kind !== "class" ||
      self.type.shape.classId !== terminal.lexicalOwnerId ||
      value?.type.kind !== "dynamic" ||
      entry.fn.resultTypes.length !== 0 ||
      entry.fn.asyncPlan !== undefined ||
      entry.fn.asyncRuntime !== undefined ||
      entry.fn.closureSubtype !== undefined ||
      (entry.fn.slots?.length ?? 0) !== 0 ||
      !block ||
      block.blockArgs.length !== 0 ||
      block.blockArgTypes.length !== 0 ||
      block.terminator.kind !== "return" ||
      block.terminator.values.length !== 0 ||
      !writeback
    ) {
      continue;
    }
    candidates.set(entry.terminalOwnerUnitId, writeback);
  }
  if (process.env.JS2WASM_TEST_MUTATE_IR_ACCESSOR_TDZ_VALUE_PAIR === "1") {
    const tdzCandidates = [...candidates].filter(([, evidence]) => evidence.tdzGlobalBindingId !== undefined);
    const first = tdzCandidates[0];
    const second = tdzCandidates[1];
    if (first && second) {
      candidates.set(first[0], { ...first[1], valueGlobalBindingId: second[1].valueGlobalBindingId });
    }
  }
  if (candidates.size === 0 || !ctx.programAbiTypes) return new Map();
  const carrier = ctx.programAbiTypes.prepareDynamicCarrier(resolveIrDynamicCarrierType(ctx));
  const exceptionTagTypeRef = [...candidates.values()].some(
    ({ tdzGlobalBindingId }) => tdzGlobalBindingId !== undefined,
  )
    ? ctx.programAbiTypes.prepareExceptionTagType()
    : undefined;
  return new Map(
    [...candidates].map(([unitId, writeback]) => [
      unitId,
      Object.freeze({
        ...writeback,
        ...(writeback.tdzGlobalBindingId === undefined || exceptionTagTypeRef === undefined
          ? {}
          : { tdzExceptionTagTypeRef: exceptionTagTypeRef }),
        dynamicCarrierRef: carrier.carrierRef,
        dynamicCarrierValueType: carrier.valueType,
      }),
    ]),
  );
}

function prepareClosureTransaction(input: {
  readonly ctx: CodegenContext;
  readonly entries: readonly BuiltFn[];
  readonly originalArtifactUnitIds: ReadonlySet<IrUnitId>;
  readonly inventory: IrUnitInventory;
  readonly atomicTerminalPopulation?: boolean;
  readonly callableImports: ReadonlyMap<string, Import>;
  readonly preparedBindingIdsByTerminalUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
  readonly deferPublication?: boolean;
  readonly preparedModuleCallableAliasDescriptor?: IrIntegrationOptions["preparedModuleCallableAliasDescriptor"];
  readonly onSealFailure: PreparedComponentSealFailureHandler;
}): PreparedClosureTransaction {
  const refCells = new RefCellRegistry(input.ctx);
  let resolveValType: (type: IrType) => ValType = (type) => lowerPreparedClosureSupportType(input.ctx, type, refCells);
  const registry = new ClosureStructRegistry(input.ctx, (type) => resolveValType(type));
  resolveValType = (type) => lowerPreparedClosureSupportType(input.ctx, type, refCells, registry);
  const closureSupport = prepareDependencyCompleteClosureSupport(input.ctx, input.entries, registry, refCells);
  const freshSlots = allocatePreparedDerivedCallableSlots(
    input.ctx,
    input.entries,
    input.originalArtifactUnitIds,
    registry,
  );
  const classAccessorWritebacks = prepareClassAccessorWritebackEvidence(input.ctx, input.entries, input.inventory);
  const timerTransaction = prepareCompilerTimerShimLateSealTransaction({
    ctx: input.ctx,
    entries: input.entries,
    inventory: input.inventory,
    ...(input.atomicTerminalPopulation ? { atomicTerminalPopulation: true } : {}),
    closureSupport,
    classAccessorWritebacks,
    callableImports: input.callableImports,
    ...(input.preparedBindingIdsByTerminalUnitId
      ? { preparedBindingIdsByTerminalUnitId: input.preparedBindingIdsByTerminalUnitId }
      : {}),
    ...(input.deferPublication ? { deferPublication: true as const } : {}),
    ...(input.preparedModuleCallableAliasDescriptor
      ? { preparedModuleCallableAliasDescriptor: input.preparedModuleCallableAliasDescriptor }
      : {}),
    onSealFailure: input.onSealFailure,
  });
  let preparedScopeLookup = timerTransaction.openScopes[0]?.lookup;
  return {
    registry,
    refCells,
    freshSlots,
    componentIds: timerTransaction.componentIds,
    openScopes: timerTransaction.openScopes,
    get preparedScopeLookup() {
      return preparedScopeLookup;
    },
    abortOpenScopes: timerTransaction.abortOpenScopes,
    sealCompilerTimerShim: () => {
      timerTransaction.sealDeferred();
      preparedScopeLookup ??= timerTransaction.openScopes[0]?.lookup;
    },
    bindLowerResolver: (resolver) => {
      resolveValType = (type) => lowerIrTypeToValType(type, resolver, "<closure-registry>");
    },
  };
}

/**
 * (#3526 F1-S1) This caller's already-resolved number-boundary policy.
 *
 * These are the EXACT facts the two from-ast arms used to read through the
 * `hasHostNumberBox` / `hasNativeNumberUnbox` resolver predicates, consulted
 * once, here, before freeze. `target` alone cannot answer the question:
 * ordinary host-assisted GC, GC native-first, and host-assisted GC with
 * explicit native strings all resolve to `target: "host"` and disagree about
 * both arms. Native `__box_number` presence must NOT widen the box policy —
 * the current arm is host-only by policy, not by helper availability.
 */
function integrationNumberBoundaryPolicy(ctx: CodegenContext): NumberBoundaryPolicy {
  const hostNumberBoundary = !ctx.nativeStrings;
  return Object.freeze({
    box: hostNumberBoundary ? ("host" as const) : ("unsupported" as const),
    unbox: hostNumberBoundary
      ? ("host" as const)
      : ctx.targetProfile.semanticProviders === "native-first"
        ? ("native" as const)
        : ("unsupported" as const),
  });
}

/**
 * (#3526 F1-S2) This caller's already-resolved BOOLEAN-boundary policy.
 *
 * The EXACT fact the from-ast boolean arm used to read through the
 * `hasHostBooleanBox` resolver predicate (`!ctx.nativeStrings`), consulted
 * once, here, before freeze. Boolean values share the host union-import family
 * with numbers but retain their own boxer, so `true` never crosses an externref
 * boundary as the number `1`; the family is one-armed because no native
 * boolean boxer exists to select.
 */
function integrationBooleanBoundaryPolicy(ctx: CodegenContext): BooleanBoundaryPolicy {
  return Object.freeze({ box: !ctx.nativeStrings ? ("host" as const) : ("unsupported" as const) });
}

/**
 * (#3526 F1-S4) This caller's already-resolved externref UNDEFINED-PROBE policy.
 *
 * The EXACT fact the from-ast strict-undefined arm used to read through the
 * `externIsUndefinedIsNative` resolver predicate (#4461,
 * `ctx.standalone || ctx.wasi || ctx.nativeStrings`), consulted once, here,
 * before freeze. Every host-free lane registers `__extern_is_undefined` as a
 * real Wasm function through `ensureObjectRuntime`, so this truth table is a
 * THIRD one again: wider than `numberBoundary` (unsupported on native-strings
 * GC) and wider than `booleanBoundary` (no native arm at all). The three name
 * different symbols and must not be merged.
 */
function integrationExternIsUndefinedPolicy(ctx: CodegenContext): ExternIsUndefinedPolicy {
  return Object.freeze({
    probe: ctx.standalone || ctx.wasi || ctx.nativeStrings ? ("native" as const) : ("host" as const),
  });
}

/** The first extern-boundary intrinsic in `fn` this policy cannot provide. */
function unsupportedExternBoundaryIntrinsic(
  fn: IrFunction,
  policy: ExternIsUndefinedPolicy,
): ExternBoundaryIntrinsicId | undefined {
  if (policy.probe !== "unsupported") return undefined;
  let found: ExternBoundaryIntrinsicId | undefined;
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (found !== undefined || instr.kind !== "intrinsic") return;
        if (instr.id === "js.extern.is_undefined") found = instr.id;
      });
    }
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

/**
 * (#3526 F1-S3) This caller's already-resolved GENERATOR number-box policy.
 *
 * The EXACT truth table the `gen.setReturn` seam has always had, consulted
 * once, here, before freeze: `__box_number` resolves to the `env` union import
 * on the host lane and to the union-native helper when native strings are on.
 * That is deliberately WIDER than `integrationNumberBoundaryPolicy`, whose box
 * arm is host-only by design — the two policies name the same symbol and must
 * not be merged.
 */
function integrationGeneratorNumberBoxPolicy(ctx: CodegenContext): GeneratorNumberBoxPolicy {
  return Object.freeze({ box: !ctx.nativeStrings ? ("host" as const) : ("native" as const) });
}

/**
 * (#3526 F2-S1) This caller's already-resolved STRING-COMPARE policy.
 *
 * The EXACT fact the resolve-time provider table read directly off
 * `ctx.nativeStrings` (integration.ts, the `IR_STRING_COMPARE_FN` arm),
 * consulted once, here, before freeze. `standalone` and `wasi` both imply
 * `nativeStrings`, so this one flag is the whole truth table — which is why the
 * arm is stated as `nativeStrings ? native : host` rather than repeating
 * `integrationExternIsUndefinedPolicy`'s three-way disjunction.
 */
function integrationStringComparePolicy(ctx: CodegenContext): StringComparePolicy {
  return Object.freeze({ compare: ctx.nativeStrings ? ("native" as const) : ("host" as const) });
}

/**
 * (#3526 F2-S1) True when any of `fns` performs a string relational compare.
 *
 * The seam carries no `intrinsic` instruction — from-ast emits a plain `call`
 * through the `IR_STRING_COMPARE_FN` sentinel func-ref — so the demand is read
 * off the call population directly, the way `irGeneratorNumberBoxDemand` reads
 * the `gen.setReturn` one. The same predicate answers the freeze request and
 * the owner-local partition below, so the two can never disagree.
 */
function irStringCompareDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (found || instr.kind !== "call") return;
          const { binding } = instr.target;
          if (binding.kind === "intrinsic" && binding.symbol === IR_STRING_COMPARE_FN) found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S3) This caller's already-resolved STRING-EQUALITY policy.
 *
 * The EXACT fact the resolve-time provider table read directly off
 * `ctx.nativeStrings` (the three-symbol concat/eq arm's single `if`), consulted
 * once, here, before freeze. Same one-flag truth table as the compare's, for the
 * same reason: `standalone` and `wasi` both imply `nativeStrings`.
 */
function integrationStringEqPolicy(ctx: CodegenContext): StringEqPolicy {
  return Object.freeze({ eq: ctx.nativeStrings ? ("native" as const) : ("host" as const) });
}

/**
 * (#3526 F2-S3) True when any of `fns` compares two strings for equality.
 *
 * Simpler than `irStringCompareDemand`: `string.eq` IS an instruction kind, so
 * the scan is a plain kind test rather than a walk of the `call` population.
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
function irStringEqDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.eq") found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S4) This caller's already-resolved STRING-LENGTH policy.
 *
 * The EXACT fact `prepareStrings` read directly off `ctx.nativeStrings` when it
 * built the `IrStringLengthProvider` itself, consulted once, here, before
 * freeze. Same one-flag truth table as its two family-2 siblings, for the same
 * reason: `standalone` and `wasi` both imply `nativeStrings`.
 */
function integrationStringLenPolicy(ctx: CodegenContext): StringLenPolicy {
  return Object.freeze({ len: ctx.nativeStrings ? ("native" as const) : ("host" as const) });
}

/**
 * (#3526 F2-S4) True when any of `fns` reads a string's `.length`.
 *
 * A plain `string.len` instruction-kind scan, the twin of `irStringEqDemand`.
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree — and it is deliberately the same
 * enumeration `prepareStrings`'s `usesStringLen` scan performs, so the freeze
 * cannot request a row for a demand the attachment pass will not find.
 */
function irStringLenDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.len") found = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/**
 * (#3526 F2-S5) This caller's already-resolved STRING-CONCATENATION policy.
 *
 * The EXACT fact the resolve-time provider table read directly off
 * `ctx.nativeStrings` (the two-symbol concat arm's single `if`), consulted once,
 * here, before freeze. Same one-flag truth table as its three family-2
 * siblings, for the same reason: `standalone` and `wasi` both imply
 * `nativeStrings`. The concat MODE is deliberately absent — it selects the
 * helper on the chosen authority, not the authority, and lives on the feature.
 */
function integrationStringConcatPolicy(ctx: CodegenContext): StringConcatPolicy {
  return Object.freeze({ concat: ctx.nativeStrings ? ("native" as const) : ("host" as const) });
}

/**
 * (#3526 F2-S5) Which concat MODES any of `fns` performs.
 *
 * A `string.concat` instruction-kind scan like `irStringLenDemand`, but it
 * returns a PAIR: the seam has two feature rows and the producer maps
 * `concatMode` onto one of two callable symbols
 * (`src/ir/string-support.ts`'s `irStringCallableProviderRef`), so this mirrors
 * that mapping exactly — `instr.concatMode ?? "immutable"`. A module with no
 * builder loop then freezes no `owned-append` row at all.
 *
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
function irStringConcatDemand(fns: readonly IrFunction[]): { readonly immutable: boolean; readonly owned: boolean } {
  let immutable = false;
  let owned = false;
  for (const fn of fns) {
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind !== "string.concat") return;
          if ((instr.concatMode ?? "immutable") === "owned-append") owned = true;
          else immutable = true;
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  return { immutable, owned };
}

/**
 * (#3526 F2-S7) This caller's already-resolved guarded-`charCodeAt` policy.
 *
 * The EXACT fact the resolve-time table read directly off `ctx.nativeStrings`
 * (the `IR_STRING_CHAR_CODE_AT_FN` arm's single ternary), consulted once, here,
 * before freeze — and the same fact `stringMethodPlan` reads at PLAN time to
 * bake the lane into the intrinsic symbol. Inside `compile()` the two cannot
 * disagree, because this IS that expression; the resolve arms therefore VERIFY
 * the plan-time symbol against the frozen row rather than re-deciding it.
 * Same one-flag truth table as its four family-2 siblings, for the same reason:
 * `standalone` and `wasi` both imply `nativeStrings`.
 */
function integrationStringCharCodeAtPolicy(ctx: CodegenContext): StringCharCodeAtPolicy {
  return Object.freeze({ charCodeAt: ctx.nativeStrings ? ("native" as const) : ("host" as const) });
}

/**
 * (#3526 F2-S7) True when any of `fns` performs a guarded `charCodeAt` read.
 *
 * TWO producers reach WasmGC codegen and BOTH are demand — this is the only
 * scan in the family that is not a single instruction kind:
 *
 *  * a `string.char_code_at` instruction, minted by `from-ast` only with
 *    receiver-encoding evidence; and
 *  * an `intrinsic` `call` whose symbol is the plan-path pair
 *    `__jsstr_charCodeAt` / `__str_charCodeAt` — the SAME enumeration the host
 *    pre-registration scan performs further down, minus the trusted symbol.
 *
 * The proof-licensed symbols (`__jsstr_charCodeAt_trusted`, and the
 * `__str_flatten` + `__str_flat_charCodeAt` preheader pair) are deliberately
 * NOT demand: they are a different, plan-time-decided feature this slice does
 * not govern, so a hoisted char-read loop freezes no row and its arms are
 * untouched.
 *
 * The same predicate answers the freeze request and the owner-local partition
 * below, so the two can never disagree.
 */
function irStringCharCodeAtDemand(fns: readonly IrFunction[]): boolean {
  for (const fn of fns) {
    let found = false;
    const scan = (buffer: readonly IrInstr[]): void => {
      for (const root of buffer) {
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "string.char_code_at") {
            found = true;
            return;
          }
          if (instr.kind !== "call" || instr.target.binding.kind !== "intrinsic") return;
          if (
            instr.target.binding.symbol === JSSTR_CHARCODEAT_FN ||
            instr.target.binding.symbol === NATIVE_CHARCODEAT_FN
          ) {
            found = true;
          }
        });
      }
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
    if (found) return true;
  }
  return false;
}

/** The first number-boundary intrinsic in `fn` this policy cannot provide. */
function unsupportedNumberBoundaryIntrinsic(
  fn: IrFunction,
  policy: NumberBoundaryPolicy,
): NumberBoundaryIntrinsicId | undefined {
  let found: NumberBoundaryIntrinsicId | undefined;
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (found !== undefined || instr.kind !== "intrinsic") return;
        if (instr.id === "js.number.box" && policy.box === "unsupported") found = instr.id;
        else if (instr.id === "js.number.unbox" && policy.unbox === "unsupported") found = instr.id;
      });
    }
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

/** The first boolean-boundary intrinsic in `fn` this policy cannot provide. */
function unsupportedBooleanBoundaryIntrinsic(
  fn: IrFunction,
  policy: BooleanBoundaryPolicy,
): BooleanBoundaryIntrinsicId | undefined {
  if (policy.box !== "unsupported") return undefined;
  let found: BooleanBoundaryIntrinsicId | undefined;
  const scan = (buffer: readonly IrInstr[]): void => {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (found !== undefined || instr.kind !== "intrinsic") return;
        if (instr.id === "js.boolean.box") found = instr.id;
      });
    }
  };
  for (const block of fn.blocks) scan(block.instrs);
  for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  return found;
}

function prepareBuiltFnRuntimeManifest(
  ctx: CodegenContext,
  sourceFile: string,
  entries: readonly BuiltFn[],
): { readonly entries: readonly BuiltFn[]; readonly runtime?: PreparedIrRuntimeManifest } {
  const runtime = prepareIrRuntimeManifest({
    functions: entries.map((entry) => entry.fn),
    sourceFile,
    policy: {
      target: ctx.wasi ? "wasi" : ctx.standalone ? "standalone" : ctx.strictNoHostImports ? "strict-no-host" : "host",
      backend: "wasmgc",
      numberBoundary: integrationNumberBoundaryPolicy(ctx),
      booleanBoundary: integrationBooleanBoundaryPolicy(ctx),
      externIsUndefined: integrationExternIsUndefinedPolicy(ctx),
      generatorNumberBox: integrationGeneratorNumberBoxPolicy(ctx),
      stringCompare: integrationStringComparePolicy(ctx),
      stringEq: integrationStringEqPolicy(ctx),
      stringLen: integrationStringLenPolicy(ctx),
      stringConcat: integrationStringConcatPolicy(ctx),
      stringCharCodeAt: integrationStringCharCodeAtPolicy(ctx),
    },
    // (#3526 F1-S3) Same predicate, same enumeration the attachment pass runs
    // later — see `forEachIrGeneratorSetReturn`.
    generatorNumberBoxDemand: irGeneratorNumberBoxDemand(entries.map((entry) => entry.fn)),
    // (#3526 F2-S1) Same predicate the partition scan above runs, so a demand
    // the freeze requests can never be one the partition failed to classify.
    stringCompareDemand: irStringCompareDemand(entries.map((entry) => entry.fn)),
    // (#3526 F2-S3) Same predicate the partition scan above runs, for the same
    // reason: a demand the freeze requests can never be one the partition failed
    // to classify.
    stringEqDemand: irStringEqDemand(entries.map((entry) => entry.fn)),
    // (#3526 F2-S4) Same predicate the partition scan above runs, same reason
    // again — and here it is load-bearing rather than merely consistent: the
    // length seam's physical choice lives ONLY on the frozen row, so a
    // length-only module that froze no manifest would leave
    // `prepareStringLength` below with nothing to read.
    stringLenDemand: irStringLenDemand(entries.map((entry) => entry.fn)),
    // (#3526 F2-S5) Same predicate the partition scan above runs, same reason
    // again — but a PAIR: the freeze must request exactly the modes the module
    // uses, or a concat-only module would carry an `owned-append` row nothing
    // ever calls (and an append-only one would be missing the row it needs).
    stringConcatDemand: irStringConcatDemand(entries.map((entry) => entry.fn)),
    // (#3526 F2-S7) Same predicate the partition scan above runs, same reason
    // again — and it must count BOTH producers, or the 35 plan-path cells would
    // reach the verify arms with no frozen row to be checked against.
    stringCharCodeAtDemand: irStringCharCodeAtDemand(entries.map((entry) => entry.fn)),
  });
  if (!runtime) return { entries };
  const preparedByUnitId = new Map(runtime.functions.map((fn) => [fn.unitId, fn] as const));
  const preparedEntries = entries.map((entry) => {
    const fn = preparedByUnitId.get(entry.artifactUnitId);
    if (!fn) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `runtime-manifest preparation lost artifact ${entry.artifactUnitId} / ${entry.name}`,
      );
    }
    return fn === entry.fn ? entry : { ...entry, fn };
  });
  const lengthAttached = prepareStringLength(ctx, preparedEntries, runtime);
  materializePreparedMathProviders(ctx, runtime);
  materializePreparedAsyncHostAdapters(ctx, runtime.functions);
  return { entries: lengthAttached, runtime };
}

/**
 * (#3526 F2-S4) Attach the frozen string-LENGTH provider to every `string.len`.
 *
 * This runs INSIDE the freeze, after `preparedEntries` is built and before the
 * math/async materializers, and that placement is the one structural edit of
 * the slice. Every other family-2 seam is materialized at resolve time, where
 * the prepared manifest is already in scope; `string.len` has no callable
 * symbol at all, so the `IrStringLengthProvider` carried on the instruction IS
 * the physical choice — which means the attachment itself has to happen after
 * the manifest that decides it is frozen.
 *
 * Order-preservation: `prepareStrings` used to attach this before the freeze.
 * Nothing between the two points reads `string.len.provider` —
 * `prepareIrRuntimeManifest` collects `intrinsic` uses only, and every reader
 * (lowering, component sealing, `preregisterCallableProviders`) runs later — so
 * the move is byte-neutral by construction. `attachIrStringLengthProvider` is a
 * pure structural map that touches ONLY `string.len` and checks rather than
 * overwrites an existing attachment, so composing it after the intrinsic pass
 * instead of before it yields identical IR.
 */
function prepareStringLength(
  ctx: CodegenContext,
  entries: readonly BuiltFn[],
  runtime: PreparedIrRuntimeManifest,
): readonly BuiltFn[] {
  const arm = preparedStringLenProvider(runtime);
  // No frozen row at all: nothing in this program reads `.length`.
  if (!arm) return entries;
  // The Program-ABI type registry is what names the string carrier; without it
  // `prepareStrings` attaches nothing either, and this pass keeps that skip
  // rather than inventing a carrier the rest of preparation does not have.
  const registry = ctx.programAbiTypes;
  if (!registry) return entries;
  let provider: IrStringLengthProvider;
  if (arm.arm === "native") {
    provider = { kind: "struct-field", ownerType: registry.stringCarrierRef(), fieldIndex: arm.fieldIndex };
  } else {
    const target = irImportFuncRef(arm.module, arm.field, arm.field);
    const structuralReferenceKey = irCallableBindingKey(target.binding);
    const imported = catalogProgramAbiCallableImports(ctx).get(structuralReferenceKey);
    if (!imported || imported.desc.kind !== "func") {
      throw new Error("ir/integration: prepared string.len has no exact wasm:js-string.length import");
    }
    provider = { kind: "callable", target };
  }
  return entries.map((entry) => {
    // Length-ONLY. The omnibus `attachIrStringSupport` cannot be reused here:
    // its callable arm re-derives five other seams' providers on every run, and
    // this pass has no authority over any of them — see
    // `attachIrStringLengthProvider`, which records the corpus failure that
    // proved it.
    const fn = attachIrStringLengthProvider(entry.fn, provider);
    return fn === entry.fn ? entry : { ...entry, fn };
  });
}

function atomicDeferredValTypeIsAllocatorNeutral(type: ValType): boolean {
  return type.kind === "i32" || type.kind === "i64" || type.kind === "f32" || type.kind === "f64";
}

function atomicDeferredIrTypeIsAllocatorNeutral(type: IrType): boolean {
  return type.kind === "val" && atomicDeferredValTypeIsAllocatorNeutral(type.val);
}

/**
 * M1A.3 publishes no helper/import/type/provider prefix before its receipt.
 * Until those registries expose detached allocation, admit only the scalar
 * IR subset whose lowering is allocator-neutral; every other component stays
 * direct-owned before any lazy preparation helper can run.
 */
function atomicDeferredComponentIsAllocatorNeutral(entries: readonly BuiltFn[]): boolean {
  for (const entry of entries) {
    const fn = entry.fn;
    if (
      entry.derivedUnit !== undefined ||
      entry.synthesized === true ||
      entry.classMember === true ||
      entry.moduleInit === true ||
      (entry.countedStringAppendPlans?.length ?? 0) !== 0 ||
      (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
      fn.closureSubtype !== undefined ||
      fn.asyncPlan !== undefined ||
      fn.asyncRuntime !== undefined ||
      fn.params.some(({ type }) => !atomicDeferredIrTypeIsAllocatorNeutral(type)) ||
      fn.resultTypes.some((type) => !atomicDeferredIrTypeIsAllocatorNeutral(type)) ||
      fn.slots?.some(({ type }) => !atomicDeferredValTypeIsAllocatorNeutral(type)) === true ||
      fn.blocks.some(({ blockArgTypes }) => blockArgTypes.some((type) => !atomicDeferredIrTypeIsAllocatorNeutral(type)))
    ) {
      return false;
    }
    for (const block of fn.blocks) {
      for (const root of block.instrs) {
        let neutral = true;
        forEachInstrDeep(root, (instr) => {
          if (!neutral || instr.alloc !== undefined) {
            neutral = false;
            return;
          }
          if (instr.resultType !== null && !atomicDeferredIrTypeIsAllocatorNeutral(instr.resultType)) {
            neutral = false;
            return;
          }
          switch (instr.kind) {
            case "const":
              neutral =
                instr.value.kind === "i32" ||
                instr.value.kind === "i64" ||
                instr.value.kind === "f32" ||
                instr.value.kind === "f64" ||
                instr.value.kind === "bool";
              break;
            case "call":
              neutral = instr.target.binding.kind === "unit";
              break;
            case "binary":
            case "unary":
            case "select":
            case "if":
            case "slot.read":
            case "slot.write":
            case "early.return":
            case "while.loop":
            case "for.loop":
            case "br.label":
            case "if.stmt":
            case "labeled.block":
            case "switch":
              break;
            default:
              neutral = false;
          }
        });
        if (!neutral) return false;
      }
    }
  }
  return true;
}

const atomicDeferredNeutralBinaryOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
]);

const atomicDeferredNeutralUnaryOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.ExclamationToken,
]);

/**
 * Check the exact source declarations before any AST-to-IR builder or lazy
 * registry is created for a deferred aggregate.  This is deliberately a
 * default-deny syntax gate: the post-build whitelist below remains an
 * independent defence, while this gate ensures an array/helper lowering
 * cannot first mutate the shared context and only then decline.
 */
function atomicDeferredComponentPreflightFailure(
  integrationSourceFiles: readonly ts.SourceFile[],
  selection: IrSelection,
  loweringPlans: IrIntegrationLoweringPlans | undefined,
  identityContext: IrPlanningIdentityContext,
  checker: ts.TypeChecker,
  pendingLateImportShift: CodegenContext["pendingLateImportShift"],
): string | undefined {
  if (pendingLateImportShift !== null) {
    return "atomic prepared component has a pending late import shift";
  }
  if (!loweringPlans) {
    return "atomic prepared component has no exact lowering plan for neutral preflight";
  }

  const sourceFiles = new Set(integrationSourceFiles);
  const componentUnitIds = new Set(loweringPlans.ownerProjection.entries.map(({ unitId }) => unitId));
  const declarationsByUnitId = new Map<IrUnitId, ts.FunctionDeclaration>();
  for (const unitId of componentUnitIds) {
    const declaration = identityContext.declarationByUnitId.get(unitId);
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.body ||
      !sourceFiles.has(declaration.getSourceFile()) ||
      identityContext.unitIdByDeclaration.get(declaration) !== unitId ||
      declaration.parent !== declaration.getSourceFile()
    ) {
      return `atomic prepared component has no exact top-level declaration for ${unitId}`;
    }
    declarationsByUnitId.set(unitId, declaration);
  }

  const localIdentifierIn = (node: ts.Identifier, ownerUnitId: IrUnitId): boolean => {
    const owner = declarationsByUnitId.get(ownerUnitId);
    if (!owner) return false;
    let valueDeclaration: ts.Declaration | undefined;
    try {
      const symbol = checker.getSymbolAtLocation(node);
      valueDeclaration = symbol?.valueDeclaration;
    } catch {
      return false;
    }
    if (!valueDeclaration) return false;
    for (let current: ts.Node | undefined = valueDeclaration; current; current = current.parent) {
      if (current === owner) return true;
      if (
        current !== valueDeclaration &&
        (ts.isFunctionLike(current) || ts.isSourceFile(current) || ts.isModuleBlock(current))
      ) {
        return false;
      }
    }
    return false;
  };

  type AtomicDeferredPrimitiveFamily = "number" | "boolean" | "string";
  const primitiveFamilyAt = (node: ts.Expression): AtomicDeferredPrimitiveFamily | undefined => {
    try {
      const type = checker.getTypeAtLocation(node);
      if (type.isUnion()) {
        const families = new Set<AtomicDeferredPrimitiveFamily>();
        for (const member of type.types) {
          if ((member.flags & ts.TypeFlags.Never) !== 0) continue;
          if ((member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return undefined;
          const family =
            (member.flags & ts.TypeFlags.NumberLike) !== 0
              ? ("number" as const)
              : (member.flags & ts.TypeFlags.BooleanLike) !== 0
                ? ("boolean" as const)
                : (member.flags & ts.TypeFlags.StringLike) !== 0
                  ? ("string" as const)
                  : undefined;
          if (family === undefined) return undefined;
          families.add(family);
        }
        return families.size === 1 ? families.values().next().value : undefined;
      }
      if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return "number";
      if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return "boolean";
      if ((type.flags & ts.TypeFlags.StringLike) !== 0) return "string";
      return undefined;
    } catch {
      return undefined;
    }
  };

  const visit = (node: ts.Node, ownerUnitId: IrUnitId): string | undefined => {
    if (ts.isCallExpression(node)) {
      const direct = loweringPlans.directCalls.get(node);
      const imported = loweringPlans.importedCalls.get(node);
      if (!direct && !imported) {
        return `owner ${ownerUnitId} contains a call without an exact unit-bound lowering plan`;
      }
      const owner = direct?.ownerUnitId ?? imported?.ownerUnitId;
      const target = direct?.target ?? imported?.target;
      if (owner !== ownerUnitId || !target || target.binding.kind !== "unit") {
        return `owner ${ownerUnitId} contains a non-neutral helper or foreign call`;
      }
      if (imported && imported.source !== "module-import") {
        return `owner ${ownerUnitId} contains a non-neutral imported call`;
      }
      if (!componentUnitIds.has(target.binding.unitId)) {
        return `owner ${ownerUnitId} calls unit ${target.binding.unitId} outside its aggregate`;
      }
      for (const argument of node.arguments) {
        if (ts.isSpreadElement(argument)) {
          return `owner ${ownerUnitId} contains a spread argument in a deferred aggregate`;
        }
        const failure = visit(argument, ownerUnitId);
        if (failure) return failure;
      }
      return undefined;
    }
    if (ts.isBinaryExpression(node)) {
      if (!atomicDeferredNeutralBinaryOperators.has(node.operatorToken.kind)) {
        return `owner ${ownerUnitId} contains non-neutral binary operator ${ts.SyntaxKind[node.operatorToken.kind]}`;
      }
      return visit(node.left, ownerUnitId) ?? visit(node.right, ownerUnitId);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      if (!atomicDeferredNeutralUnaryOperators.has(node.operator)) {
        return `owner ${ownerUnitId} contains non-neutral unary operator ${ts.SyntaxKind[node.operator]}`;
      }
      return visit(node.operand, ownerUnitId);
    }
    if (ts.isParenthesizedExpression(node)) return visit(node.expression, ownerUnitId);
    if (ts.isConditionalExpression(node)) {
      const trueFamily = primitiveFamilyAt(node.whenTrue);
      const falseFamily = primitiveFamilyAt(node.whenFalse);
      if (trueFamily === undefined || trueFamily !== falseFamily) {
        return `owner ${ownerUnitId} contains a mixed or unresolved conditional value`;
      }
      return (
        visit(node.condition, ownerUnitId) ?? visit(node.whenTrue, ownerUnitId) ?? visit(node.whenFalse, ownerUnitId)
      );
    }
    // Labels are control-flow metadata, not value references.  Their
    // identifiers have no checker valueDeclaration, so do not mistake a
    // `break label` / `continue label` or the declaration label itself for a
    // non-local value.  The surrounding statement remains in the same
    // default-deny syntax walk below.
    if (ts.isLabeledStatement(node)) return visit(node.statement, ownerUnitId);
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return undefined;
    if (ts.isIdentifier(node)) {
      if (!localIdentifierIn(node, ownerUnitId)) {
        return `owner ${ownerUnitId} contains non-local identifier ${node.text}`;
      }
      return undefined;
    }
    if (
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NumberKeyword ||
      node.kind === ts.SyntaxKind.BooleanKeyword
    ) {
      return undefined;
    }
    if (
      ts.isBlock(node) ||
      ts.isReturnStatement(node) ||
      ts.isExpressionStatement(node) ||
      ts.isVariableStatement(node) ||
      ts.isVariableDeclarationList(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isForStatement(node) ||
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node) ||
      ts.isEmptyStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node)
    ) {
      let failure: string | undefined;
      node.forEachChild((child) => {
        if (!failure) failure = visit(child, ownerUnitId);
      });
      return failure;
    }
    return `owner ${ownerUnitId} contains non-neutral ${ts.SyntaxKind[node.kind]}`;
  };

  for (const entry of loweringPlans.ownerProjection.entries) {
    if (!selection.funcs.has(entry.legacyName)) {
      return `atomic prepared component did not select exact owner ${entry.unitId}`;
    }
    const declaration = declarationsByUnitId.get(entry.unitId);
    if (!declaration) return `atomic prepared component lost exact declaration ${entry.unitId}`;
    const signature = loweringPlans.signaturesByUnitId.get(entry.unitId);
    if (
      !signature ||
      signature.params.some((type) => !atomicDeferredIrTypeIsAllocatorNeutral(type)) ||
      (signature.returnType !== null && !atomicDeferredIrTypeIsAllocatorNeutral(signature.returnType))
    ) {
      return `owner ${entry.unitId} has a non-neutral callable signature`;
    }
    const failure = visit(declaration.body!, entry.unitId);
    if (failure) return failure;
  }
  return undefined;
}

interface AtomicDeferredPreflightSnapshot {
  readonly usesVecValue: boolean;
  readonly allocRegistry: object | undefined;
  readonly pendingLateImportShift: CodegenContext["pendingLateImportShift"];
  readonly numImportFuncs: number;
  readonly modTypes: readonly unknown[];
  readonly vecTypeMap: readonly (readonly [string, number])[];
  readonly vecFromExternMap: readonly (readonly [number, string])[];
  readonly funcMap: readonly (readonly [string, number])[];
  readonly imports: readonly unknown[];
  readonly functions: readonly unknown[];
  readonly globals: readonly unknown[];
  readonly tags: readonly unknown[];
  readonly exports: readonly unknown[];
  readonly stringPool: readonly string[];
  readonly irCompiledFuncs: readonly string[];
  readonly irOutcomes: readonly unknown[];
  readonly irProgramCallableAttemptedUnitIds: readonly IrUnitId[] | undefined;
  readonly irProgramCallablePreparedUnitIds: readonly IrUnitId[] | undefined;
  readonly callableImportCatalog: readonly (readonly [string, unknown])[];
  readonly callableImportRegistry: readonly (readonly [string, readonly unknown[]])[];
  readonly callableProviderRegistry: readonly (readonly [string, readonly unknown[]])[];
}

function snapshotMapEntries<K, V>(map: ReadonlyMap<K, V> | undefined): readonly (readonly [K, V])[] {
  return map ? [...map.entries()] : [];
}

function snapshotProgramAbiRegistry(
  registry: object | undefined,
  fields: readonly string[],
): readonly (readonly [string, readonly unknown[]])[] {
  if (!registry) return [];
  const state = registry as Record<string, unknown>;
  return fields.map((field) => {
    const value = state[field];
    if (value instanceof Map) {
      const entries = [...value.entries()].flatMap(([key, entry]) => [
        key,
        ...(Array.isArray(entry) ? entry : [entry]),
      ]);
      return [field, entries] as const;
    }
    if (Array.isArray(value)) return [field, [...value]] as const;
    return [field, value === undefined ? [] : [value]] as const;
  });
}

function snapshotAtomicDeferredPreflightState(ctx: CodegenContext): AtomicDeferredPreflightSnapshot {
  return {
    usesVecValue: ctx.usesVecValue,
    allocRegistry: ctx.allocRegistry,
    pendingLateImportShift: ctx.pendingLateImportShift,
    numImportFuncs: ctx.numImportFuncs,
    modTypes: [...ctx.mod.types],
    vecTypeMap: [...ctx.vecTypeMap.entries()],
    vecFromExternMap: [...(ctx.vecFromExternMap?.entries() ?? [])],
    funcMap: [...ctx.funcMap.entries()],
    imports: [...ctx.mod.imports],
    functions: [...ctx.mod.functions],
    globals: [...ctx.mod.globals],
    tags: [...ctx.mod.tags],
    exports: [...ctx.mod.exports],
    stringPool: [...ctx.mod.stringPool],
    irCompiledFuncs: [...(ctx.irCompiledFuncs ?? [])],
    irOutcomes: [...(ctx.irOutcomes ?? [])],
    irProgramCallableAttemptedUnitIds:
      ctx.irProgramCallableAttemptedUnitIds === undefined ? undefined : [...ctx.irProgramCallableAttemptedUnitIds],
    irProgramCallablePreparedUnitIds:
      ctx.irProgramCallablePreparedUnitIds === undefined ? undefined : [...ctx.irProgramCallablePreparedUnitIds],
    callableImportCatalog: snapshotMapEntries(ctx.programAbiCallableImports?.catalog()),
    callableImportRegistry: snapshotProgramAbiRegistry(ctx.programAbiCallableImports, [
      "preparedPublication",
      "plannedByImport",
      "plannedValue",
    ]),
    callableProviderRegistry: snapshotProgramAbiRegistry(ctx.programAbiCallableProviders, [
      "observed",
      "preparedPublication",
      "appendedOrder",
      "plannedByKey",
      "plannedValue",
    ]),
  };
}

function assertAtomicDeferredPreflightStateUnchanged(
  ctx: CodegenContext,
  before: AtomicDeferredPreflightSnapshot,
): void {
  const after = snapshotAtomicDeferredPreflightState(ctx);
  const same =
    before.usesVecValue === after.usesVecValue &&
    before.allocRegistry === after.allocRegistry &&
    before.numImportFuncs === after.numImportFuncs &&
    before.pendingLateImportShift === after.pendingLateImportShift &&
    (before.pendingLateImportShift === null ||
      (after.pendingLateImportShift !== null &&
        before.pendingLateImportShift.importsBefore === after.pendingLateImportShift.importsBefore)) &&
    before.modTypes.length === after.modTypes.length &&
    before.modTypes.every((value, index) => value === after.modTypes[index]) &&
    before.vecTypeMap.length === after.vecTypeMap.length &&
    before.vecTypeMap.every(
      ([key, value], index) => key === after.vecTypeMap[index]?.[0] && value === after.vecTypeMap[index]?.[1],
    ) &&
    before.vecFromExternMap.length === after.vecFromExternMap.length &&
    before.vecFromExternMap.every(
      ([key, value], index) =>
        key === after.vecFromExternMap[index]?.[0] && value === after.vecFromExternMap[index]?.[1],
    ) &&
    before.funcMap.length === after.funcMap.length &&
    before.funcMap.every(
      ([key, value], index) => key === after.funcMap[index]?.[0] && value === after.funcMap[index]?.[1],
    ) &&
    before.imports.length === after.imports.length &&
    before.imports.every((value, index) => value === after.imports[index]) &&
    before.functions.length === after.functions.length &&
    before.functions.every((value, index) => value === after.functions[index]) &&
    before.globals.length === after.globals.length &&
    before.globals.every((value, index) => value === after.globals[index]) &&
    before.tags.length === after.tags.length &&
    before.tags.every((value, index) => value === after.tags[index]) &&
    before.exports.length === after.exports.length &&
    before.exports.every((value, index) => value === after.exports[index]) &&
    before.stringPool.length === after.stringPool.length &&
    before.stringPool.every((value, index) => value === after.stringPool[index]) &&
    before.irCompiledFuncs.length === after.irCompiledFuncs.length &&
    before.irCompiledFuncs.every((value, index) => value === after.irCompiledFuncs[index]) &&
    before.irOutcomes.length === after.irOutcomes.length &&
    before.irOutcomes.every((value, index) => value === after.irOutcomes[index]) &&
    ((before.irProgramCallableAttemptedUnitIds === undefined &&
      after.irProgramCallableAttemptedUnitIds === undefined) ||
      (before.irProgramCallableAttemptedUnitIds !== undefined &&
        after.irProgramCallableAttemptedUnitIds !== undefined &&
        before.irProgramCallableAttemptedUnitIds.length === after.irProgramCallableAttemptedUnitIds.length &&
        before.irProgramCallableAttemptedUnitIds.every(
          (value, index) => value === after.irProgramCallableAttemptedUnitIds![index],
        ))) &&
    ((before.irProgramCallablePreparedUnitIds === undefined && after.irProgramCallablePreparedUnitIds === undefined) ||
      (before.irProgramCallablePreparedUnitIds !== undefined &&
        after.irProgramCallablePreparedUnitIds !== undefined &&
        before.irProgramCallablePreparedUnitIds.length === after.irProgramCallablePreparedUnitIds.length &&
        before.irProgramCallablePreparedUnitIds.every(
          (value, index) => value === after.irProgramCallablePreparedUnitIds![index],
        ))) &&
    before.callableImportCatalog.length === after.callableImportCatalog.length &&
    before.callableImportCatalog.every(
      ([key, value], index) =>
        key === after.callableImportCatalog[index]?.[0] && value === after.callableImportCatalog[index]?.[1],
    ) &&
    before.callableImportRegistry.length === after.callableImportRegistry.length &&
    before.callableImportRegistry.every(
      ([field, values], index) =>
        field === after.callableImportRegistry[index]?.[0] &&
        values.length === after.callableImportRegistry[index]?.[1].length &&
        values.every((value, valueIndex) => value === after.callableImportRegistry[index]?.[1][valueIndex]),
    ) &&
    before.callableProviderRegistry.length === after.callableProviderRegistry.length &&
    before.callableProviderRegistry.every(
      ([field, values], index) =>
        field === after.callableProviderRegistry[index]?.[0] &&
        values.length === after.callableProviderRegistry[index]?.[1].length &&
        values.every((value, valueIndex) => value === after.callableProviderRegistry[index]?.[1][valueIndex]),
    );
  if (!same) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "atomic prepared component allocator-neutral preflight mutated shared context state",
    );
  }
}

/** Test-only negative control for the required #4113 final gate. */
function injectFinalAllocProvenanceFailure(
  fn: IrFunction,
  compatibilityName: string,
  artifactKind: "ordinary" | "synthetic" | "monomorphized",
): IrFunction {
  const selector = process.env.JS2WASM_TEST_INJECT_IR_FINAL_ALLOC_FAILURE;
  if (selector === undefined || (selector !== "1" && selector !== compatibilityName && selector !== artifactKind)) {
    return fn;
  }

  let removed = false;
  const rewriteInstr = (instr: IrInstr): IrInstr => {
    const withNested = mapNestedBuffers(instr, (buffer) => {
      const rewritten = buffer.map(rewriteInstr);
      return rewritten.some((candidate, index) => candidate !== buffer[index]) ? rewritten : buffer;
    });
    if (removed || withNested.alloc === undefined) return withNested;
    const { alloc: _removedAlloc, ...withoutAlloc } = withNested;
    removed = true;
    return withoutAlloc as IrInstr;
  };
  const blocks = fn.blocks.map((block) => {
    const instrs = block.instrs.map(rewriteInstr);
    return instrs.some((instr, index) => instr !== block.instrs[index]) ? { ...block, instrs } : block;
  });
  if (!removed) {
    throw new Error(
      `final allocation-provenance injection for ${compatibilityName} requires one allocation instruction`,
    );
  }
  return { ...fn, blocks };
}

/**
 * Require final provenance after all IR attachments and before component
 * sealing, publication, or lowering. The collection includes source,
 * synthetic, async-state, and monomorphized artifacts.
 */
function verifyFinalAllocArtifacts(
  entries: readonly BuiltFn[],
  registry: AllocSiteRegistry,
  cloneOrigins: ReadonlyMap<IrUnitId, IrUnitId>,
  onFailure: (entry: BuiltFn, error: unknown) => void,
): BuiltFn[] {
  const verified: BuiltFn[] = [];
  for (const entry of entries) {
    try {
      const artifactKind = cloneOrigins.has(entry.artifactUnitId)
        ? "monomorphized"
        : entry.synthesized
          ? "synthetic"
          : "ordinary";
      const fn = injectFinalAllocProvenanceFailure(entry.fn, entry.name, artifactKind);
      assertFinalAllocProvenance(fn, registry);
      verified.push(fn === entry.fn ? entry : { ...entry, fn });
    } catch (error) {
      onFailure(entry, error);
    }
  }
  return verified;
}

function fillSealedPreparedCallable(
  componentId: string,
  previous: WasmFunction,
  replacement: WasmFunction,
): WasmFunction {
  if (
    previous.typeIdx !== replacement.typeIdx ||
    previous.name !== replacement.name ||
    previous.exported !== replacement.exported
  ) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "patch",
      `prepared component ${componentId} cannot change the reserved callable contract for ${previous.name}`,
    );
  }
  // The prepared ABI scope pins this allocator object before lowering.
  previous.locals = replacement.locals;
  previous.body = replacement.body;
  return previous;
}

function makeAmbientStringBindingPredicate(checker: ts.TypeChecker): (node: ts.Identifier) => boolean {
  return (node) => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      // allowJs programs can omit lib declarations entirely. An unresolved
      // `String` is the global constructor; every source-owned shadow has a
      // source declaration and is rejected by the branch below.
      if (!symbol) return true;
      const declarations = [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
        (declaration): declaration is ts.Declaration => declaration !== undefined,
      );
      return (
        declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
      );
    } catch {
      return false;
    }
  };
}

function makeIrDirectCallReconciler(
  sourceFile: ts.SourceFile,
  loweringPlans: IrIntegrationLoweringPlans | undefined,
  targets: ReadonlyMap<string, IrDirectCallTarget>,
): {
  readonly directCalls: Map<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly collect: (root: ts.Node, ownerUnitId: IrUnitId) => ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
} {
  const sourceTargets = new Map([...targets].filter(([, target]) => target.target.binding.kind === "unit"));
  const compatibilityTargets = new Map([...targets].filter(([, target]) => target.target.binding.kind !== "unit"));
  const activeOwnerUnitIds = new Set(loweringPlans?.ownerProjection.entries.map(({ unitId }) => unitId) ?? []);
  const sourceSignatures = loweringPlans?.directCallSignaturesByUnitId ?? loweringPlans?.signaturesByUnitId;
  const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>(loweringPlans?.directCalls);
  const collect = (root: ts.Node, ownerUnitId: IrUnitId): ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> => {
    let sourcePlans: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> = new Map();
    if (loweringPlans?.directCallResolver && sourceTargets.size > 0) {
      try {
        sourcePlans = collectIrDirectCallLoweringPlansByIdentity(root, ownerUnitId, {
          identityContext: loweringPlans.identityContext,
          resolver: loweringPlans.directCallResolver,
          activeOwnerUnitIds,
          signaturesByUnitId: sourceSignatures!,
          targetsByLegacyName: sourceTargets,
        });
      } catch (error) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `direct-call identity at ${sourceFile.fileName} disagrees with exact integration evidence: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }
    for (const [call, plan] of [
      ...sourcePlans,
      ...collectIrDirectCallLoweringPlans(root, ownerUnitId, compatibilityTargets),
    ]) {
      const existing = directCalls.get(call);
      if (existing && !irDirectCallLoweringPlanEquals(existing, plan)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `direct-call plan at ${sourceFile.fileName}:${call.pos} disagrees with exact integration identity`,
        );
      }
      if (!existing) directCalls.set(call, plan);
    }
    return directCalls;
  };
  return { directCalls, collect };
}

export function compileIrPathFunctions(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection?: IrSelection,
  overrides?: IrTypeOverrideMap,
  classShapes?: ReadonlyMap<string, IrClassShape>,
  loweringPlans?: IrIntegrationLoweringPlans,
  options?: IrIntegrationOptions,
): IrIntegrationReport {
  const integrationSourceFiles = resolveIntegrationSourceFiles(sourceFile, options?.integrationSourceFiles);
  const inlineOptions = parseInlineOptions(process.env.JS2WASM_IR_INLINE);
  const fuseNativeNumberFormatCarriers =
    inlineOptions.adapters && !inlineOptions.report && !inlineOptions.count && inlineOptions.poison === "off";
  const irTargetProfile = projectIrBackendTargetProfile(ctx.targetProfile, { fast: ctx.fast });
  const jsHostExterns = irTargetProfile.allowHostImports;
  const standaloneDomCapability =
    ctx.requiresStandaloneDomCapability === true &&
    ctx.standalone &&
    !ctx.wasi &&
    ctx.nativeStrings &&
    ctx.targetProfile.environment === "none" &&
    ctx.targetProfile.semanticProviders === "native-first"
      ? makeIrStandaloneDomCapabilityPlan(ctx.checker, sourceFile)
      : undefined;
  const supportsBackendCapability = (capability: IrBackendTargetCapability): boolean =>
    supportsIrBackendTargetCapability(irTargetProfile, capability);
  const { supportsDateSnapshots, resolveHostVoidCallback, backendCapabilitySelectionOptions } =
    makeCalendarIrSelectionSupport(ctx, jsHostExterns, standaloneDomCapability, supportsBackendCapability);
  const moduleBindingOptions = {
    numberStorage: ctx.fast ? ("i32" as const) : ("f64" as const),
    oracle: ctx.oracle,
    allowHostExterns: jsHostExterns && !ctx.nativeStrings,
    allowBuiltinMapExtern: jsHostExterns && !ctx.nativeStrings,
    // (#4461) Native `$Map` storage must agree with the selector-side option.
    allowNativeMapStorage: ctx.nativeStrings,
    resolveCapabilityExternBinding: standaloneDomCapability?.moduleBinding,
    stableFnctorArrayPrototypeNames: ctx.fnctorEscapeGate?.stableArrayPrototypeNames,
  };
  // Direct compatibility callers share this context; structural globals never fall back to declaration names.
  const compatibilityInventory = loweringPlans
    ? undefined
    : buildIrUnitInventory([sourceFile], { entrySource: sourceFile, checker: ctx.checker });
  const moduleBindingIdentityContext =
    loweringPlans?.identityContext ??
    (compatibilityInventory ? buildIrPlanningIdentityContext(compatibilityInventory) : undefined);
  if (!moduleBindingIdentityContext) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "ir/integration: module binding planning has no structural identity context",
    );
  }
  if (ctx.programAbiSession && ctx.programAbiSession.inventory !== moduleBindingIdentityContext.inventory) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "ir/integration: ProgramAbiSession and lowering plans use different identity inventories",
    );
  }
  const activeOwnerProjection =
    loweringPlans?.ownerProjection ??
    buildIrLegacyUnitProjection(
      compatibilityInventory?.terminalUnits.map((unit) => ({
        unitId: unit.id,
        legacyName: unit.legacyMatchName,
      })) ?? [],
    );
  const inventoryUnitById = new Map(
    moduleBindingIdentityContext.inventory.allUnits.map((unit) => [unit.id, unit] as const),
  );
  const liftedProgramAbiRecords = (
    result: LoweredFunctionResult,
    parentUnitId: IrUnitId,
    terminalOwnerId: IrUnitId,
  ): ReadonlyMap<IrUnitId, ProgramAbiDerivedUnitRecord> => {
    if (result.lifted.length !== result.liftedUnitProvenance.length) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/integration: ${parentUnitId} produced ${result.lifted.length} lifted functions but ${result.liftedUnitProvenance.length} provenance records`,
      );
    }
    const records = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
    for (const provenance of result.liftedUnitProvenance) {
      if (!isLiftedExecutableRole(provenance.role)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: lifted unit ${provenance.id} has invalid parent or role provenance`,
        );
      }
      const parent = inventoryUnitById.get(provenance.parentId);
      if (!parent || parent.terminalOwnerId !== terminalOwnerId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: lifted unit ${provenance.id} has no exact inventory parent and terminal owner`,
        );
      }
      if ("sourceUnit" in provenance) {
        const sourceUnit = inventoryUnitById.get(provenance.id);
        if (
          !sourceUnit ||
          sourceUnit.terminal ||
          sourceUnit.lexicalOwnerId !== provenance.parentId ||
          sourceUnit.terminalOwnerId !== terminalOwnerId ||
          sourceUnit.ordinal !== provenance.ordinal
        ) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "build",
            `ir/integration: lifted source unit ${provenance.id} has inconsistent inventory provenance`,
          );
        }
        continue;
      }
      if (provenance.parentId !== parentUnitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: derived lifted unit ${provenance.id} has an unexpected parent`,
        );
      }
      if (records.has(provenance.id)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: lifted unit ${provenance.id} was produced more than once`,
        );
      }
      records.set(provenance.id, {
        ...provenance,
        sourceId: parent.sourceId,
        terminalOwnerId,
      });
    }
    for (const lifted of result.lifted) {
      const sourceUnit = inventoryUnitById.get(lifted.unitId);
      if (!records.has(lifted.unitId) && (!sourceUnit || sourceUnit.terminalOwnerId !== terminalOwnerId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: lifted function ${lifted.unitId} / ${lifted.name} has no exact provenance record`,
        );
      }
    }
    return records;
  };
  const moduleBindingResolver = makeIrModuleBindingResolver(
    ctx.checker,
    moduleBindingOptions,
    moduleBindingIdentityContext,
  );
  const classifyPrimitiveExpression = makeIrPrimitiveExpressionClassifier(ctx.checker);
  const classifyDeclaredPrimitiveExpression = makeIrDeclaredPrimitiveExpressionClassifier(ctx.checker);
  const isArrayExpression = makeIrArrayExpressionPredicate(ctx.checker);
  const isRegExpExpression = makeIrRegExpExpressionPredicate(ctx.checker);
  const isAmbientStringBinding = makeAmbientStringBindingPredicate(ctx.checker);
  const declarationsByName = collectIntegrationFunctionDeclarations(integrationSourceFiles);
  const { implicitParamUsesNumericVecAbi, effectiveOverride } = makeMultiSourceOverrideResolvers({
    ctx,
    overrides,
    identityContext: moduleBindingIdentityContext,
    ownerProjection: activeOwnerProjection,
    declarationsByName,
    definedFunctionAt: (funcIdx) => definedFuncAt(ctx, funcIdx),
    fnctorParameterPreselection: loweringPlans?.fnctorParameterPreselection,
  });
  const selected =
    selection ??
    planIrCompilation(sourceFile, {
      experimentalIR: true,
      jsHostExterns,
      ...(standaloneDomCapability ? { standaloneDomCapability } : {}),
      ...(resolveHostVoidCallback ? { hostVoidCallbacks: resolveHostVoidCallback } : {}),
      ...(supportsDateSnapshots ? { hostDateSnapshots: makeIrHostDateSnapshotResolver(ctx.checker) } : {}),
      resolveModuleBinding: moduleBindingResolver,
      classifyPrimitiveExpression,
      classifyDeclaredPrimitiveExpression,
      isArrayExpression,
      isRegExpExpression,
      isAmbientStringBinding,
      isHoleyArrayConstructor: (expr) => ctx.holeyArrayConstructorNodes.has(expr),
      isHoleyArrayFilterCall: (expr) => ctx.holeyArrayFilterCallNodes.has(expr),
      supportsHoleyArrayFilter: ctx.standalone,
      implicitParamUsesNumericVecAbi,
      supportsSymbolicMathHelpers: true,
      // (#4462) Same two host-free capabilities the production planning site
      // (codegen/index.ts) supplies — this compatibility path must not offer a
      // narrower table, or a direct caller would demote where production claims.
      supportsNumberToString: irNativeNumberToStringAvailable(ctx),
      supportsNumberToFixed: irNativeNumberToFixedAvailable(ctx),
      supportsStandaloneConsoleSink: standaloneConsoleSinkAvailable(ctx),
      supportsLiteralStringReplace: true,
      ...(loweringPlans?.fnctorNativeStringBoundaries
        ? {
            fnctorNativeStringBoundary: (call: ts.CallExpression) =>
              loweringPlans.fnctorParameterPreselectionIsCurrent?.() === true &&
              loweringPlans.fnctorNativeStringBoundaries!.has(call),
          }
        : {}),
      ...(loweringPlans?.fnctorParameterPreselection?.nativeStringReplaceCall
        ? {
            fnctorNativeStringReplace: (call: ts.CallExpression) =>
              loweringPlans.fnctorParameterPreselection?.nativeStringReplaceCall === call &&
              loweringPlans.fnctorParameterPreselectionIsCurrent?.() === true,
          }
        : {}),
      supportsStringArrayLiterals: !ctx.fast && (jsHostExterns || ctx.nativeStrings),
      supportsHostIndirectEval: jsHostExterns && !ctx.nativeStrings,
      ...backendCapabilitySelectionOptions,
    });
  const integrationPopulation =
    loweringPlans && !options?.atomicComponent
      ? validateIrIntegrationPopulation(sourceFile, selected, loweringPlans)
      : undefined;
  // Compatibility-only direct callers (principally focused integration
  // tests) do not supply the production planning context. Build the same
  // structural source inventory locally so internal bookkeeping remains
  // ID-addressed; the public no-projection report shape stays unchanged.
  const compatibilityUnitIdByDeclaration = compatibilityInventory
    ? indexIrTerminalDeclarations(sourceFile, compatibilityInventory)
    : undefined;
  const classIdByShape = new Map<IrClassShape, IrClassId>();
  if (loweringPlans?.classShapesById) {
    for (const [classId, shape] of loweringPlans.classShapesById) {
      const declaration = moduleBindingIdentityContext.declarationByClassId.get(classId);
      if (!declaration || shape.classId !== classId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: exact projected class shape ${shape.className} has stale identity ${shape.classId}`,
        );
      }
      classIdByShape.set(shape, classId);
    }
  } else if (classShapes) {
    for (const shape of classShapes.values()) {
      const declaration = moduleBindingIdentityContext.declarationByClassId.get(shape.classId);
      if (!declaration || declaration.name?.text !== shape.className) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: projected class shape ${shape.className} has stale identity ${shape.classId}`,
        );
      }
      classIdByShape.set(shape, shape.classId);
    }
  }
  // (#3142 Slice 2) A claimable, non-empty module-init unit keeps the
  // pipeline alive even with no claimed functions/class members.
  const moduleInitClaim =
    selected.moduleInit && selected.moduleInit.reason === null && selected.moduleInit.stmtCount > 0
      ? selected.moduleInit
      : undefined;
  const requireTerminalOwner = (legacyName: string): IrLegacyUnitProjectionEntry => {
    const owner = activeOwnerProjection.getByLegacyName(legacyName);
    if (!owner) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: ${legacyName} has no exact terminal-owner projection`,
      );
    }
    return owner;
  };
  const requireTerminalOwnerUnitId = (unitId: IrUnitId): IrLegacyUnitProjectionEntry => {
    const owner = activeOwnerProjection.getByUnitId(unitId);
    if (!owner) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: ${unitId} has no exact terminal-owner projection`,
      );
    }
    return owner;
  };
  const unsupportedHostDateOwnerNames = supportsDateSnapshots
    ? new Set<string>()
    : collectSelectedHostDateSnapshotOwners(sourceFile, selected, makeIrHostDateSnapshotResolver(ctx.checker));
  const unsupportedHostDateOwners = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
  for (const legacyName of unsupportedHostDateOwnerNames) {
    const owner = requireTerminalOwner(legacyName);
    unsupportedHostDateOwners.set(owner.unitId, owner);
  }
  const compiled: string[] = [];
  const compiledOwners: string[] = [];
  const compiledArtifactEvidence: IrIntegrationCompiledArtifactEvidence[] = [];
  const preparedCountedStringAppendReceipts: PreparedCountedStringAppendReceipt[] = [];
  const nonRetryableCountedStringOwnerUnitIds = new Set(
    [...(loweringPlans?.countedStringAppends?.values() ?? [])].map((plan) => plan.ownerUnitId),
  );
  const failures = new IrIntegrationFailureLog();
  const { errors } = failures;
  const detachedPreparedPatches: PreparedComponentDetachedPatch<BuiltFn>[] = [];
  let pendingPreparedReceipt: PendingPreparedProgramComponentReceipt | undefined;
  let abortDeferredOpenScopes: (() => void) | undefined;
  let deferredPublicationFinalizing = false;
  // Test-only state captured immediately before the aggregate neutral
  // preflight.  It is checked at the final unsupported report boundary so a
  // mistakenly admitted array/helper cannot mutate registries and then hide
  // behind the independent post-build whitelist.
  const atomicPreflightSnapshot: { value?: AtomicDeferredPreflightSnapshot } = {};
  let atomicPreflightSnapshotChecked = false;
  const abortDeferredPublication = (): void => {
    if (!options?.deferPreparedPublication) return;
    try {
      abortDeferredOpenScopes?.();
    } catch {
      // Preserve the original pre-publication failure. A scope that already
      // closed itself while rejecting is terminal and cannot be aborted again.
    }
  };
  const finishReport = (
    reportCompiled: readonly string[] = compiled,
    reportErrors: readonly IrIntegrationError[] = errors,
    reportCompiledOwners: readonly string[] = compiledOwners,
    reportTerminalFailures: readonly IrIntegrationTerminalFailureEvent[] = failures.terminalFailureEvents,
    reportCompiledArtifactEvidence: readonly IrIntegrationCompiledArtifactEvidence[] = compiledArtifactEvidence,
    reportCountedStringAppendReceipts: readonly PreparedCountedStringAppendReceipt[] = preparedCountedStringAppendReceipts,
  ): IrIntegrationReport => {
    if (options?.deferPreparedPublication && !deferredPublicationFinalizing && !pendingPreparedReceipt) {
      abortDeferredPublication();
    }
    if (
      atomicPreflightSnapshot.value &&
      !atomicPreflightSnapshotChecked &&
      reportErrors.length > 0 &&
      reportCompiled.length === 0 &&
      reportCompiledArtifactEvidence.length === 0 &&
      reportCountedStringAppendReceipts.length === 0 &&
      pendingPreparedReceipt === undefined
    ) {
      atomicPreflightSnapshotChecked = true;
      assertAtomicDeferredPreflightStateUnchanged(ctx, atomicPreflightSnapshot.value);
    }
    const hardenedErrors = [...reportErrors];
    const hardenedTerminalFailures = reportTerminalFailures.map((event) => {
      if (!nonRetryableCountedStringOwnerUnitIds.has(event.unitId)) return event;
      const existingInvariant = event.errors.find((error) => error.outcome.kind === "invariant");
      if (existingInvariant) {
        return event.error === existingInvariant ? event : { ...event, error: existingInvariant };
      }
      if (event.error.outcome.stage === "select") {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `counted-string owner ${event.unitId} retained an exact lowering plan but reported a select-stage terminal failure`,
        );
      }
      const invariant = integrationFailure(event.legacyName, {
        kind: "invariant",
        code: "selection-preparation-mismatch",
        stage: event.error.outcome.stage,
        detail:
          `counted-string owner ${event.unitId} failed after its exact proof was retained and cannot retry direct: ` +
          `${event.error.outcome.code}: ${event.error.outcome.detail}`,
      });
      hardenedErrors.push(invariant);
      return { ...event, error: invariant, errors: [invariant, ...event.errors] };
    });
    return buildIrIntegrationReport(
      reportCompiled,
      hardenedErrors,
      loweringPlans?.ownerProjection,
      reportCompiledOwners,
      hardenedTerminalFailures,
      reportCompiledArtifactEvidence,
      reportCountedStringAppendReceipts,
    );
  };
  const publishPreparedReceipt = (report: IrIntegrationReport): void => {
    if (!options?.deferPreparedPublication) return;
    const sink = options.preparedComponentPublicationSink;
    const openScopes = preparedClosure?.openScopes ?? [];
    if (!sink || !preparedClosure || openScopes.length !== 1) {
      preparedClosure?.abortOpenScopes();
      if (!sink) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "patch",
          "detached prepared integration requires one aggregate publication sink",
        );
      }
      return;
    }
    if (report.errors.length > 0 || detachedPreparedPatches.length === 0) {
      preparedClosure.abortOpenScopes();
      return;
    }
    const open = openScopes[0]!;
    const terminalUnitIds = [...open.terminalUnitIds];
    const preparedComponentIds = new Set(
      terminalUnitIds.map((unitId) => preparedComponentIdByTerminalUnitId.get(unitId)),
    );
    if (preparedComponentIds.size !== 1 || preparedComponentIds.has(undefined)) {
      preparedClosure.abortOpenScopes();
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        "detached prepared integration produced an incomplete component identity",
      );
    }
    const preparedComponentId = [...preparedComponentIds][0]!;
    const expectedTerminalIds = new Set(terminalUnitIds);
    const patchedTerminalIds = new Set<IrUnitId>();
    const patchedArtifactIds = new Set<IrUnitId>();
    const patchedFuncIndices = new Set<number>();
    if (
      expectedTerminalIds.size !== terminalUnitIds.length ||
      detachedPreparedPatches.length !== terminalUnitIds.length
    ) {
      preparedClosure.abortOpenScopes();
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `detached prepared component ${preparedComponentId} does not have one exact terminal patch per terminal`,
      );
    }
    for (const patch of detachedPreparedPatches) {
      if (
        patch.artifactUnitId !== patch.terminalOwnerUnitId ||
        patch.entry.artifactUnitId !== patch.artifactUnitId ||
        patch.entry.terminalOwnerUnitId !== patch.terminalOwnerUnitId ||
        patch.entry.fn.unitId !== patch.artifactUnitId ||
        patch.entry.derivedUnit !== undefined ||
        patch.entry.synthesized === true ||
        patch.entry.classMember === true ||
        patch.entry.moduleInit === true ||
        !Number.isSafeInteger(patch.funcIdx) ||
        patch.funcIdx < 0 ||
        !expectedTerminalIds.has(patch.terminalOwnerUnitId) ||
        preparedComponentIdByTerminalUnitId.get(patch.terminalOwnerUnitId) !== preparedComponentId ||
        patchedTerminalIds.has(patch.terminalOwnerUnitId) ||
        patchedArtifactIds.has(patch.artifactUnitId) ||
        patchedFuncIndices.has(patch.funcIdx)
      ) {
        preparedClosure.abortOpenScopes();
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "patch",
          `detached prepared component ${preparedComponentId} has a foreign, duplicate, or non-terminal patch`,
        );
      }
      patchedTerminalIds.add(patch.terminalOwnerUnitId);
      patchedArtifactIds.add(patch.artifactUnitId);
      patchedFuncIndices.add(patch.funcIdx);
    }
    try {
      const receipt = sink.publish({
        preparedComponentId,
        terminalUnitIds,
        report,
        patches: detachedPreparedPatches,
        assertCurrent: () => {
          for (const patch of detachedPreparedPatches) {
            const current = definedFuncAt(ctx, patch.funcIdx);
            if (
              current !== patch.existing ||
              ctx.irUnitFuncMap.get(patch.artifactUnitId) !== patch.existing ||
              ctx.programAbiSourceCallables?.functionForUnit(patch.artifactUnitId) !== patch.existing
            ) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "patch",
                `prepared component ${preparedComponentId} lost exact allocator authority ${patch.artifactUnitId}`,
              );
            }
            if (
              patch.existing.typeIdx !== patch.replacement.typeIdx ||
              patch.existing.name !== patch.replacement.name ||
              patch.existing.exported !== patch.replacement.exported
            ) {
              throw new IrInvariantError(
                "abi-type-index-mismatch",
                "patch",
                `prepared component ${preparedComponentId} lost callable contract for ${patch.entry.name}`,
              );
            }
            const bindingId = unitCallableSlots.get(patch.artifactUnitId)?.programAbiBindingId;
            if (bindingId !== undefined && open.lookup.locatorObject(bindingId) !== patch.existing) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "patch",
                `prepared component ${preparedComponentId} lost ABI locator for ${patch.artifactUnitId}`,
              );
            }
          }
        },
        prepareSeal: () => open.scope.prepareSeal(),
        scopePublicationState: () => open.scope.publicationState,
        abortScope: () => open.scope.abort(),
      });
      pendingPreparedReceipt = receipt;
    } catch (error) {
      preparedClosure.abortOpenScopes();
      throw error;
    }
  };
  // #1370 Phase B: don't short-circuit when only class members are claimed —
  // a source file may declare a class with IR-eligible methods but no
  // top-level FunctionDeclarations.
  if (
    selected.funcs.size === 0 &&
    (!selected.classMemberUnitIds || selected.classMemberUnitIds.size === 0) &&
    (!selected.classMembers || selected.classMembers.size === 0) &&
    !moduleInitClaim
  ) {
    return finishReport();
  }

  // Build the calleeTypes map once — every IR-path function's lowerer
  // sees the same view, keyed by every selected function's propagated
  // signature. This is how cross-function calls keep their signatures
  // consistent on the IR side.
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  if (overrides) {
    for (const name of selected.funcs) {
      const o = effectiveOverride(name);
      if (o) calleeTypes.set(name, { params: o.params, returnType: o.returnType });
    }
  }

  const directCallTargets = new Map<string, IrDirectCallTarget>();
  if (loweringPlans) {
    const sourceSignatures = loweringPlans.directCallSignaturesByUnitId ?? loweringPlans.signaturesByUnitId;
    for (const [legacyName, unitId] of loweringPlans.ownerUnitIdByLegacyName) {
      const signature = sourceSignatures.get(unitId);
      if (!signature) continue;
      directCallTargets.set(legacyName, {
        target: irUnitFuncRef({ unitId, name: legacyName }),
        signature,
      });
    }
  }
  if (loweringPlans?.fnctorParameterPreselection && loweringPlans.fnctorParameterPreselectionIsCurrent) {
    if (!loweringPlans.fnctorParameterPreselectionIsCurrent()) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "ir/integration: exact fnctor parameter preselection became stale before lowering",
      );
    }
  }
  const externrefType = irVal({ kind: "externref" });
  const numberType = irVal({ kind: "f64" });
  const exactFnctorBoundaries = loweringPlans?.fnctorNativeStringBoundaries;
  if (loweringPlans && exactFnctorBoundaries) {
    for (const boundary of exactFnctorBoundaries.values()) {
      const previous = directCallTargets.get(boundary.builtin);
      if (
        previous &&
        (previous.target.binding.kind !== "runtime" ||
          previous.target.binding.symbol !== boundary.builtin ||
          previous.target.name !== boundary.target.name)
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: exact fnctor boundary ${boundary.builtin} conflicts with another callable target`,
        );
      }
      directCallTargets.set(boundary.builtin, {
        target: boundary.target,
        signature: boundary.signature,
      });
    }
  } else if (!loweringPlans?.fnctorParameterPreselection) {
    // Functions outside the exact linked fnctor route still use the
    // established name-keyed parser adapter compatibility path. The exact
    // linked route above has checker-certified AST-site boundary plans.
    if (selected.funcs.has("stringToNumber") && !directCallTargets.has("parseFloat") && ctx.funcMap.has("parseFloat")) {
      directCallTargets.set("parseFloat", {
        target: irRuntimeFuncRef("parseFloat"),
        signature: { params: [externrefType], returnType: numberType },
      });
    }
    if (selected.funcs.has("stringToNumber") && !directCallTargets.has("parseInt") && ctx.funcMap.has("parseInt")) {
      directCallTargets.set("parseInt", {
        target: irRuntimeFuncRef("parseInt"),
        signature: { params: [externrefType, numberType], returnType: numberType },
      });
    }
  }
  const { directCalls: preparedDirectCalls, collect: directCallsFor } = makeIrDirectCallReconciler(
    sourceFile,
    loweringPlans,
    directCallTargets,
  );

  for (const owner of unsupportedHostDateOwners.values()) {
    failures.record(
      owner,
      integrationFailure(owner.legacyName, {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: "host Date snapshots are unavailable for the selected backend target/provider",
      }),
    );
  }

  // M1A.3: aggregate publication cannot afford to discover a vector, array,
  // helper, or other allocator-bearing shape after the builder has already
  // touched shared registries.  Keep this check before AllocSiteRegistry,
  // UnionStructRegistry, the from-AST resolver, and every AST-to-IR build.
  // The post-build IR whitelist below remains independent and intentionally
  // stays in place as a second defence.
  const pendingLateImportShiftInjection = process.env.JS2WASM_TEST_ARM_MULTI_PREPARED_PENDING_LATE_IMPORT_SHIFT;
  if (pendingLateImportShiftInjection !== undefined) {
    if (!options?.atomicComponent || !options.deferPreparedPublication || pendingLateImportShiftInjection !== "1") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `invalid JS2WASM_TEST_ARM_MULTI_PREPARED_PENDING_LATE_IMPORT_SHIFT selector ${JSON.stringify(
          pendingLateImportShiftInjection,
        )}`,
      );
    }
    const injectedImport = ensureLateImport(
      ctx,
      "__js2wasm_test_prepared_pending_shift",
      [{ kind: "i32" }],
      [{ kind: "i32" }],
    );
    if (injectedImport === undefined || ctx.pendingLateImportShift === null) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "pending-late-import-shift test seam did not arm a real deferred import batch",
      );
    }
  }
  atomicPreflightSnapshot.value =
    options?.atomicComponent &&
    options.deferPreparedPublication &&
    process.env.JS2WASM_TEST_ASSERT_MULTI_PREPARED_PREFLIGHT_READ_ONLY === "1"
      ? snapshotAtomicDeferredPreflightState(ctx)
      : undefined;
  if (options?.atomicComponent && options.deferPreparedPublication) {
    const preflightDetail = atomicDeferredComponentPreflightFailure(
      integrationSourceFiles,
      selected,
      loweringPlans,
      moduleBindingIdentityContext,
      ctx.checker,
      ctx.pendingLateImportShift,
    );
    if (preflightDetail) {
      const preflightFailure: IrPreparationFailure = {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: `${preflightDetail}; retaining direct bodies`,
      };
      for (const owner of loweringPlans?.ownerProjection.entries ?? []) {
        if (failures.terminalFailureEvents.some((event) => event.unitId === owner.unitId)) continue;
        failures.record(owner, integrationFailure(owner.legacyName, preflightFailure));
      }
      return finishReport();
    }
  }

  // #1586: one allocation-site registry per module compile. Threaded into the
  // builder (mints ids on value-creating instrs) and every pass (preserve /
  // fork / retire discipline). `alloc` ids are inert at lowering, so wiring the
  // registry does not change emitted Wasm.
  const allocRegistry = new AllocSiteRegistry();
  // #1588 PR-B: expose the registry on the context so the string-lowering
  // sites (literal / concat materialization) can read the `encoding`
  // annotation when `--utf8-storage` is on. Inert when off (sites never read).
  ctx.allocRegistry = allocRegistry;

  // Single shared union-struct registry across all IR-path functions in this
  // compilation. Registering a union once produces one WasmGC struct type;
  // subsequent `box`/`unbox`/`tag.test` uses from any function see the same
  // type index. The sink writes into `ctx.mod.types` directly so the
  // registered struct participates in the module's usual type emission.
  const unionRegistry = new UnionStructRegistry({
    push(def: StructTypeDef): number {
      const idx = ctx.mod.types.length;
      ctx.mod.types.push(def);
      return idx;
    },
  });

  // -------------------------------------------------------------------------
  // Phase 1 prep — From-ast resolver (#1185).
  //
  // The from-ast layer needs three resolver methods at build time:
  //   - `nativeStrings()` — drives the for-of strategy switch
  //   - `resolveString()` — slot ValType for string for-of
  //   - `resolveVec(valTy)` — element + array typeIdx for vec for-of
  //
  // None of these depend on the lazy registries (object / closure /
  // class) that get filled in during Phase 3, so we can build the
  // subset eagerly here. The full `IrLowerResolver` is built later in
  // Phase 3 once the registries exist; both share the same underlying
  // logic for the methods both expose.
  // -------------------------------------------------------------------------
  const fromAstResolver = makeFromAstResolver(
    ctx,
    moduleBindingResolver,
    loweringPlans?.postWasmStartTdzSafeBindingsByOwnerUnitId,
    standaloneDomCapability,
    loweringPlans?.fnctorParameterPreselection,
    loweringPlans?.fnctorParameterPreselectionIsCurrent,
  );

  // -------------------------------------------------------------------------
  // Phase 1 — Build: lower every selected AST function to an IrFunction.
  // -------------------------------------------------------------------------
  const built: BuiltFn[] = [];
  const requireArtifactUnitId = (declaration: ts.Node, displayName: string) => {
    const unitId =
      integrationPopulation?.ownerUnitIdByDeclaration.get(declaration) ??
      (options?.atomicComponent ? moduleBindingIdentityContext.unitIdByDeclaration.get(declaration) : undefined) ??
      compatibilityUnitIdByDeclaration?.get(declaration);
    if (!unitId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/integration: ${displayName} has no exact artifact identity`,
      );
    }
    return unitId;
  };
  const verifyBuiltArtifact = (
    fn: IrFunction,
    ownerName: string,
    synthesized: boolean,
  ): ReturnType<typeof verifyIrFunction> => {
    const injection = process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE;
    const inject = injection === "1" || injection === ownerName || (injection === "synthetic" && synthesized);
    if (!inject || fn.blocks.length === 0) return verifyIrFunction(fn);
    const first = fn.blocks[0]!;
    const malformed: IrFunction = {
      ...fn,
      blocks: [{ ...first, id: ((first.id as number) + 1) as typeof first.id }, ...fn.blocks.slice(1)],
    };
    return verifyIrFunction(malformed);
  };
  for (const integrationSourceFile of integrationSourceFiles) {
    for (const stmt of integrationSourceFile.statements) {
      if (!ts.isFunctionDeclaration(stmt)) continue;
      if (!stmt.body) continue;
      const declarationUnitId = moduleBindingIdentityContext.unitIdByDeclaration.get(stmt);
      const name = declarationUnitId
        ? activeOwnerProjection?.getByUnitId(declarationUnitId)?.legacyName
        : stmt.name?.text;
      if (!name || !selected.funcs.has(name)) continue;
      const owner = requireTerminalOwner(name);
      if (unsupportedHostDateOwners.has(owner.unitId)) continue;

      try {
        // #1923 — test-only seam: simulate a build-time demotion on a CLAIMED
        // function so the post-claim metering + gate can be exercised without a
        // real compiler regression in the corpus. Off in every normal build.
        if (process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW) {
          throw new Error(`ir/from-ast: injected test build failure (${name})`);
        }
        const ownerUnitId = requireArtifactUnitId(stmt, name);
        if (ownerUnitId !== owner.unitId) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "build",
            `ir/integration: ${name} artifact ${ownerUnitId} does not match terminal owner ${owner.unitId}`,
          );
        }
        const o = effectiveOverride(name);
        const lowered = lowerFunctionAstToIr(stmt, {
          exported: hasExportModifier(stmt),
          funcName: name,
          ownerUnitId,
          directCalls: directCallsFor(stmt, ownerUnitId),
          fnctorParameterPreselection: loweringPlans?.fnctorParameterPreselection,
          fnctorNativeStringBoundaries: loweringPlans?.fnctorNativeStringBoundaries,
          paramTypeOverrides: o?.params,
          returnTypeOverride: o?.returnType,
          calleeTypes,
          importedCalls: loweringPlans?.importedCalls,
          topLevelFunctionValues: loweringPlans?.topLevelFunctionValues,
          hostVoidCallbacks: loweringPlans?.hostVoidCallbacks,
          hostDateSnapshots: loweringPlans?.hostDateSnapshots,
          hostDateGetters: loweringPlans?.hostDateGetters,
          promiseDelays: loweringPlans?.promiseDelays,
          countedStringAppends: loweringPlans?.countedStringAppends,
          identityContext: moduleBindingIdentityContext,
          classShapes,
          // Slice 6 part 4 refactor (#1185): thread the from-ast subset
          // of the IR resolver. Replaces the per-feature `nativeStrings:
          // boolean` + `anyStrTypeIdx: number` shortcuts that #1183 added.
          resolver: fromAstResolver,
          allocRegistry,
          // #2780 (hybrid Row 6): thread the TS checker so `lowerArrayLiteral`
          // can discharge the widening-escape proof via `getContextualType`.
          checker: ctx.checker,
          oracle: ctx.oracle,
          // #3765: share direct-codegen's grounded numeric-local oracle with IR.
          numericLocalScalarForDecl: (decl) => ctx.usageInference.scalarForDecl(decl),
          hostDynamicClassMethodNames: ctx.hostDynamicClassMethodNames,
        });
        const result = prepareSuspendingAsyncLowering(
          lowered,
          ownerUnitId,
          name,
          loweringPlans?.suspendingAsyncUnitIds,
          // (#3526 F1-S1) The same resolved fact manifest freeze consumes, so
          // the numeric-tail elision keeps its exact pre-F1-S1 population.
          integrationNumberBoundaryPolicy(ctx),
        );
        if (result.main.unitId !== ownerUnitId) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "build",
            `ir/integration: ${name} lowered as artifact ${result.main.unitId}, expected ${ownerUnitId}`,
          );
        }
        const liftedAbiRecords = liftedProgramAbiRecords(result, ownerUnitId, owner.unitId);
        const mainErrors = verifyBuiltArtifact(result.main, name, false);
        if (mainErrors.length > 0) {
          failures.recordVerifierDetails(owner, mainErrors);
          continue;
        }
        // Slice 3 (#1169c): verify each lifted function before pushing.
        const anyLiftedFailed = failures.recordVerifierGroups(
          owner,
          result.lifted.map((lifted) => ({
            details: verifyBuiltArtifact(lifted, name, true),
            detailPrefix: `synthetic artifact ${lifted.name}: `,
          })),
        );
        if (anyLiftedFailed) continue;

        built.push({
          artifactUnitId: result.main.unitId,
          terminalOwnerUnitId: owner.unitId,
          name,
          ownerName: owner.legacyName,
          fn: result.main,
          ...(result.countedStringAppendPlans ? { countedStringAppendPlans: result.countedStringAppendPlans } : {}),
        });
        for (const lifted of result.lifted) {
          built.push({
            artifactUnitId: lifted.unitId,
            terminalOwnerUnitId: owner.unitId,
            name: lifted.name,
            ownerName: owner.legacyName,
            fn: lifted,
            derivedUnit: liftedAbiRecords.get(lifted.unitId),
            synthesized: true,
          });
        }
      } catch (e) {
        failures.record(owner, caughtIntegrationFailure(owner.legacyName, e, "build"));
      }
    }
  }

  // -------------------------------------------------------------------------
  // #1370 Phase B — Build IR functions for class members claimed by the
  // selector. Mirrors the FunctionDeclaration loop above:
  //
  //   1. Walk class declarations from sourceFile.statements.
  //   2. Filter to MethodDeclarations whose synthetic name is in
  //      `selected.classMembers`.
  //   3. Instance methods receive the projected `self` parameter. Static
  //      methods are ordinary no-receiver callables. Constructors use Phase
  //      C's `struct.new + __self` epilogue.
  //   4. For each eligible method:
  //      - Look up the class's `IrClassShape` from the resolver-supplied
  //        `classShapes` map. Skip if absent (legacy class shape couldn't
  //        be projected — leave on legacy).
  //      - Call `lowerFunctionAstToIr(member, { funcName, selfParam: { type:
  //        IrType.class }, classShapes, resolver, calleeTypes })`. The
  //        widened lowerFunctionAstToIr (Phase B in from-ast.ts) injects
  //        a `__self` first param matching the legacy struct-ref slot.
  //      - Verify the IrFunction.
  //      - Push to `built` with `classMember: true`. The Phase 3 slot
  //        patch performs a typeIdx parity check before overwriting.
  // -------------------------------------------------------------------------
  if (selected.classMemberUnitIds !== undefined) {
    for (const selectedUnitId of selected.classMemberUnitIds) {
      const member = moduleBindingIdentityContext.declarationByUnitId.get(selectedUnitId);
      const terminal = moduleBindingIdentityContext.terminalByUnitId.get(selectedUnitId);
      if (
        !member ||
        (!ts.isClassDeclaration(member) &&
          !ts.isClassExpression(member) &&
          !ts.isConstructorDeclaration(member) &&
          !ts.isMethodDeclaration(member) &&
          !ts.isGetAccessorDeclaration(member) &&
          !ts.isSetAccessorDeclaration(member)) ||
        !terminal ||
        terminal.observedKind !== "class-member" ||
        ((ts.isConstructorDeclaration(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
          !member.body)
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: exact class member ${selectedUnitId} has no callable terminal declaration`,
        );
      }
      const isImplicitCtorMember = terminal.kind === "class-implicit-constructor";
      const classDeclaration = isImplicitCtorMember ? member : member.parent;
      if (!ts.isClassDeclaration(classDeclaration) && !ts.isClassExpression(classDeclaration)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: exact class member ${selectedUnitId} has no class declaration`,
        );
      }
      const classId = moduleBindingIdentityContext.classIdByDeclaration.get(classDeclaration);
      const classShape = classId === undefined ? undefined : loweringPlans?.classShapesById?.get(classId);
      if (!classId || terminal.lexicalOwnerId !== classId || !classShape || classShape.classId !== classId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: exact class member ${selectedUnitId} has no exact projected class shape`,
        );
      }
      const isCtorMember = ts.isConstructorDeclaration(member) || isImplicitCtorMember;
      const isStatic = terminal.staticClassMember;
      const descriptorKind = ts.isMethodDeclaration(member)
        ? isStatic
          ? "static"
          : "method"
        : ts.isGetAccessorDeclaration(member)
          ? "getter"
          : ts.isSetAccessorDeclaration(member)
            ? "setter"
            : undefined;
      const descriptors = isCtorMember
        ? []
        : classShape.methods.filter(
            (candidate) =>
              candidate.placement?.classId === classId &&
              candidate.placement.unitId === selectedUnitId &&
              candidate.placement.staticClassMember === isStatic &&
              (candidate.memberKind ?? "method") === descriptorKind &&
              candidate.target?.binding.kind === "unit" &&
              candidate.target.binding.unitId === selectedUnitId,
          );
      const descriptor = descriptors.length === 1 ? descriptors[0] : undefined;
      if (!isCtorMember && !descriptor) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: exact class member ${selectedUnitId} has no unique placed ${descriptorKind} descriptor`,
        );
      }
      const allocated = ctx.programAbiClassCallables?.functionForUnit(selectedUnitId);
      if (!allocated) {
        throw new IrInvariantError(
          "missing-function-slot",
          "build",
          `ir/integration: exact class member ${selectedUnitId} has no observed Program ABI callable`,
        );
      }
      const owner = requireTerminalOwnerUnitId(selectedUnitId);
      const semanticName = owner.legacyName;
      try {
        const paramTypeOverrides = isCtorMember ? classShape.constructorParams : descriptor!.params;
        const returnTypeOverride = isCtorMember ? undefined : descriptor!.returnType;
        const ownerUnitId = requireArtifactUnitId(member, semanticName);
        if (ownerUnitId !== selectedUnitId || ownerUnitId !== owner.unitId) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "build",
            `ir/integration: ${semanticName} artifact ${ownerUnitId} does not match exact owner ${selectedUnitId}`,
          );
        }
        const constructorFieldInitializers = isCtorMember
          ? collectIrClassInstanceInitializers(classDeclaration)
          : undefined;
        if (isCtorMember && constructorFieldInitializers === undefined) {
          throw new IrUnsupportedError(
            "class-member-unsupported",
            "build",
            `ir/integration: ${semanticName} has a dynamically computed instance field name`,
          );
        }
        if (!isImplicitCtorMember) directCallsFor(member, ownerUnitId);
        for (const initializer of constructorFieldInitializers ?? []) {
          directCallsFor(initializer.expression, ownerUnitId);
        }
        const loweringOptions: AstToIrOptions = {
          exported: false,
          funcName: semanticName,
          ownerUnitId,
          directCalls: preparedDirectCalls,
          fnctorParameterPreselection: loweringPlans?.fnctorParameterPreselection,
          fnctorNativeStringBoundaries: loweringPlans?.fnctorNativeStringBoundaries,
          ...(isCtorMember
            ? {
                constructorInitClassShape: classShape,
                paramTypeOverrides,
                constructorFieldInitializers,
                ...(isImplicitCtorMember && classShape.parent
                  ? { implicitConstructorParentShape: classShape.parent }
                  : {}),
              }
            : terminal.kind === "class-static-method"
              ? { paramTypeOverrides, returnTypeOverride }
              : {
                  // Static accessors retain the legacy leading class-struct
                  // ABI slot even though bounded bodies may not consume it.
                  selfParam: { type: { kind: "class", shape: classShape } as IrType },
                  paramTypeOverrides,
                  returnTypeOverride,
                }),
          calleeTypes,
          importedCalls: loweringPlans?.importedCalls,
          topLevelFunctionValues: loweringPlans?.topLevelFunctionValues,
          hostVoidCallbacks: loweringPlans?.hostVoidCallbacks,
          hostDateSnapshots: loweringPlans?.hostDateSnapshots,
          hostDateGetters: loweringPlans?.hostDateGetters,
          identityContext: moduleBindingIdentityContext,
          classShapes,
          resolver: fromAstResolver,
          allocRegistry,
          checker: ctx.checker,
          oracle: ctx.oracle,
          numericLocalScalarForDecl: (decl: ts.VariableDeclaration) => ctx.usageInference.scalarForDecl(decl),
          hostDynamicClassMethodNames: ctx.hostDynamicClassMethodNames,
        };
        let result: LoweredFunctionResult;
        if (ts.isClassDeclaration(member) || ts.isClassExpression(member)) {
          if (!isImplicitCtorMember) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "build",
              `ir/integration: non-implicit member ${semanticName} resolves to a class declaration`,
            );
          }
          result = lowerImplicitConstructorAstToIr(member, {
            ...loweringOptions,
            constructorInitClassShape: classShape,
          });
        } else {
          if (isImplicitCtorMember) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "build",
              `ir/integration: implicit constructor ${semanticName} lost its class declaration`,
            );
          }
          result = lowerFunctionAstToIr(member, loweringOptions);
        }
        if (result.main.unitId !== selectedUnitId) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "build",
            `ir/integration: ${semanticName} lowered as ${result.main.unitId}, expected ${selectedUnitId}`,
          );
        }
        const liftedAbiRecords = liftedProgramAbiRecords(result, selectedUnitId, owner.unitId);
        const mainErrors = verifyBuiltArtifact(result.main, semanticName, false);
        if (mainErrors.length > 0) {
          failures.recordVerifierDetails(owner, mainErrors);
          continue;
        }
        const anyLiftedFailed = failures.recordVerifierGroups(
          owner,
          result.lifted.map((lifted) => ({
            details: verifyBuiltArtifact(lifted, semanticName, true),
            detailPrefix: `synthetic artifact ${lifted.name}: `,
          })),
        );
        if (anyLiftedFailed) continue;
        built.push({
          artifactUnitId: selectedUnitId,
          terminalOwnerUnitId: owner.unitId,
          // Exact Program ABI identity locates the physical slot. Keep public
          // compilation evidence on the semantic source label (`A_new` for a
          // constructor whose physical body is `A_init`).
          name: semanticName,
          ownerName: owner.legacyName,
          fn: result.main,
          classMember: true,
        });
        for (const lifted of result.lifted) {
          built.push({
            artifactUnitId: lifted.unitId,
            terminalOwnerUnitId: owner.unitId,
            name: lifted.name,
            ownerName: owner.legacyName,
            fn: lifted,
            derivedUnit: liftedAbiRecords.get(lifted.unitId),
            synthesized: true,
          });
        }
      } catch (e) {
        failures.record(owner, caughtIntegrationFailure(owner.legacyName, e, "build"));
      }
    }
  } else if (selected.classMembers && selected.classMembers.size > 0) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const className = stmt.name.text;

      // #3000-E: `buildIrClassShapes` now seeds single-level subclasses of a
      // LOCAL user class (the shape carries `.parent`), so the wholesale
      // `extends`-skip that used to sit here is gone — the shape presence IS the
      // gate. A subclass of a builtin / externref-backed parent still gets NO
      // shape there, so the `if (!classShape) continue;` below keeps it on legacy;
      // the selector's `parentIsLocalClass` gate mirrors this exactly, so a
      // claimed subclass member always finds its shape (no post-claim demotion).
      const classShape = classShapes?.get(className);
      if (!classShape) continue;

      for (const member of stmt.members) {
        // Phase B — instance methods + (#3000-B) instance get/set accessors +
        // (#3000-C) the constructor + (#3522) static methods. Static accessors
        // still remain selector-unsupported. Abstract methods have no body —
        // Phase A already rejected them as `class-method`.
        const isCtorMember = ts.isConstructorDeclaration(member);
        const isAccessor = ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
        const isStaticMethod =
          ts.isMethodDeclaration(member) &&
          (member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false);
        if (!ts.isMethodDeclaration(member) && !isAccessor && !isCtorMember) continue;
        if (!member.body) continue;
        // Non-ctor members: skip nameless / static accessors / abstract. A
        // constructor carries no `.name`, is never static, and never abstract.
        if (!isCtorMember) {
          if (!member.name) continue;
          const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
          if (isStatic && !isStaticMethod) continue;
          if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) continue;
        }

        // #3000-C: the constructor's synthetic funcMap key is `${className}_new`
        // (mirrors `class-bodies.ts`). Methods/accessors compute their key from
        // the member name below.
        let memberName: string;
        let memberBaseName: string | undefined;
        let descriptorKind: "method" | "getter" | "setter" | "static" | undefined;
        if (isCtorMember) {
          memberName = `${className}_new`;
        } else {
          // Phase A's `phase1MemberName` admits identifier / string-literal /
          // numeric-literal — replicate the dispatch here without re-importing
          // the helper (it's selector-private). The synthetic name format
          // mirrors `class-bodies.ts:275` exactly.
          if (ts.isIdentifier(member.name!)) memberBaseName = member.name!.text;
          else if (ts.isStringLiteral(member.name!) || ts.isNumericLiteral(member.name!)) {
            memberBaseName = member.name!.text;
          } else continue; // computed / private name — skipped by selector

          // #3000-B: accessors register under `${className}_get_${prop}` /
          // `${className}_set_${prop}` funcMap keys (see `class-bodies.ts`); a
          // setter is VOID (`returnTypeOverride: null`), a getter returns
          // `member.type` unchanged. Methods keep `${className}_${name}`.
          if (ts.isGetAccessorDeclaration(member)) {
            memberName = `${className}_get_${memberBaseName}`;
            descriptorKind = "getter";
          } else if (ts.isSetAccessorDeclaration(member)) {
            memberName = `${className}_set_${memberBaseName}`;
            descriptorKind = "setter";
          } else {
            memberName = `${className}_${memberBaseName}`;
            descriptorKind = isStaticMethod ? "static" : "method";
          }
        }
        if (!selected.classMembers.has(memberName)) continue;
        const owner = requireTerminalOwner(memberName);

        try {
          const descriptor = isCtorMember
            ? undefined
            : classShape.methods.find(
                (candidate) =>
                  candidate.name === memberBaseName && (candidate.memberKind ?? "method") === descriptorKind,
              );
          if (!isCtorMember && !descriptor) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "build",
              `ir/integration: selected class member ${memberName} has no exact ${descriptorKind} descriptor`,
            );
          }
          const paramTypeOverrides = isCtorMember ? classShape.constructorParams : descriptor!.params;
          const returnTypeOverride = isCtorMember ? undefined : descriptor!.returnType;
          const ownerUnitId = requireArtifactUnitId(member, memberName);
          if (ownerUnitId !== owner.unitId) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "build",
              `ir/integration: ${memberName} artifact ${ownerUnitId} does not match terminal owner ${owner.unitId}`,
            );
          }
          // #3522: the source constructor owns `<Class>_init`. Its receiver is
          // the final parameter, matching the frozen direct ABI; `<Class>_new`
          // is an AST-free allocation wrapper. Methods/accessors retain their
          // caller-supplied FIRST `selfParam`.
          const result = lowerFunctionAstToIr(member, {
            exported: false, // class members are not directly exported
            funcName: memberName,
            ownerUnitId,
            directCalls: directCallsFor(member, ownerUnitId),
            fnctorParameterPreselection: loweringPlans?.fnctorParameterPreselection,
            fnctorNativeStringBoundaries: loweringPlans?.fnctorNativeStringBoundaries,
            ...(isCtorMember
              ? { constructorInitClassShape: classShape, paramTypeOverrides }
              : isStaticMethod
                ? { paramTypeOverrides, returnTypeOverride }
                : {
                    selfParam: { type: { kind: "class", shape: classShape } as IrType },
                    paramTypeOverrides,
                    returnTypeOverride,
                  }),
            calleeTypes,
            importedCalls: loweringPlans?.importedCalls,
            topLevelFunctionValues: loweringPlans?.topLevelFunctionValues,
            hostVoidCallbacks: loweringPlans?.hostVoidCallbacks,
            hostDateSnapshots: loweringPlans?.hostDateSnapshots,
            hostDateGetters: loweringPlans?.hostDateGetters,
            identityContext: moduleBindingIdentityContext,
            classShapes,
            resolver: fromAstResolver,
            allocRegistry,
            // #2780 (hybrid Row 6): thread the TS checker for the
            // ArrayLiteral widening-escape proof in method bodies too.
            checker: ctx.checker,
            oracle: ctx.oracle,
            numericLocalScalarForDecl: (decl) => ctx.usageInference.scalarForDecl(decl),
            hostDynamicClassMethodNames: ctx.hostDynamicClassMethodNames,
          });
          if (result.main.unitId !== ownerUnitId) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "build",
              `ir/integration: ${memberName} lowered as artifact ${result.main.unitId}, expected ${ownerUnitId}`,
            );
          }
          const liftedAbiRecords = liftedProgramAbiRecords(result, ownerUnitId, owner.unitId);
          const mainErrors = verifyBuiltArtifact(result.main, memberName, false);
          if (mainErrors.length > 0) {
            failures.recordVerifierDetails(owner, mainErrors);
            continue;
          }
          // Class method bodies should not produce lifted closures in Phase B
          // (Phase 1 shape doesn't allow nested function decls inside method
          // bodies that capture `this`). Defensive re-verify if any appear.
          const anyLiftedFailed = failures.recordVerifierGroups(
            owner,
            result.lifted.map((lifted) => ({
              details: verifyBuiltArtifact(lifted, memberName, true),
              detailPrefix: `synthetic artifact ${lifted.name}: `,
            })),
          );
          if (anyLiftedFailed) continue;

          built.push({
            artifactUnitId: result.main.unitId,
            terminalOwnerUnitId: owner.unitId,
            name: memberName,
            ownerName: owner.legacyName,
            fn: result.main,
            classMember: true,
          });
          for (const lifted of result.lifted) {
            built.push({
              artifactUnitId: lifted.unitId,
              terminalOwnerUnitId: owner.unitId,
              name: lifted.name,
              ownerName: owner.legacyName,
              fn: lifted,
              derivedUnit: liftedAbiRecords.get(lifted.unitId),
              synthesized: true,
            });
          }
        } catch (e) {
          failures.record(owner, caughtIntegrationFailure(owner.legacyName, e, "build"));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // (#3142 Slice 2) — Build the IR function for a claimable module-init unit.
  //
  // The unit lowers the SAME population the selector assessed
  // (`collectModuleInitPopulation`) through the ordinary from-ast path in
  // `moduleInitUnit` mode: statements lower as plain body statements
  // (constructor-body precedent) and top-level `let`/`const` bindings write
  // the legacy-allocated `__mod_<name>` globals via symbolic global refs, so
  // every other function observes exactly the storage legacy init wrote.
  //
  // Integration-time gates (each throws → the owner stays on the selected
  // direct route). In the bounded R4 prepared route the exact callable is
  // preallocated and a successful component enters the IR-first skip set;
  // every other module-init shape still reaches this as a post-direct overlay:
  //   - the exact module-init slot must exist, either preallocated by the
  //     prepared route or emitted by legacy (legacy may drop side-effect-free
  //     statements and emit nothing — then there is nothing to patch),
  //   - no static class initializers / live-func-binding seeds (legacy
  //     prepends those to the SAME body; replacing it would drop them),
  //   - every top-level binding must map to an f64/i32-backed module global
  //     (Slice 2 scope: numeric/boolean module state),
  //   - no direct top-level `throw` outside WASI (legacy DROPS those — see
  //     the #1789-adjacent collection note in declarations.ts; executing
  //     them would diverge from the legacy baseline).
  // -------------------------------------------------------------------------
  const moduleInitOwner = moduleInitClaim ? requireTerminalOwner(MODULE_INIT_UNIT_NAME) : undefined;
  if (moduleInitClaim && moduleInitOwner && !unsupportedHostDateOwners.has(moduleInitOwner.unitId)) {
    try {
      if (!ctx.programAbiModuleInitCallables?.functionForUnit(moduleInitOwner.unitId)) {
        throw new IrUnsupportedError(
          "module-init-legacy-coupling",
          "build",
          "module-init: no exact legacy initializer slot to patch (legacy collected no init statements)",
        );
      }
      if (ctx.staticInitExprs.length > 0) {
        throw new IrUnsupportedError(
          "module-init-legacy-coupling",
          "build",
          "module-init: static class initializers present — legacy body carries them",
        );
      }
      if ((ctx.liveFuncBindingGlobals?.size ?? 0) > 0) {
        throw new IrUnsupportedError(
          "module-init-legacy-coupling",
          "build",
          "module-init: live function-binding seeds present — legacy body carries them",
        );
      }
      const population = integrationPopulation?.moduleInitPopulation ?? collectModuleInitPopulation(sourceFile);
      if (!ctx.wasi) {
        for (const s of population) {
          if (ts.isThrowStatement(s)) {
            throw new IrUnsupportedError(
              "module-init-legacy-coupling",
              "build",
              "module-init: top-level throw is dropped by legacy outside WASI — keeping legacy body",
            );
          }
        }
      }
      const moduleBindings = buildModuleBindingsMap(ctx, population, moduleBindingResolver);
      const synthetic = makeModuleInitSynthetic(population);
      const moduleInitUnitId =
        integrationPopulation?.moduleInitUnitId ?? compatibilityUnitIdByDeclaration?.get(sourceFile);
      if (!moduleInitUnitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          "ir/integration: selected module init has no exact artifact identity",
        );
      }
      if (moduleInitUnitId !== moduleInitOwner.unitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: module init artifact ${moduleInitUnitId} does not match terminal owner ${moduleInitOwner.unitId}`,
        );
      }
      for (const statement of population) directCallsFor(statement, moduleInitUnitId);
      const result = lowerFunctionAstToIr(synthetic, {
        exported: false,
        funcName: MODULE_INIT_UNIT_NAME,
        ownerUnitId: moduleInitUnitId,
        directCalls: preparedDirectCalls,
        fnctorParameterPreselection: loweringPlans?.fnctorParameterPreselection,
        fnctorNativeStringBoundaries: loweringPlans?.fnctorNativeStringBoundaries,
        returnTypeOverride: null,
        moduleInitUnit: true,
        moduleBindings,
        calleeTypes,
        importedCalls: loweringPlans?.importedCalls,
        topLevelFunctionValues: loweringPlans?.topLevelFunctionValues,
        hostVoidCallbacks: loweringPlans?.hostVoidCallbacks,
        hostDateSnapshots: loweringPlans?.hostDateSnapshots,
        hostDateGetters: loweringPlans?.hostDateGetters,
        identityContext: moduleBindingIdentityContext,
        classShapes,
        resolver: fromAstResolver,
        allocRegistry,
        checker: ctx.checker,
        oracle: ctx.oracle,
        numericLocalScalarForDecl: (decl) => ctx.usageInference.scalarForDecl(decl),
        hostDynamicClassMethodNames: ctx.hostDynamicClassMethodNames,
      });
      if (result.main.unitId !== moduleInitUnitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/integration: module init lowered as artifact ${result.main.unitId}, expected ${moduleInitUnitId}`,
        );
      }
      const liftedAbiRecords = liftedProgramAbiRecords(result, moduleInitUnitId, moduleInitOwner.unitId);
      const mainErrors = verifyBuiltArtifact(result.main, MODULE_INIT_UNIT_NAME, false);
      if (mainErrors.length > 0) {
        failures.recordVerifierDetails(moduleInitOwner, mainErrors);
      } else {
        const anyLiftedFailed = failures.recordVerifierGroups(
          moduleInitOwner,
          result.lifted.map((lifted) => ({
            details: verifyBuiltArtifact(lifted, MODULE_INIT_UNIT_NAME, true),
            detailPrefix: `synthetic artifact ${lifted.name}: `,
          })),
        );
        if (!anyLiftedFailed) {
          built.push({
            artifactUnitId: result.main.unitId,
            terminalOwnerUnitId: moduleInitOwner.unitId,
            name: MODULE_INIT_UNIT_NAME,
            ownerName: moduleInitOwner.legacyName,
            fn: result.main,
            moduleInit: true,
          });
          for (const lifted of result.lifted) {
            built.push({
              artifactUnitId: lifted.unitId,
              terminalOwnerUnitId: moduleInitOwner.unitId,
              name: lifted.name,
              ownerName: moduleInitOwner.legacyName,
              fn: lifted,
              derivedUnit: liftedAbiRecords.get(lifted.unitId),
              synthesized: true,
            });
          }
        }
      }
    } catch (e) {
      failures.record(moduleInitOwner, caughtIntegrationFailure(moduleInitOwner.legacyName, e, "build"));
    }
  }

  // Aggregate components are staged as one unit. A build-time failure must not
  // leave an earlier source member eligible for a partial patch.
  if (options?.atomicComponent && errors.length > 0) return finishReport();
  if (built.length === 0) return finishReport();
  // -------------------------------------------------------------------------
  // Phase 2 — Pass: per-function hygiene → module-scope inline → re-run
  // hygiene on modified functions. Verify between stages.
  // -------------------------------------------------------------------------
  // 2a. Per-function hygiene (CF → DCE → simplifyCFG to fixpoint).
  const failedOwners = new Set<IrUnitId>();
  const terminalOwnerOf = (entry: BuiltFn): IrLegacyUnitProjectionEntry => ({
    unitId: entry.terminalOwnerUnitId,
    legacyName: entry.ownerName,
  });
  const markOwnerFailure = (
    owner: IrLegacyUnitProjectionEntry,
    artifactUnitId: IrUnitId,
    artifactName: string,
    error: unknown,
    stage: Exclude<IrPreparationStage, "select">,
    diagnosticVisibility: IrIntegrationTerminalFailureEvent["diagnosticVisibility"] = "report",
  ): void => {
    if (failedOwners.has(owner.unitId)) return;
    const classified = classifyIrFailure(error, stage);
    const outcome: IrPreparationFailure =
      artifactUnitId === owner.unitId
        ? classified
        : { ...classified, detail: `synthetic artifact ${artifactName}: ${classified.detail}` };
    failures.record(owner, integrationFailure(owner.legacyName, outcome), diagnosticVisibility);
    failedOwners.add(owner.unitId);
  };
  const markOwnerInvariant = (
    owner: IrLegacyUnitProjectionEntry,
    artifactUnitId: IrUnitId,
    artifactName: string,
    code: IrInvariantCode,
    stage: Exclude<IrPreparationStage, "select">,
    detail: string,
  ): void => markOwnerFailure(owner, artifactUnitId, artifactName, new IrInvariantError(code, stage, detail), stage);
  const failEveryOwner = (
    entries: readonly BuiltFn[],
    error: unknown,
    stage: Exclude<IrPreparationStage, "select">,
  ): void => {
    const owners = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
    for (const entry of entries) {
      const existing = owners.get(entry.terminalOwnerUnitId);
      if (existing && existing.legacyName !== entry.ownerName) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "verify",
          `terminal owner ${entry.terminalOwnerUnitId} has conflicting labels ${existing.legacyName} and ${entry.ownerName}`,
        );
      }
      owners.set(entry.terminalOwnerUnitId, terminalOwnerOf(entry));
    }
    for (const owner of owners.values()) {
      markOwnerFailure(owner, owner.unitId, owner.legacyName, error, stage);
    }
  };
  const retainHealthyOwners = (entries: readonly BuiltFn[]): BuiltFn[] =>
    options?.atomicComponent && failedOwners.size > 0
      ? []
      : entries.filter((entry) => !failedOwners.has(entry.terminalOwnerUnitId));

  const hygieneCandidates: BuiltFn[] = [];
  for (const entry of built) {
    try {
      if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "hygiene-synthetic" && entry.synthesized) {
        throw new Error("injected synthetic hygiene failure");
      }
      const optimized = runHygienePasses(entry.fn, allocRegistry);
      const postErrors = verifyIrFunction(optimized);
      if (postErrors.length > 0) {
        throw new IrInvariantError(
          "verifier-failure",
          "verify",
          `post-hygiene verify: ${postErrors.map((error) => error.message).join("; ")}`,
          postErrors,
        );
      }
      assertAllocProvenance(optimized, allocRegistry);
      hygieneCandidates.push({ ...entry, fn: optimized });
    } catch (error) {
      markOwnerFailure(terminalOwnerOf(entry), entry.artifactUnitId, entry.name, error, "verify");
    }
  }
  let afterHygiene = retainHealthyOwners(hygieneCandidates);

  if (afterHygiene.length === 0) return finishReport();

  // #1588: string-encoding analysis. Read-only over the hygiene-stable IR;
  // writes `encoding` annotations onto string allocation sites in the
  // registry (`ALLOC_NAMESPACES.encoding`). Annotations are advisory and
  // inert at lowering, so the emitted Wasm is unchanged. Later passes
  // (inline/mono) preserve or alias the alloc ids, so an annotation written
  // here travels to the canonical site via the registry's alias merge.
  for (const entry of afterHygiene) {
    try {
      analyzeEncoding(entry.fn, allocRegistry);
    } catch (error) {
      markOwnerFailure(terminalOwnerOf(entry), entry.artifactUnitId, entry.name, error, "verify");
    }
  }
  afterHygiene = retainHealthyOwners(afterHygiene);
  if (afterHygiene.length === 0) return finishReport();

  // 2b. Module-scope inlining (#1167b).
  const modIn: IrModule = { functions: afterHygiene.map((e) => e.fn) };
  let modOut: IrModule;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "inline") {
      throw new Error("injected module inline failure");
    }
    modOut = inlineSmall(modIn, allocRegistry);
    if (
      modOut.functions.length !== afterHygiene.length ||
      modOut.functions.some(
        (fn, index) => fn.unitId !== afterHygiene[index]!.artifactUnitId || fn.name !== afterHygiene[index]!.name,
      )
    ) {
      throw new IrInvariantError(
        "pass-output-mismatch",
        "verify",
        "inline pass changed function cardinality, unit identity, or compatibility label",
      );
    }
  } catch (error) {
    failEveryOwner(afterHygiene, error, "verify");
    return finishReport();
  }

  // 2c. Re-run hygiene on functions the inline pass actually rewrote; verify.
  // (#4605/#4608) Module declarations catch lone contradictory sibling calls
  // and global references against exact Program ABI allocator carriers.
  const declsAfterInline = programAbiModuleDeclarations(ctx, modOut);
  const afterInline: BuiltFn[] = [];
  for (let i = 0; i < afterHygiene.length; i++) {
    const before = afterHygiene[i]!;
    try {
      const after = modOut.functions[i]!;
      if (after.unitId !== before.artifactUnitId || after.name !== before.name) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `inline output ${after.unitId} / ${after.name} does not match input ${before.artifactUnitId} / ${before.name}`,
        );
      }
      const changed = after !== before.fn;
      const final = changed ? runHygienePasses(after, allocRegistry) : after;
      const verifyErrors = verifyIrFunction(final, undefined, declsAfterInline);
      if (verifyErrors.length > 0) {
        throw new IrInvariantError(
          "verifier-failure",
          "verify",
          `post-inline verify: ${verifyErrors.map((error) => error.message).join("; ")}`,
          verifyErrors,
        );
      }
      if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "provenance-synthetic" && before.synthesized) {
        throw new IrInvariantError(
          "allocation-provenance-failure",
          "verify",
          "injected synthetic allocation provenance failure",
        );
      }
      assertAllocProvenance(final, allocRegistry);
      afterInline.push({ ...before, fn: final });
    } catch (error) {
      markOwnerFailure(terminalOwnerOf(before), before.artifactUnitId, before.name, error, "verify");
    }
  }

  const healthyAfterInline = retainHealthyOwners(afterInline);
  if (healthyAfterInline.length === 0) return finishReport();

  // -------------------------------------------------------------------------
  // 2d. Monomorphize — specialize polymorphic callees across the module.
  // -------------------------------------------------------------------------
  // Clones live only in the IR — they have no ts.FunctionDeclaration and no
  // pre-allocated funcIdx from `compileDeclarations`. After monomorphize
  // produces clones, we allocate each a placeholder WasmFunction slot in
  // `ctx.mod.functions` and register it in `ctx.funcMap` so the Phase-3
  // lowerer's resolver can map the clone's `IrFuncRef` to a concrete index.
  // -------------------------------------------------------------------------
  const monoIn: IrModule = { functions: healthyAfterInline.map((e) => e.fn) };
  let monoResult: ReturnType<typeof monomorphize>;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "monomorphize") {
      throw new Error("injected module monomorphize failure");
    }
    monoResult = monomorphize(monoIn, allocRegistry);
  } catch (error) {
    failEveryOwner(healthyAfterInline, error, "verify");
    return finishReport();
  }
  const originalArtifactUnitIds = new Set<IrUnitId>();
  const afterInlineByUnitId = new Map<IrUnitId, BuiltFn>();
  const ownerByArtifactUnitId = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
  const derivedUnitByArtifactUnitId = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
  const monoByUnitId = new Map<IrUnitId, IrFunction>();
  try {
    for (const entry of healthyAfterInline) {
      if (afterInlineByUnitId.has(entry.artifactUnitId)) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `duplicate pre-monomorphize artifact identity ${entry.artifactUnitId}`,
        );
      }
      originalArtifactUnitIds.add(entry.artifactUnitId);
      afterInlineByUnitId.set(entry.artifactUnitId, entry);
      ownerByArtifactUnitId.set(entry.artifactUnitId, terminalOwnerOf(entry));
      if (entry.derivedUnit) derivedUnitByArtifactUnitId.set(entry.artifactUnitId, entry.derivedUnit);
    }
    if (
      monoResult.cloneOrigins.size !== monoResult.cloneSignatures.size ||
      monoResult.cloneUnitProvenance.size !== monoResult.cloneSignatures.size
    ) {
      throw new IrInvariantError(
        "pass-output-mismatch",
        "verify",
        `monomorphize returned ${monoResult.cloneOrigins.size} origins, ${monoResult.cloneUnitProvenance.size} provenance records, and ${monoResult.cloneSignatures.size} signatures`,
      );
    }
    for (const [cloneUnitId, provenance] of monoResult.cloneUnitProvenance) {
      const originUnitId = monoResult.cloneOrigins.get(cloneUnitId);
      if (
        provenance.id !== cloneUnitId ||
        provenance.parentId !== originUnitId ||
        provenance.role !== "monomorphization-clone"
      ) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize clone ${cloneUnitId} has inconsistent origin/provenance`,
        );
      }
      const originOwner = ownerByArtifactUnitId.get(provenance.parentId);
      if (!originOwner) {
        throw new IrInvariantError(
          "synthetic-owner-missing",
          "verify",
          `monomorphize clone ${cloneUnitId} references unknown origin identity ${provenance.parentId}`,
        );
      }
      if (ownerByArtifactUnitId.has(cloneUnitId)) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize clone identity ${cloneUnitId} collides with an existing artifact`,
        );
      }
      if (!monoResult.cloneSignatures.has(cloneUnitId)) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize clone ${cloneUnitId} has no structural signature`,
        );
      }
      const parentDerived = derivedUnitByArtifactUnitId.get(provenance.parentId);
      const parentInventory = inventoryUnitById.get(provenance.parentId);
      const sourceId = parentDerived?.sourceId ?? parentInventory?.sourceId;
      const terminalOwnerId = parentDerived?.terminalOwnerId ?? parentInventory?.terminalOwnerId;
      if (!sourceId || terminalOwnerId !== originOwner.unitId) {
        throw new IrInvariantError(
          "synthetic-owner-missing",
          "verify",
          `monomorphize clone ${cloneUnitId} has no exact source/terminal provenance through parent ${provenance.parentId}`,
        );
      }
      derivedUnitByArtifactUnitId.set(cloneUnitId, {
        ...provenance,
        sourceId,
        terminalOwnerId,
      });
      ownerByArtifactUnitId.set(cloneUnitId, originOwner);
    }
    for (const cloneUnitId of monoResult.cloneSignatures.keys()) {
      if (!monoResult.cloneOrigins.has(cloneUnitId) || !monoResult.cloneUnitProvenance.has(cloneUnitId)) {
        throw new IrInvariantError(
          "synthetic-owner-missing",
          "verify",
          `monomorphize signature ${cloneUnitId} has no structural origin/provenance`,
        );
      }
    }
    for (const fn of monoResult.module.functions) {
      if (monoByUnitId.has(fn.unitId)) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize output contains duplicate artifact identity ${fn.unitId}`,
        );
      }
      monoByUnitId.set(fn.unitId, fn);
      const owner = ownerByArtifactUnitId.get(fn.unitId);
      if (!owner) {
        throw new IrInvariantError(
          "synthetic-owner-missing",
          "verify",
          `monomorphize output ${fn.unitId} / ${fn.name} has no exact source owner`,
        );
      }
      const original = afterInlineByUnitId.get(fn.unitId);
      if (original && fn.name !== original.name) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize changed compatibility label for ${fn.unitId}: ${original.name} -> ${fn.name}`,
        );
      }
    }
    for (const [unitId, original] of afterInlineByUnitId) {
      if (!monoByUnitId.has(unitId)) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize dropped original artifact ${unitId} / ${original.name}`,
        );
      }
    }
    for (const [cloneUnitId, signature] of monoResult.cloneSignatures) {
      const clone = monoByUnitId.get(cloneUnitId);
      if (!clone) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize signature ${cloneUnitId} has no output function`,
        );
      }
      if (
        clone.name !== signature.name ||
        clone.params.length !== signature.params.length ||
        clone.params.some((param, index) => !irTypeEquals(param.type, signature.params[index]!)) ||
        clone.resultTypes.length !== 1 ||
        !irTypeEquals(clone.resultTypes[0]!, signature.returnType)
      ) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `monomorphize output ${cloneUnitId} does not match its structural clone signature`,
        );
      }
    }
  } catch (error) {
    failEveryOwner(healthyAfterInline, error, "verify");
    return finishReport();
  }

  // -------------------------------------------------------------------------
  // 2e. Tagged-union representation pass (identity in V1 — see
  // `passes/tagged-unions.ts` for the scope note). Structurally wired so
  // follow-up extension work lands in a purpose-built module.
  // -------------------------------------------------------------------------
  let taggedResult: ReturnType<typeof runTaggedUnions>;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "tagged-union") {
      throw new Error("injected tagged-union pass failure");
    }
    taggedResult = runTaggedUnions(monoResult.module);
    if (
      taggedResult.module.functions.length !== monoResult.module.functions.length ||
      taggedResult.module.functions.some(
        (fn, index) =>
          fn.unitId !== monoResult.module.functions[index]!.unitId ||
          fn.name !== monoResult.module.functions[index]!.name,
      )
    ) {
      throw new IrInvariantError(
        "pass-output-mismatch",
        "verify",
        "tagged-union pass changed function cardinality, unit identity, or compatibility label",
      );
    }
  } catch (error) {
    failEveryOwner(healthyAfterInline, error, "verify");
    return finishReport();
  }
  for (const error of taggedResult.errors) {
    const owner = ownerByArtifactUnitId.get(error.unitId);
    const artifact = monoByUnitId.get(error.unitId);
    if (!owner || !artifact || artifact.name !== error.func) {
      failEveryOwner(
        healthyAfterInline,
        new IrInvariantError(
          "synthetic-owner-missing",
          "verify",
          `tagged-union failure for unknown or mislabeled artifact ${error.unitId} / ${error.func}`,
        ),
        "verify",
      );
      return finishReport();
    }
    markOwnerInvariant(
      owner,
      error.unitId,
      error.func,
      "tagged-union-validation-failure",
      "verify",
      `block ${error.block}: ${error.message}`,
    );
  }
  const modAfterTU: IrModule = {
    functions: taggedResult.module.functions.filter((fn) => {
      const owner = ownerByArtifactUnitId.get(fn.unitId);
      return owner !== undefined && !failedOwners.has(owner.unitId);
    }),
  };

  // -------------------------------------------------------------------------
  // 2f. Re-run hygiene on any function whose reference changed across the
  // mono + TU stages. Clones are fresh and well-formed; callers whose
  // call targets were rewritten may benefit from a second hygiene pass
  // (usually a no-op but cheap).
  // -------------------------------------------------------------------------
  const readyForLower: BuiltFn[] = [];
  // (#4605/#4608) Re-derive function/global declarations after monomorphization.
  const declsAfterTU = programAbiModuleDeclarations(ctx, modAfterTU);

  for (const fn of modAfterTU.functions) {
    const before = afterInlineByUnitId.get(fn.unitId);
    const wasCloned = monoResult.cloneOrigins.has(fn.unitId);
    const owner = ownerByArtifactUnitId.get(fn.unitId)!;
    try {
      if (!before && !wasCloned) {
        throw new IrInvariantError(
          "pass-output-mismatch",
          "verify",
          `post-tagged-union artifact ${fn.unitId} / ${fn.name} is neither an original nor a declared clone`,
        );
      }
      const changed = before === undefined || fn !== before.fn;
      const hygienic = changed ? runHygienePasses(fn, allocRegistry) : fn;
      // Final synchronous parity pass: fuse only after mono/TU has settled.
      const hostBatchedConcat = !ctx.nativeStrings && !ctx.standalone && !ctx.wasi && !ctx.strictNoHostImports;
      const standaloneBatchedConcat = ctx.nativeStrings && ctx.standalone && !ctx.wasi;
      const batched = hostBatchedConcat
        ? batchStringConcat(hygienic, allocRegistry)
        : standaloneBatchedConcat
          ? batchStringConcat(hygienic, allocRegistry, 8)
          : hygienic;
      const final = batched === hygienic ? hygienic : runHygienePasses(batched, allocRegistry);
      const verifyErrors = verifyIrFunction(final, undefined, declsAfterTU);
      if (verifyErrors.length > 0) {
        throw new IrInvariantError(
          "verifier-failure",
          "verify",
          `post-mono verify: ${verifyErrors.map((error) => error.message).join("; ")}`,
          verifyErrors,
        );
      }
      assertAllocProvenance(final, allocRegistry);
      readyForLower.push({
        artifactUnitId: fn.unitId,
        terminalOwnerUnitId: owner.unitId,
        name: fn.name,
        ownerName: owner.legacyName,
        fn: final,
        derivedUnit: before?.derivedUnit ?? derivedUnitByArtifactUnitId.get(fn.unitId),
        synthesized: before?.synthesized === true || wasCloned,
        classMember: before?.classMember,
        moduleInit: before?.moduleInit,
        ...(before?.countedStringAppendPlans ? { countedStringAppendPlans: before.countedStringAppendPlans } : {}),
      });
    } catch (error) {
      markOwnerFailure(owner, fn.unitId, fn.name, error, "verify");
    }
  }

  let healthyForLower = retainHealthyOwners(readyForLower);
  if (healthyForLower.length === 0) return finishReport();

  // -------------------------------------------------------------------------
  // 2g. Ownership + access-semantics analysis (#1587) — gated, default OFF.
  // Runs on the final (post-mono/TU) IR shape, writing inferred ownership /
  // access annotations to the registry `ownership` namespace. The analysis is
  // purely an optimization aid: it does NOT mutate the IR and registry
  // annotations are inert at lowering, so emitted Wasm is byte-identical
  // whether or not this runs (ADR-0014). Consumers query the per-function
  // `OwnershipResult` (the demonstration consumer in `analysis/stack-alloc.ts`
  // is likewise gated and annotation-only). Behind `JS2WASM_IR_OWNERSHIP=1`
  // for the rollout period.
  // -------------------------------------------------------------------------
  // 2h. Escape analysis (#747) — gated, default OFF. When
  // `JS2WASM_IR_ESCAPE=1`, classifies each allocation
  // (local/returned/stored/captured/opaque) on top of the ownership result and
  // writes it to the registry `escape` namespace. Enabling escape implies
  // running ownership (its oracle). Both are inert — no IR mutation, byte-
  // identical Wasm — so scalar replacement / stack allocation stays a
  // follow-up consumer.
  const wantOwnership = ownershipAnalysisEnabled();
  const wantEscape = escapeAnalysisEnabled();
  if (wantOwnership || wantEscape) {
    for (const entry of healthyForLower) {
      try {
        const ownershipResult = analyzeOwnership(entry.fn, allocRegistry);
        if (wantEscape) analyzeEscape(entry.fn, allocRegistry, ownershipResult);
      } catch (error) {
        markOwnerFailure(terminalOwnerOf(entry), entry.artifactUnitId, entry.name, error, "verify");
      }
    }
  }
  healthyForLower = retainHealthyOwners(healthyForLower);
  if (healthyForLower.length === 0) return finishReport();
  // Late registrations are preparation; unknown throws fan out to active owners.
  const runGlobalPreparation = (action: () => void): boolean => {
    try {
      action();
      return true;
    } catch (error) {
      failEveryOwner(healthyForLower, error, "resolve");
      return false;
    }
  };
  if (
    options?.atomicComponent &&
    options.deferPreparedPublication &&
    (ctx.pendingLateImportShift !== null || !atomicDeferredComponentIsAllocatorNeutral(healthyForLower))
  ) {
    failEveryOwner(
      healthyForLower,
      new IrUnsupportedError(
        "late-preparation-unsupported",
        "resolve",
        "atomic prepared component has a pending late import shift or requires lazy helper/import/type/provider allocation; retaining direct bodies",
      ),
      "resolve",
    );
    return finishReport();
  }
  // (#3526 F1-S1) Partition the number-boundary decision by exact terminal
  // owner BEFORE any body, slot, alias, outcome, or manifest prefix is
  // published. The aggregate manifest below is prepared for all healthy owners
  // at once, so a `provider-target-unavailable` throw inside it would turn one
  // owner's demotion into `unexpected-internal-throw` for every unrelated
  // owner. Classifying here keeps the failure owner-local and the surviving
  // manifest deterministic; structural manifest corruption and late mutation
  // stay fatal for the whole transaction.
  const numberBoundaryPolicy = integrationNumberBoundaryPolicy(ctx);
  const booleanBoundaryPolicy = integrationBooleanBoundaryPolicy(ctx);
  const externIsUndefinedPolicy = integrationExternIsUndefinedPolicy(ctx);
  const generatorNumberBoxPolicy = integrationGeneratorNumberBoxPolicy(ctx);
  const stringComparePolicy = integrationStringComparePolicy(ctx);
  const stringEqPolicy = integrationStringEqPolicy(ctx);
  const stringLenPolicy = integrationStringLenPolicy(ctx);
  const stringConcatPolicy = integrationStringConcatPolicy(ctx);
  const stringCharCodeAtPolicy = integrationStringCharCodeAtPolicy(ctx);
  for (const entry of healthyForLower) {
    const unsupported = unsupportedNumberBoundaryIntrinsic(entry.fn, numberBoundaryPolicy);
    if (unsupported !== undefined) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          `ir/integration: semantic intrinsic ${unsupported} has no provider under number-boundary policy ` +
            `box=${numberBoundaryPolicy.box}/unbox=${numberBoundaryPolicy.unbox}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F1-S3) The generator return seam partitions on the same rule. It
    // carries no intrinsic instruction, so the demand is read off the
    // `gen.setReturn` population directly — the same enumeration the freeze
    // scan and the attachment pass use.
    if (generatorNumberBoxPolicy.box === "unsupported" && irGeneratorNumberBoxDemand([entry.fn])) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: generator return boxing has no provider under generator-number-box policy " +
            `box=${generatorNumberBoxPolicy.box}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F1-S4) The externref undefined probe partitions on the same rule,
    // in the same pass, for the same reason.
    const unsupportedProbe = unsupportedExternBoundaryIntrinsic(entry.fn, externIsUndefinedPolicy);
    if (unsupportedProbe !== undefined) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          `ir/integration: semantic intrinsic ${unsupportedProbe} has no provider under extern-is-undefined policy ` +
            `probe=${externIsUndefinedPolicy.probe}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F2-S1) The string relational compare seam partitions on the same
    // rule, in the same pass. Like the generator seam it carries no intrinsic
    // instruction, so the demand is read off the call population directly.
    if (stringComparePolicy.compare === "unsupported" && irStringCompareDemand([entry.fn])) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: string relational compare has no provider under string-compare policy " +
            `compare=${stringComparePolicy.compare}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F2-S3) The string equality seam partitions on the same rule, in
    // the same pass. Its demand is an instruction kind rather than a call
    // target, but the classification is identical to the compare's.
    if (stringEqPolicy.eq === "unsupported" && irStringEqDemand([entry.fn])) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: string equality has no provider under string-eq policy " + `eq=${stringEqPolicy.eq}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F2-S4) The string length seam partitions on the same rule, in the
    // same pass. Its demand is an instruction kind, like the equality's.
    if (stringLenPolicy.len === "unsupported" && irStringLenDemand([entry.fn])) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: string length has no provider under string-len policy " + `len=${stringLenPolicy.len}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F2-S5) The string concatenation seam partitions on the same rule,
    // in the same pass. Its demand is an instruction kind like the length's,
    // but it is a PAIR of modes — EITHER of which is demand, because one
    // unsupported policy refuses both feature rows at once.
    const stringConcatDemand = irStringConcatDemand([entry.fn]);
    if (stringConcatPolicy.concat === "unsupported" && (stringConcatDemand.immutable || stringConcatDemand.owned)) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: string concatenation has no provider under string-concat policy " +
            `concat=${stringConcatPolicy.concat}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F2-S7) The guarded charCodeAt seam partitions on the same rule, in
    // the same pass. Its demand spans two producers, so an owner whose policy
    // cannot provide the seam is refused whichever producer minted the read —
    // the policy refuses, it never re-lowers.
    if (stringCharCodeAtPolicy.charCodeAt === "unsupported" && irStringCharCodeAtDemand([entry.fn])) {
      markOwnerFailure(
        terminalOwnerOf(entry),
        entry.artifactUnitId,
        entry.name,
        new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "ir/integration: charCodeAt has no provider under string-char-code-at policy " +
            `charCodeAt=${stringCharCodeAtPolicy.charCodeAt}`,
        ),
        "resolve",
      );
      continue;
    }
    // (#3526 F1-S2) The boolean boundary partitions on the SAME rule and in the
    // same pass, so one demoting owner still cannot fail an unrelated one
    // through the aggregate manifest below.
    const unsupportedBoolean = unsupportedBooleanBoundaryIntrinsic(entry.fn, booleanBoundaryPolicy);
    if (unsupportedBoolean === undefined) continue;
    markOwnerFailure(
      terminalOwnerOf(entry),
      entry.artifactUnitId,
      entry.name,
      new IrUnsupportedError(
        "late-preparation-unsupported",
        "resolve",
        `ir/integration: semantic intrinsic ${unsupportedBoolean} has no provider under boolean-boundary policy ` +
          `box=${booleanBoundaryPolicy.box}`,
      ),
      "resolve",
    );
  }
  healthyForLower = retainHealthyOwners(healthyForLower);
  if (healthyForLower.length === 0) return finishReport();
  let preparedRuntimeManifest: PreparedIrRuntimeManifest | undefined;
  if (!runGlobalPreparation(() => (healthyForLower = prepareStrings(ctx, healthyForLower)))) return finishReport();
  if (
    !runGlobalPreparation(() => {
      const prepared = prepareBuiltFnRuntimeManifest(ctx, sourceFile.fileName, healthyForLower);
      preparedRuntimeManifest = prepared.runtime;
      healthyForLower = [...prepared.entries];
    })
  ) {
    return finishReport();
  }
  if (
    !runGlobalPreparation(
      () =>
        (healthyForLower = healthyForLower.map((entry) => {
          const fn = attachIrExternSupport(entry.fn);
          return fn === entry.fn ? entry : { ...entry, fn };
        })),
    )
  ) {
    return finishReport();
  }
  if (!runGlobalPreparation(() => (healthyForLower = prepareVectors(ctx, healthyForLower)))) return finishReport();
  healthyForLower = verifyFinalAllocArtifacts(healthyForLower, allocRegistry, monoResult.cloneOrigins, (entry, error) =>
    markOwnerFailure(terminalOwnerOf(entry), entry.artifactUnitId, entry.name, error, "verify"),
  );
  healthyForLower = retainHealthyOwners(healthyForLower);
  if (healthyForLower.length === 0) return finishReport();
  if (!runGlobalPreparation(() => preregisterHostDateSnapshotSupport(ctx, healthyForLower))) {
    return finishReport();
  }
  recordOwnerPreparationFailures(failures, failedOwners, preregisterIteratorSupport(ctx, healthyForLower));
  healthyForLower = retainHealthyOwners(healthyForLower);
  if (healthyForLower.length === 0) return finishReport();
  if (
    !runGlobalPreparation(() => {
      if (!healthyForLower.some((entry) => entry.fn.funcKind === "generator")) return;
      addGeneratorImports(ctx);
      // #2951 — bind the `gen.*` runtime callables symbolically now that the
      // imports exist, then OBSERVE them: prepared-component sealing runs
      // before lowering, so an unobserved provider reads as an unplanned ABI
      // binding and peels the generator back to the compile-twice route.
      // (#3526 F1-S3) The boxing callable is the frozen manifest's decision,
      // not a symbol spelled at this seam.
      const generatorNumberBoxProvider = preparedGeneratorNumberBoxProvider(preparedRuntimeManifest);
      healthyForLower = healthyForLower.map((entry) => {
        const fn = attachIrGeneratorSupport(entry.fn, generatorNumberBoxProvider);
        return fn === entry.fn ? entry : { ...entry, fn };
      });
      if (ctx.programAbiCallableProviders) {
        for (const ref of collectAttachedGeneratorProviders(healthyForLower.map((entry) => entry.fn))) {
          resolveAndObserveCallableProvider(ctx, ref, undefined, fuseNativeNumberFormatCarriers);
        }
      }
    })
  ) {
    return finishReport();
  }
  if (!runGlobalPreparation(() => preregisterNativeStringHelpers(ctx, healthyForLower))) {
    return finishReport();
  }
  if (!runGlobalPreparation(() => preregisterExceptionSupport(ctx, healthyForLower))) return finishReport();
  if (!runGlobalPreparation(() => preregisterDynamicAndForInSupport(ctx, healthyForLower))) return finishReport();
  if (
    !runGlobalPreparation(() => {
      const registry = ctx.programAbiTypes;
      if (!registry || ctx.mapTypeIdx < 0) return;
      let mapCarrierRef: IrTypeRef | undefined;
      healthyForLower = healthyForLower.map((entry) => {
        const fn = attachIrPhysicalRefTypeRefs(entry.fn, (type) => {
          if ((type.val.kind !== "ref" && type.val.kind !== "ref_null") || type.val.typeIdx !== ctx.mapTypeIdx) {
            return undefined;
          }
          return (mapCarrierRef ??= registry.prepareNativeMapCarrier());
        });
        return fn === entry.fn ? entry : { ...entry, fn };
      });
    })
  ) {
    return finishReport();
  }
  if (
    !runGlobalPreparation(() => {
      const pending = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
      for (const entry of healthyForLower) {
        if (!entry.derivedUnit) continue;
        if (entry.derivedUnit.id !== entry.artifactUnitId || pending.has(entry.derivedUnit.id)) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            `ir/integration: derived unit ${entry.derivedUnit.id} is duplicated or detached from artifact ${entry.artifactUnitId}`,
          );
        }
        pending.set(entry.derivedUnit.id, entry.derivedUnit);
      }
      const session = ctx.programAbiSession;
      if (!session) return;
      while (pending.size > 0) {
        let registered = 0;
        for (const [id, record] of pending) {
          if (!session.hasKnownUnit(record.parentId)) continue;
          session.registerDerivedUnit(record);
          pending.delete(id);
          registered++;
        }
        if (registered === 0) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            `ir/integration: ${pending.size} derived unit(s) have no registered inventory/provenance parent`,
          );
        }
      }
    })
  ) {
    return finishReport();
  }
  recordOwnerPreparationFailures(
    failures,
    failedOwners,
    preregisterCallableProviders(ctx, healthyForLower, preparedRuntimeManifest, fuseNativeNumberFormatCarriers),
  );
  healthyForLower = retainHealthyOwners(healthyForLower);
  if (healthyForLower.length === 0) return finishReport();
  const importedCallableCatalog = catalogProgramAbiCallableImports(ctx);
  const freshSlots: PreparedDerivedCallableSlot[] = [];
  let preparedComponentIdByTerminalUnitId: ReadonlyMap<IrUnitId, string> = new Map();
  let preparedClosure: PreparedClosureTransaction | undefined;
  if (options?.sealPreparedComponents) {
    if (
      !runGlobalPreparation(() => {
        preparedClosure = prepareClosureTransaction({
          ctx,
          entries: healthyForLower,
          originalArtifactUnitIds,
          inventory: moduleBindingIdentityContext.inventory,
          ...(options.atomicComponent ? { atomicTerminalPopulation: true } : {}),
          callableImports: importedCallableCatalog,
          ...(options.preparedBindingIdsByTerminalUnitId
            ? { preparedBindingIdsByTerminalUnitId: options.preparedBindingIdsByTerminalUnitId }
            : {}),
          ...(options.deferPreparedPublication ? { deferPublication: true as const } : {}),
          ...(options.preparedModuleCallableAliasDescriptor
            ? { preparedModuleCallableAliasDescriptor: options.preparedModuleCallableAliasDescriptor }
            : {}),
          onSealFailure: (terminalUnitId, error, diagnosticVisibility) => {
            const owner = activeOwnerProjection.requireUnit(terminalUnitId);
            markOwnerFailure(owner, terminalUnitId, owner.legacyName, error, "resolve", diagnosticVisibility);
          },
        });
        freshSlots.push(...preparedClosure.freshSlots);
        preparedComponentIdByTerminalUnitId = preparedClosure.componentIds;
        abortDeferredOpenScopes = preparedClosure.abortOpenScopes;
      })
    ) {
      return finishReport();
    }
    if ((healthyForLower = retainHealthyOwners(healthyForLower)).length === 0) return finishReport();
  }
  // Allocate remaining synthetic placeholders and retain every fresh slot for orphan stubbing (#3551).
  const exactArtifactFuncIdx = (unitId: IrUnitId): number | undefined => {
    const func = ctx.irUnitFuncMap.get(unitId);
    return func ? definedFuncHandleOf(ctx, func) : undefined;
  };
  // Low-level compatibility tests may call integration without a production
  // identity context. Production contexts must resolve the exact allocation.
  const sourceArtifactFuncIdx = (unitId: IrUnitId, compatibilityName: string): number | undefined =>
    ctx.programAbiSourceCallables?.handleForUnit(unitId) ??
    (ctx.programAbiSourceCallables?.identityContext ? undefined : ctx.funcMap.get(compatibilityName));
  const classArtifactFuncIdx = (unitId: IrUnitId, compatibilityName: string): number | undefined =>
    ctx.programAbiClassCallables?.handleForUnit(unitId) ??
    (ctx.programAbiClassCallables ? undefined : ctx.funcMap.get(compatibilityName));
  const legacyArtifactFuncIdx = (entry: BuiltFn): number | undefined =>
    entry.moduleInit
      ? ctx.programAbiModuleInitCallables?.handleForUnit(entry.artifactUnitId)
      : entry.classMember
        ? classArtifactFuncIdx(entry.artifactUnitId, entry.name)
        : sourceArtifactFuncIdx(entry.artifactUnitId, entry.name);
  const hasPreallocatedArtifactSlot = (entry: BuiltFn): boolean =>
    (originalArtifactUnitIds.has(entry.artifactUnitId) && !entry.synthesized) ||
    entry.classMember === true ||
    entry.moduleInit === true;
  for (const entry of healthyForLower) {
    if (!hasPreallocatedArtifactSlot(entry) || ctx.irUnitFuncMap.has(entry.artifactUnitId)) continue;
    const funcIdx = legacyArtifactFuncIdx(entry);
    const func = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
    if (func) ctx.irUnitFuncMap.set(entry.artifactUnitId, func);
  }
  const claimedIrFunctions = new Set(ctx.irUnitFuncMap.values());
  for (const entry of healthyForLower) {
    // Top-level (non-synthesized) functions already have a funcIdx
    // allocated by `compileDeclarations`. Skip them.
    if (originalArtifactUnitIds.has(entry.artifactUnitId) && !entry.synthesized) continue;
    // #1370 Phase B: class members have funcIdx pre-allocated by the
    // legacy `class-bodies.ts` pass (`ctorFuncIdx` / `methodFuncIdx`).
    // Don't allocate a new slot — Phase 3 will patch the existing one.
    if (entry.classMember) continue;
    // (#3142 Slice 2) The module-init unit patches its exact legacy
    // allocator slot from the source-unit registry — never a fresh one.
    if (entry.moduleInit) continue;
    if (ctx.irUnitFuncMap.has(entry.artifactUnitId)) continue;
    // Production synthesized artifacts have exact derived-unit identities and
    // therefore always own fresh allocator objects. Reusing an empty
    // same-labelled source slot aliases two Program ABI owners; publishing the
    // new slot back through funcMap can likewise overwrite that source
    // binding. Keep the old name-keyed reuse only for low-level compatibility
    // callers that deliberately omit a Program ABI session.
    const namedIdx = ctx.programAbiSession ? undefined : ctx.funcMap.get(entry.name);
    const named = namedIdx === undefined ? undefined : definedFuncAt(ctx, namedIdx);
    const func =
      named && named.body.length === 0 && !claimedIrFunctions.has(named)
        ? named
        : {
            name: entry.name,
            typeIdx: 0,
            locals: [],
            body: [],
            exported: false,
          };
    if (func !== named) ctx.mod.functions.push(func);
    const funcIdx = definedFuncHandleOf(ctx, func);
    if (funcIdx === undefined) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: exact artifact ${entry.artifactUnitId} / ${entry.name} has no allocator slot`,
      );
    }
    ctx.irUnitFuncMap.set(entry.artifactUnitId, func);
    claimedIrFunctions.add(func);
    if (!ctx.programAbiSession) ctx.funcMap.set(entry.name, funcIdx);
    freshSlots.push({
      artifactUnitId: entry.artifactUnitId,
      funcIdx,
      terminalOwnerUnitId: entry.terminalOwnerUnitId,
    });
  }

  // -------------------------------------------------------------------------
  // Phase 3 prep — Eagerly register string imports + literals BEFORE lowering.
  //
  // Rationale: `addStringImports` shifts existing function indices when called
  // late, and `addStringConstantGlobal` shifts global indices when called
  // after module globals exist. Both shift passes walk
  // `ctx.mod.functions[].body` AND `ctx.currentFunc.body`. They do NOT walk
  // the lowerer's local `out: Instr[]` buffer that holds the IR-lowered body
  // mid-emission. So if a `string.const` triggers `addStringConstantGlobal`
  // mid-emission, an earlier `global.get` we already pushed to `out` for this
  // function would carry a now-stale index.
  //
  // We avoid that race by pre-walking the IR BEFORE Phase 3 starts and
  // calling both registration helpers up front. Both are idempotent on
  // existing entries, so duplicate calls are safe and cheap.
  //
  // Native-strings mode bakes string globals inline as
  // `array.new_fixed`/`struct.new`, so it doesn't need the import shifting
  // machinery — but we still walk the IR for symmetry and to keep the
  // resolver path uniform.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Slice 6 part 3 (#1182) — iterator host imports.
  //
  // Walk every IR function for any `iter.*` / `forof.iter` / coercion-to-
  // externref instruction; if found, call `addIteratorImports(ctx)` so the
  // resolver can map `__iterator` / `__iterator_next` / `__iterator_done` /
  // `__iterator_value` / `__iterator_return` to concrete funcIdx values
  // BEFORE Phase 3 resolves IrFuncRef symbols. This pre-registration
  // matches `preregisterStringSupport`'s rationale.
  // -------------------------------------------------------------------------
  // Iterator registration completed transactionally above.

  // -------------------------------------------------------------------------
  // Slice 7a (#1169f) — pre-register generator host imports if any IR
  // function will emit `gen.push` / `gen.epilogue`. Same rationale as
  // the string + iterator pre-registration above: late-import shifting
  // is expensive and can invalidate the lowerer's local op buffer if
  // it fires mid-emission. `addGeneratorImports` is idempotent on
  // `ctx.funcMap` membership, so the legacy-source detection at
  // `codegen/index.ts:4031` (which fires whenever the source contains
  // any `function*`) makes this call a no-op in practice — but the
  // call here is the supported entry point for IR-only test fixtures
  // that don't trigger legacy detection (e.g. an IR test that
  // synthesises a generator without the AST scan running).
  // -------------------------------------------------------------------------
  // Generator registration completed transactionally above.
  // -------------------------------------------------------------------------
  // Slice 6 part 4 (#1183) — native-string helpers (notably __str_charAt).
  //
  // Walk every IR function for any `forof.string` instr; if found, call
  // `ensureNativeStringHelpers(ctx)` so `__str_charAt` (and the rest of
  // the native-string helper family) is registered before the lowerer
  // resolves the funcref. The helper itself is idempotent, but calling
  // it eagerly avoids late-import shifts during Phase 3 emission.
  // -------------------------------------------------------------------------
  // Native-string registration completed transactionally above.

  // -------------------------------------------------------------------------
  // Slice 9 (#1169h) — pre-register the shared `__exn` exception tag if
  // any IR function emits `throw` or `try`. The tag itself doesn't
  // shift function indices (it lives in `ctx.mod.tags`), but
  // pre-registering here keeps the resolver path uniform and matches
  // the pattern used for other lazy registrations.
  // -------------------------------------------------------------------------
  // Exception registration completed transactionally above.

  // -------------------------------------------------------------------------
  // #2949 slice 3 — pre-register the dynamic box/unbox/tag.test backing
  // (fast: `ensureAnyHelpers` → $AnyValue + the `__any_box_*`/`__any_unbox_*`
  // defined-function family; host: `addUnionImports` → the `__box_number` /
  // `__unbox_*` / `__typeof_*` import family) if any IR function carries a
  // dynamic op. Same rationale as every preregister above: registration
  // during Phase-3 emission would shift funcIdx values under an in-flight
  // body buffer (the #329/#2078 bug class). Both entry points are
  // idempotent, and `addUnionImports` performs the defined-function shift
  // fix-up itself for anything already compiled.
  // -------------------------------------------------------------------------
  // Dynamic registration completed transactionally above.

  // -------------------------------------------------------------------------
  // Phase 3 — Lower: translate each IrFunction to Wasm and install in ctx.
  // -------------------------------------------------------------------------
  //
  // String backend: capture concrete funcIdx values for the native-string
  // helpers (`__str_concat`, `__str_equals`) and the wasm:js-string imports
  // (`concat`, `equals`, `length`) AT THIS POINT — after all late imports
  // (e.g. `addPrimitiveTypeImports` triggered by legacy compileDeclarations)
  // have shifted the index space.
  //
  // (#3909) The old rationale here — "`ctx.nativeStrHelpers` is a stale map
  // post-shift, so resolve names against `ctx.mod.functions` directly" — is
  // INVERTED as of #1916 S3 and was the direct cause of #3909. Every
  // `nativeStrHelpers` entry is now minted by `mintDefinedFunc`, i.e. a
  // STABLE-regime handle that no shifter touches; the `numImportFuncs + i`
  // name scan yields a LIVE index that every later shifter must chase, and the
  // shift guard (`idx >= importsBefore`) silently STOPS chasing it once the
  // import count climbs past it. The map is the reliable authority, the scan is
  // the fragile one. Resolution goes through `nativeStrHelperHandle`
  // (src/codegen/func-space.ts), which prefers the stable handle and keeps the
  // scan only as a fallback for helpers not yet on stable minting.
  const unitCallableSlots = new Map<IrUnitId, PreparedIrUnitCallableSlot>();
  const bindUnitCallableSlot = (ref: IrFuncRef, funcIdx: number, physicalName: string): void => {
    if (ref.binding.kind !== "unit") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: cannot bind non-unit callable ${ref.name} as a source artifact`,
      );
    }
    const defined = definedFuncAt(ctx, funcIdx);
    if (!defined || defined.name !== physicalName) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: exact unit ${ref.binding.unitId} / ${ref.name} has no defined slot ${physicalName}`,
      );
    }
    const existing = unitCallableSlots.get(ref.binding.unitId);
    if (existing) {
      if (existing.funcIdx !== funcIdx || existing.physicalName !== physicalName) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: unit ${ref.binding.unitId} maps to both ${existing.physicalName}@${existing.funcIdx} and ${physicalName}@${funcIdx}`,
        );
      }
      existing.compatibilityNames.add(ref.name);
      return;
    }
    const mapped = ctx.irUnitFuncMap.get(ref.binding.unitId);
    if (mapped && mapped !== defined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: exact unit ${ref.binding.unitId} maps to more than one allocator function`,
      );
    }
    ctx.irUnitFuncMap.set(ref.binding.unitId, defined);
    const programAbiBindingId = preparedUnitProgramAbiBinding(ctx, ref, defined, preparedClosure?.preparedScopeLookup);
    unitCallableSlots.set(ref.binding.unitId, {
      funcIdx,
      physicalName,
      compatibilityNames: new Set([ref.name]),
      programAbiBindingId,
    });
  };
  const artifactFuncIdx = (entry: BuiltFn): number | undefined =>
    exactArtifactFuncIdx(entry.artifactUnitId) ?? legacyArtifactFuncIdx(entry);
  const bindPlannedUnitTarget = (ref: IrFuncRef): void => {
    if (ref.binding.kind !== "unit") return;
    const existing = unitCallableSlots.get(ref.binding.unitId);
    if (existing) {
      existing.compatibilityNames.add(ref.name);
      return;
    }
    const funcIdx = sourceArtifactFuncIdx(ref.binding.unitId, ref.name);
    if (funcIdx === undefined) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: planned source unit ${ref.binding.unitId} / ${ref.name} has no exact registered slot`,
      );
    }
    bindUnitCallableSlot(ref, funcIdx, ref.name);
  };
  let resolver: IrLowerResolver;
  try {
    for (const entry of healthyForLower) {
      const funcIdx = artifactFuncIdx(entry);
      if (funcIdx === undefined) {
        throw new IrInvariantError(
          "missing-function-slot",
          "resolve",
          `ir/integration: no slot allocated for exact artifact ${entry.fn.unitId} / ${entry.name}`,
        );
      }
      const allocated = definedFuncAt(ctx, funcIdx);
      if (!allocated) {
        throw new IrInvariantError(
          "missing-function-slot",
          "resolve",
          `ir/integration: exact artifact ${entry.fn.unitId} / ${entry.name} has no allocated function object`,
        );
      }
      bindUnitCallableSlot(irUnitFuncRef(entry.fn), funcIdx, allocated.name);
    }
    for (const plan of preparedDirectCalls.values()) bindPlannedUnitTarget(plan.target);
    for (const plan of loweringPlans?.importedCalls.values() ?? []) bindPlannedUnitTarget(plan.target);
    for (const plan of loweringPlans?.topLevelFunctionValues.values() ?? []) bindPlannedUnitTarget(plan.target);

    const stringBackend = computeStringBackend(ctx);
    // Build the resolver in two steps so the resolver and the
    // ObjectStructRegistry / ClosureStructRegistry can refer to each
    // other without a circular direct reference: the registries need
    // `lowerIrTypeToValType` (which calls `resolver.resolveString` /
    // `resolveObject` / `resolveClosure`), and the resolver delegates
    // back to the registries. We hand the resolver `Deferred*Resolver`
    // shells whose `resolve` callbacks are filled in after the
    // registries exist.
    const deferredObj: DeferredObjectResolver = {
      resolve: (_shape: IrObjectShape) => null,
    };
    const deferredCl: DeferredClosureResolver = {
      resolveBase: () => null,
      resolveSubtype: () => null,
    };
    const deferredCell: DeferredRefCellResolver = {
      resolve: () => null,
    };
    const deferredClass: DeferredClassResolver = {
      resolve: () => null,
    };
    if (options?.deferPreparedPublication && !preparedClosure?.preparedScopeLookup) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "detached prepared integration requires one authenticated open ABI overlay before resolver construction",
      );
    }
    resolver = makeResolver(
      ctx,
      unionRegistry,
      stringBackend,
      deferredObj,
      deferredCl,
      deferredCell,
      deferredClass,
      unitCallableSlots,
      importedCallableCatalog,
      preparedRuntimeManifest,
      fuseNativeNumberFormatCarriers,
      loweringPlans?.fnctorParameterPreselection,
      loweringPlans?.fnctorParameterPreselectionIsCurrent,
      preparedClosure?.preparedScopeLookup,
    );
    const resolverInjection = process.env.JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE;
    if (resolverInjection === "function") resolver.resolveFunc(irIntrinsicFuncRef("__injected_missing_func"));
    if (resolverInjection === "planned-support") {
      const valuePlan = loweringPlans?.topLevelFunctionValues.values().next().value;
      if (valuePlan) {
        const session = ctx.programAbiSession;
        if (valuePlan.trampoline.binding.kind !== "support" || !session) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            "planned support resolver probe requires one exact function-value trampoline",
          );
        }
        const misleadingRef: IrFuncRef = Object.freeze({
          ...valuePlan.trampoline,
          name: "__nonexistent_support_compatibility_label",
        });
        const expected = session.resolveCurrentIndex(
          valuePlan.trampoline.binding.bindingId,
          "function",
          irCallableBindingKey(valuePlan.trampoline.binding),
        );
        if (resolver.resolveFunc(misleadingRef) !== expected) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            "planned support resolver probe did not preserve the exact allocator slot",
          );
        }
      }
    }
    if (resolverInjection === "planned-import") {
      const imported = ctx.mod.imports.find((candidate) => candidate.desc.kind === "func");
      const session = ctx.programAbiSession;
      if (!imported || imported.desc.kind !== "func" || !session) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          "planned import resolver probe requires one exact function import",
        );
      }
      const misleadingRef = irImportFuncRef(imported.module, imported.name, "__nonexistent_import_compatibility_label");
      const key = irCallableBindingKey(misleadingRef.binding);
      const exactImport = importedCallableCatalog.get(key);
      let expected = -1;
      let functionIndex = 0;
      for (const candidate of ctx.mod.imports) {
        if (candidate.desc.kind !== "func") continue;
        if (candidate === exactImport) expected = functionIndex;
        functionIndex++;
      }
      if (!exactImport || expected < 0 || resolver.resolveFunc(misleadingRef) !== expected) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          "planned import resolver probe did not preserve the exact import-object slot",
        );
      }
    }
    const injectionOwner = moduleBindingIdentityContext.inventory.sources[0]?.id;
    if (!injectionOwner && (resolverInjection === "global" || resolverInjection === "type")) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "resolver injection requires one structural source owner",
      );
    }
    if (resolverInjection === "global") {
      resolver.resolveGlobal(irSupportGlobalRef(injectionOwner!, "resolver-injection", "__injected_missing_global"));
    }
    if (resolverInjection === "type") {
      resolver.resolveType(irSupportTypeRef(injectionOwner!, "resolver-injection", "__injected_missing_type"));
    }
    const objectRegistry = new ObjectStructRegistry(ctx, (t) => lowerIrTypeToValType(t, resolver, "<obj-registry>"));
    deferredObj.resolve = (shape) => objectRegistry.resolve(shape);
    preparedClosure?.bindLowerResolver(resolver);
    const closureRegistry =
      preparedClosure?.registry ??
      new ClosureStructRegistry(ctx, (t) => lowerIrTypeToValType(t, resolver, "<closure-registry>"));
    deferredCl.resolveBase = (sig) => closureRegistry.resolveBase(sig);
    deferredCl.resolveSubtype = closureRegistry.resolveDeferredSubtype.bind(closureRegistry);
    const refCellRegistry = preparedClosure?.refCells ?? new RefCellRegistry(ctx);
    deferredCell.resolve = (inner) => refCellRegistry.resolve(inner);
    // Slice 4 (#1169d): the class registry is a thin lookup over the
    // legacy class-collection state — `ctx.structMap`, `ctx.structFields`,
    // and `ctx.funcMap` carry everything we need.
    const classRegistry = new ClassRegistry(ctx, classIdByShape, moduleBindingIdentityContext, bindUnitCallableSlot);
    deferredClass.resolve = (shape) => classRegistry.resolve(shape);
  } catch (error) {
    failEveryOwner(healthyForLower, error, "resolve");
    return finishReport();
  }

  const replaceUnitCallableAt = (
    unitId: IrUnitId,
    terminalOwnerUnitId: IrUnitId,
    funcIdx: number,
    previous: NonNullable<ReturnType<typeof definedFuncAt>>,
    replacement: NonNullable<ReturnType<typeof definedFuncAt>>,
  ): NonNullable<ReturnType<typeof definedFuncAt>> => {
    const mapped = ctx.irUnitFuncMap.get(unitId);
    if (mapped && mapped !== previous) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `ir/integration: exact unit ${unitId} replacement does not match its allocator function`,
      );
    }
    const preparedComponentId = preparedComponentIdByTerminalUnitId.get(terminalOwnerUnitId);
    if (preparedComponentId !== undefined) {
      const installed = fillSealedPreparedCallable(preparedComponentId, previous, replacement);
      ctx.irUnitFuncMap.set(unitId, installed);
      return installed;
    }
    replaceDefinedFuncAt(ctx, funcIdx, replacement);
    ctx.irUnitFuncMap.set(unitId, replacement);
    const bindingId = unitCallableSlots.get(unitId)?.programAbiBindingId;
    if (bindingId) {
      ctx.programAbiSession!.replaceDefinedFunctionLocator(bindingId, previous, replacement);
    }
    return replacement;
  };
  const pendingPatches: PreparedIrPendingPatch<BuiltFn>[] = [];
  const timerLoweringBoundary = createCompilerTimerShimLoweringBoundary<BuiltFn>({
    inventory: moduleBindingIdentityContext.inventory,
    sealDeferred: () => preparedClosure?.sealCompilerTimerShim(),
    ownerFailed: (unitId) => failedOwners.has(unitId),
  });
  const lowerEntries = timerLoweringBoundary.order(healthyForLower);
  // (#3551) Exact artifact identities withdrawn by the typeIdx-parity guard
  // below. Every
  // IR body was compiled against `calleeTypes` — the IR's shared view of each
  // claimed function's signature — so when a callee's claim is withdrawn on a
  // parity mismatch (its slot keeps the LEGACY ABI, which the mismatch just
  // proved differs from the IR view), any committed IR caller of it would call
  // through the wrong ABI. The cascade after this loop withdraws those callers
  // too; collecting the unit identities here is its input.
  const abiDivergentUnitIds = new Set<IrUnitId>();
  for (const entry of lowerEntries) {
    const name = entry.name;
    const owner = terminalOwnerOf(entry);
    try {
      if (!timerLoweringBoundary.prepare(entry)) continue;
      if (process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW === "lower-synthetic" && entry.synthesized) {
        throw new Error("injected synthetic lower failure");
      }
      // (#3142 Slice 2) The module-init unit's slot is its exact legacy
      // allocator function (it is never in `ctx.funcMap`; the slot was
      // registered structurally by compileDeclarations).
      const funcIdx = artifactFuncIdx(entry);
      if (funcIdx === undefined) {
        markOwnerInvariant(
          owner,
          entry.artifactUnitId,
          name,
          "missing-function-slot",
          "patch",
          `no funcIdx allocated for ${name}`,
        );
        continue;
      }
      // #1916 S2 — definedFuncAt/replaceDefinedFuncAt are the positional
      // read/write chokepoints (func-space.ts).
      const existing = definedFuncAt(ctx, funcIdx);
      if (!existing) {
        markOwnerInvariant(
          owner,
          entry.artifactUnitId,
          name,
          "missing-function-slot",
          "patch",
          `funcIdx ${funcIdx} out of local range for ${name}`,
        );
        continue;
      }

      const wasmFunc = lowerIrEntryFunction(ctx, entry.fn, resolver, existing);
      // #1370 Phase B: signature parity guard for class methods.
      //
      // The legacy `class-bodies.ts` pass pre-allocated this method's
      // typeIdx, and any legacy-compiled caller already emitted
      // `call $methodFuncIdx` ops that route through that typeIdx. If
      // the IR-lowered body's typeIdx differs (e.g. f64 vs i32 for the
      // same TS `number`), patching would leave callers calling through
      // a stale type — Wasm validation fails, or worse, runtime UB.
      //
      // `addFuncType` deduplicates on signature, so identical sigs
      // produce identical typeIdx. A mismatch here means the IR resolved
      // a different ValType than legacy. Skip the patch — the legacy
      // body stays in place; the IR's effort goes uncommitted but no
      // regression occurs.
      //
      // (#3536) Top-level FunctionDeclarations now share the guard too. The
      // old exemption assumed "no legacy callers depend on the slot's prior
      // typeIdx" — false: `__module_init` (and any legacy-compiled body) that
      // calls the function has ALREADY emitted its call-argument coercions
      // against the collect-time signature (`getFuncParamTypes` at that
      // moment), and those bodies are not re-visited after this patch. A
      // call-site-narrowed implicit-`any` param (a shape-struct ValType from
      // inferParamTypeFromCallSites) that the IR re-types as externref left
      // the module INVALID (V8: "call[0] expected type externref, found …")
      // or, one fixup later, silently passed a closed struct into a
      // dynamic-reading body → every member read `undefined`. `addFuncType`
      // dedups on shape, so an identical signature lands on the identical
      // typeIdx and the guard is a no-op for the common case; a mismatch
      // means the IR resolved a DIFFERENT ABI than the one already-compiled
      // callers bake — keep the legacy body (the IR's effort goes
      // uncommitted, recorded on the ledger; no regression occurs).
      // (#3142 Slice 2) `__module_init` shares the guard: its slot's
      // `()->()` typeIdx was interned by compileDeclarations and the wasm
      // `start` section / `_start` wrapper depend on it. `addFuncType`
      // dedups on shape, so the IR-lowered void unit lands on the same
      // index; a mismatch means the lowering went wrong — keep legacy.
      if (wasmFunc.typeIdx !== existing.typeIdx) {
        if (process.env.JS2WASM_DEBUG_ABI_PARITY === "1") {
          console.error(
            `[abi-parity-debug] ${name}: IR=${wasmFunc.typeIdx} ${JSON.stringify(ctx.mod.types[wasmFunc.typeIdx])} legacy=${existing.typeIdx} ${JSON.stringify(ctx.mod.types[existing.typeIdx])}`,
          );
          // (#4186) Also name the heap types the two signatures reference —
          // "IR=(ref 465) vs legacy=externref" is unactionable without knowing
          // WHAT type 465 is (a lattice-derived `__anon_N` shape struct vs a
          // fnctor struct vs a vec changes the diagnosis entirely).
          const referenced = new Set<number>();
          for (const t of [ctx.mod.types[wasmFunc.typeIdx], ctx.mod.types[existing.typeIdx]]) {
            if (t?.kind !== "func") continue;
            for (const v of [...t.params, ...t.results]) {
              if ((v.kind === "ref" || v.kind === "ref_null") && typeof v.typeIdx === "number") {
                referenced.add(v.typeIdx);
              }
            }
          }
          for (const idx of referenced) {
            const t = ctx.mod.types[idx] as { kind?: string; name?: string; fields?: unknown[] } | undefined;
            console.error(
              `[abi-parity-debug]   type ${idx}: kind=${t?.kind} name=${t?.name ?? "<unnamed>"} fields=${
                Array.isArray(t?.fields) ? JSON.stringify(t.fields) : "n/a"
              }`,
            );
          }
        }
        if (entry.classMember || entry.moduleInit) {
          // Pre-#3536 semantics unchanged: for these units a mismatch means
          // the lowering itself went wrong — a hard invariant.
          abiDivergentUnitIds.add(entry.artifactUnitId);
          markOwnerInvariant(
            owner,
            entry.artifactUnitId,
            name,
            "abi-type-index-mismatch",
            "patch",
            `${entry.moduleInit ? "module-init" : "class-method"} typeIdx parity mismatch: IR=${wasmFunc.typeIdx}, legacy=${existing.typeIdx} — keeping legacy body`,
          );
          continue;
        }
        if (existing.body.length > 0) {
          // Top-level function WITH a real legacy body: an EXPECTED,
          // recoverable divergence (the IR legitimately cannot express e.g. a
          // shape-struct param) — a soft withdraw-the-claim fallback, NOT a
          // compile error. The legacy body stays; callers keep the ABI they
          // compiled against.
          abiDivergentUnitIds.add(entry.artifactUnitId);
          markOwnerFailure(
            owner,
            entry.artifactUnitId,
            name,
            new IrUnsupportedError(
              "abi-signature-parity",
              "resolve",
              `function typeIdx parity mismatch: IR=${wasmFunc.typeIdx}, legacy=${existing.typeIdx} — keeping legacy body`,
            ),
            "patch",
          );
          continue;
        }
        // EMPTY pre-allocated slot (e.g. a lifted branch-hoisted nested
        // declaration whose slot carries a placeholder typeIdx and no body):
        // this is the original exemption's TRUE case — the IR body is the
        // ONLY body, so withdrawing would leave an empty function and an
        // invalid module (the 2026-07-23 #3536 CI regressions:
        // var-hoisting-scope / scope-and-error-handling). Fall through and
        // patch as before.
      }
      // Tail-call optimization parity with the legacy AST path (#602): the IR
      // `return` lowering never rewrites a trailing `call`/`call_ref` into
      // `return_call`, so IR-claimed (e.g. top-level recursive) functions lost
      // TCO and deep recursion overflowed the Wasm stack. Apply the conversion
      // here, where the full module type info is available to enforce the same
      // guards (param-count + return-type match, never inside a try-with-handler).
      //
      // (#3142 Slice 2) EXCEPT for the module-init unit: later pipeline passes
      // APPEND epilogue instrs to the `__module_init` body — most critically
      // `finalizeInModuleInitFlag` (#2800), which wraps the body with
      // `__in_module_init = 1 … = 0`. The legacy body FALLS THROUGH; an
      // explicit trailing `return` (the IR's void-return lowering) or a
      // `return_call` rewrite would make every appended epilogue instr
      // unreachable — the flag stays 1 forever and every delete-aware read
      // misroutes (the PR #3168 merge_group regression:
      // language/statements/for-in/order-simple-object.js). So: no TCO for
      // module-init, strip the trailing `return`, and if ANY other
      // return-class op remains anywhere in the body, keep the legacy body.
      let finalBody: Instr[];
      if (entry.moduleInit) {
        finalBody = [...wasmFunc.body];
        while (finalBody.length > 0 && finalBody[finalBody.length - 1]!.op === "return") {
          finalBody.pop();
        }
        if (bodyContainsReturnClassOp(finalBody)) {
          markOwnerInvariant(
            owner,
            entry.artifactUnitId,
            name,
            "abi-type-index-mismatch",
            "lower",
            "module-init body contains a non-trailing return-class op — appended init epilogues would be skipped; keeping legacy body",
          );
          continue;
        }
        // (#3523 R4 gap 3) WASI idempotence, as CONSTRUCTION rather than splice.
        //
        // `applyModuleInitGuard` makes `__module_init` re-entrant-safe by
        // prepending `global.get $done / if(return) / $done = 1` to an already
        // emitted body. A Prepared body cannot take that: the early `return` is
        // precisely the return-class op the scan above withdraws the patch over,
        // and the body identity is sealed at the preparation snapshot.
        //
        // The wrapping-`if` form is equivalent and composes: it introduces no
        // return-class op, so the scan passes and every later epilogue
        // (`finalizeInModuleInitFlag`'s `__in_module_init = 0` above all) still
        // executes on the already-initialized path — which the early-`return`
        // form would skip. `plantPreparedWasiModuleInitGuard` is set only by the
        // prepared preparation call, so the post-direct overlay never plants a
        // second guard on the legacy WASI lane.
        const wasiGuard = options?.plantPreparedWasiModuleInitGuard ? ctx.preparedWasiModuleInitGuard : undefined;
        if (wasiGuard && wasiGuard.planted === undefined) {
          const doneGet: Instr = { op: "global.get", index: wasiGuard.doneGlobalIdx };
          const eqz: Instr = { op: "i32.eqz" };
          const guardIf: Instr = {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "global.set", index: wasiGuard.doneGlobalIdx }, ...finalBody],
          };
          finalBody = [doneGet, eqz, guardIf];
          wasiGuard.planted = { doneGet, eqz, guard: guardIf };
        }
      } else {
        finalBody = applyIrTailCalls(ctx, wasmFunc.body, wasmFunc.typeIdx);
      }
      pendingPatches.push({ entry, funcIdx, existing, wasmFunc, finalBody });
    } catch (e) {
      markOwnerFailure(owner, entry.artifactUnitId, name, e, "lower");
    }
  }

  // All post-lowering aggregate checks stay inside one aborting guard. Any
  // invariant here is still before the owner/session commit boundary, so the
  // open ABI scope must be closed before the error escapes.
  try {
    // (#3551) ABI-parity withdrawal CASCADE. A withdrawal above keeps the
    // callee's LEGACY body and typeIdx — but every IR body was compiled against
    // `calleeTypes`, the IR's shared view of each claimed function's signature,
    // which the parity mismatch just proved DIFFERS from that legacy ABI for the
    // withdrawn unit. Committing a caller while withdrawing its callee therefore
    // strands the caller on the wrong ABI: the #3503 partial-commit regression
    // (tests/issue-3471.test.ts) committed `check`'s IR body — which passed raw
    // f64 args per the IR view of `isSameValue` — while `isSameValue` withdrew
    // to its legacy `(externref, externref)` signature, producing invalid Wasm
    // ("call[0] expected type f64, found call of type externref") after the
    // stack-balance repair mangled the arg coercions. So: withdraw every still-
    // pending patch whose IR body references a parity-withdrawn name. One level
    // is a fixpoint — a cascade-withdrawn caller PASSED the guard itself (its
    // IR typeIdx equals its legacy typeIdx), so keeping its legacy body changes
    // nothing about the ABI its own callers compiled against.
    if (abiDivergentUnitIds.size > 0) {
      for (const patch of pendingPatches) {
        if (failedOwners.has(patch.entry.terminalOwnerUnitId)) continue;
        const referenced = findReferencedWithdrawnIrUnit(patch.entry.fn, abiDivergentUnitIds);
        if (referenced === undefined) continue;
        markOwnerFailure(
          terminalOwnerOf(patch.entry),
          patch.entry.artifactUnitId,
          patch.entry.name,
          new IrUnsupportedError(
            "abi-signature-parity",
            "resolve",
            `body references ${referenced.name}, whose claim was withdrawn on a typeIdx parity mismatch — the call ABI baked from calleeTypes no longer matches; keeping legacy body`,
          ),
          "patch",
        );
      }
    }

    // A cross-source component has one commit boundary. Once any terminal owner
    // fails after preparation, discard every pending patch from this invocation;
    // otherwise a healthy sibling could be installed against an ABI whose
    // component peer retained its legacy body.
    const atomicAborted = options?.atomicComponent === true && failedOwners.size > 0;
    const successfulPatches = atomicAborted
      ? []
      : pendingPatches.filter((patch) => !failedOwners.has(patch.entry.terminalOwnerUnitId));
    const authoritativeCountedPlans = [...(loweringPlans?.countedStringAppends?.values() ?? [])];
    for (const patch of successfulPatches) {
      if (
        patch.entry.countedStringAppendPlans?.length &&
        patch.entry.artifactUnitId !== patch.entry.terminalOwnerUnitId
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `counted-string plans cannot attach to synthetic artifact ${patch.entry.artifactUnitId}`,
        );
      }
    }
    const observedCountedPlans = successfulPatches.flatMap((patch) => patch.entry.countedStringAppendPlans ?? []);
    if (
      observedCountedPlans.length !== authoritativeCountedPlans.length ||
      authoritativeCountedPlans.some((plan) => !observedCountedPlans.includes(plan)) ||
      observedCountedPlans.some((plan) => !authoritativeCountedPlans.includes(plan))
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "counted-string authoritative retained-plan/final-artifact census drift",
      );
    }
    const associatedCountedReceipts = associateFinalIrCountedStringAppendSites(
      authoritativeCountedPlans,
      successfulPatches.map((patch) => ({
        artifactUnitId: patch.entry.artifactUnitId,
        terminalOwnerUnitId: patch.entry.terminalOwnerUnitId,
        instructions: collectFinalIrCountedStringAppendInstructions(patch.entry.fn),
      })),
    );
    // Patch only after every artifact lowered successfully. A lifted/clone
    // failure invalidates its whole source owner, including an already-lowered
    // main artifact, so the ledger can never report emitted+fatal for one row.
    const installedArtifactUnitIds = new Set<IrUnitId>();
    for (const patch of pendingPatches) {
      if (atomicAborted || failedOwners.has(patch.entry.terminalOwnerUnitId)) continue;
      const replacement = {
        name: patch.existing.name,
        typeIdx: patch.wasmFunc.typeIdx,
        locals: patch.wasmFunc.locals,
        body: patch.finalBody,
        exported: patch.existing.exported,
      };
      if (options?.deferPreparedPublication) {
        if (patch.entry.derivedUnit !== undefined) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "patch",
            `detached prepared component cannot defer derived artifact ${patch.entry.artifactUnitId}`,
          );
        }
        detachedPreparedPatches.push({
          entry: patch.entry,
          artifactUnitId: patch.entry.artifactUnitId,
          terminalOwnerUnitId: patch.entry.terminalOwnerUnitId,
          funcIdx: patch.funcIdx,
          existing: patch.existing,
          replacement,
          finalBody: patch.finalBody,
        });
      } else {
        const installed = replaceUnitCallableAt(
          patch.entry.artifactUnitId,
          patch.entry.terminalOwnerUnitId,
          patch.funcIdx,
          patch.existing,
          replacement,
        );
        settlePreparedDerivedCallable(ctx, patch.entry, installed, unitCallableSlots.get(patch.entry.artifactUnitId));
      }
      installedArtifactUnitIds.add(patch.entry.artifactUnitId);
      compiled.push(patch.entry.name);
      compiledArtifactEvidence.push({
        artifactUnitId: patch.entry.artifactUnitId,
        terminalOwnerUnitId: patch.entry.terminalOwnerUnitId,
        name: patch.entry.name,
        ...(preparedComponentIdByTerminalUnitId.get(patch.entry.terminalOwnerUnitId) === undefined
          ? {}
          : {
              preparedComponentId: preparedComponentIdByTerminalUnitId.get(patch.entry.terminalOwnerUnitId)!,
            }),
      });
      if (patch.entry.artifactUnitId === patch.entry.terminalOwnerUnitId) {
        compiledOwners.push(patch.entry.ownerName);
      }
    }
    for (const receipt of associatedCountedReceipts) {
      const identity = requireValidPreparedCountedStringAppendReceipt(receipt);
      if (!installedArtifactUnitIds.has(identity.ownerUnitId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "patch",
          `counted-string receipt ${receipt.siteId} has no installed exact terminal artifact`,
        );
      }
    }
    preparedCountedStringAppendReceipts.push(...associatedCountedReceipts);

    // (#3551) Stub orphaned empty slots. Two slot families can be stranded
    // BODYLESS when their owner fails after allocation (at lower time or via
    // the cascade above): fresh slots (mono clones / lifted fns), and
    // pre-allocated slots whose legacy body was empty (a branch-hoisted nested
    // declaration — the guard's empty-slot fall-through case, where the IR body
    // was the only body on offer). An empty body is invalid Wasm for any
    // signature WITH results, and the slot can be reachable (a HEALTHY owner
    // may have committed a body that calls it). A lone `unreachable` validates
    // against every signature, keeps the rest of the module working, and traps
    // only on a path that actually enters the orphaned artifact. Empty VOID
    // bodies are already valid Wasm (fall-through) — leave those as-is rather
    // than converting today's silent no-op into a trap.
    const stubIfOrphanedEmpty = (unitId: IrUnitId, terminalOwnerUnitId: IrUnitId, funcIdx: number): void => {
      const orphan = definedFuncAt(ctx, funcIdx);
      if (!orphan || orphan.body.length > 0) return;
      const typeDef = ctx.mod.types[orphan.typeIdx];
      if (!typeDef || typeDef.kind !== "func" || typeDef.results.length === 0) return;
      replaceUnitCallableAt(unitId, terminalOwnerUnitId, funcIdx, orphan, {
        ...orphan,
        body: [{ op: "unreachable" }],
      });
    };
    for (const slot of freshSlots) {
      if (!options?.deferPreparedPublication && (atomicAborted || failedOwners.has(slot.terminalOwnerUnitId))) {
        stubIfOrphanedEmpty(slot.artifactUnitId, slot.terminalOwnerUnitId, slot.funcIdx);
      }
    }
    for (const patch of pendingPatches) {
      if (!options?.deferPreparedPublication && (atomicAborted || failedOwners.has(patch.entry.terminalOwnerUnitId))) {
        stubIfOrphanedEmpty(patch.entry.artifactUnitId, patch.entry.terminalOwnerUnitId, patch.funcIdx);
      }
    }

    const dropTerminal = process.env.JS2WASM_TEST_DROP_IR_TERMINAL;
    if (dropTerminal) {
      const owner =
        dropTerminal === "1"
          ? healthyForLower[0] && terminalOwnerOf(healthyForLower[0])
          : loweringPlans?.ownerProjection.getByLegacyName(dropTerminal);
      if (owner) {
        const retainedCompiled: string[] = [];
        const retainedCompiledArtifacts: IrIntegrationCompiledArtifactEvidence[] = [];
        const retainedCompiledOwners: string[] = [];
        for (let index = 0; index < compiledArtifactEvidence.length; index++) {
          const artifact = compiledArtifactEvidence[index]!;
          if (artifact.terminalOwnerUnitId === owner.unitId) continue;
          retainedCompiled.push(compiled[index]!);
          retainedCompiledArtifacts.push(artifact);
          if (artifact.artifactUnitId === artifact.terminalOwnerUnitId) {
            retainedCompiledOwners.push(activeOwnerProjection.requireUnit(artifact.terminalOwnerUnitId).legacyName);
          }
        }
        return finishReport(
          retainedCompiled,
          errors.filter((error) => error.func !== owner.legacyName),
          retainedCompiledOwners,
          failures.terminalFailureEvents.filter((event) => event.unitId !== owner.unitId),
          retainedCompiledArtifacts,
          preparedCountedStringAppendReceipts.filter(
            (receipt) => requireValidPreparedCountedStringAppendReceipt(receipt).ownerUnitId !== owner.unitId,
          ),
        );
      }
    }

    if (options?.deferPreparedPublication) {
      deferredPublicationFinalizing = true;
      const report = finishReport();
      publishPreparedReceipt(report);
      return report;
    }
    return finishReport();
  } catch (error) {
    abortDeferredPublication();
    throw error;
  }
}

/** Explicit result for the detached aggregate component integration lane. */
export interface PreparedProgramComponentCompilationResult {
  readonly report: IrIntegrationReport;
  readonly pendingReceipt?: PendingPreparedProgramComponentReceipt;
}

/**
 * Lower one exact aggregate callable component without installing its bodies
 * or publishing its ABI batch.  The owner claims the returned receipt only
 * after its final source/skip preflight, prepares the ABI scope, commits all
 * scopes together, and then applies the detached body assignments.
 */
export function compilePreparedProgramComponent(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection?: IrSelection,
  overrides?: IrTypeOverrideMap,
  classShapes?: ReadonlyMap<string, IrClassShape>,
  loweringPlans?: IrIntegrationLoweringPlans,
  options?: IrIntegrationOptions,
): PreparedProgramComponentCompilationResult {
  let pendingReceipt: PendingPreparedProgramComponentReceipt | undefined;
  const publicationSink = {
    publish: (draft: import("./prepared-component-publication.js").PreparedComponentPublicationDraft) => {
      const receipt = createPendingPreparedProgramComponentReceipt(draft);
      pendingReceipt = receipt;
      return receipt;
    },
  };
  const report = compileIrPathFunctions(ctx, sourceFile, selection, overrides, classShapes, loweringPlans, {
    ...options,
    sealPreparedComponents: true,
    atomicComponent: true,
    deferPreparedPublication: true,
    preparedComponentPublicationSink: publicationSink,
  });
  return pendingReceipt ? { report, pendingReceipt } : { report };
}

function hasExportModifier(fn: ts.FunctionDeclaration): boolean {
  return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * (#3551) Scan an IR function for any exact unit-bound symbolic reference to
 * one of `unitIds`.
 * `IrFuncRef` has exactly two carriers in the instruction set — direct `call`
 * targets and `closure.new` lifted-func refs — and terminators carry none.
 * Returns the first referenced unit and its compatibility label (for the
 * withdrawal detail), or undefined when the body references none of them.
 * Runtime/import/intrinsic/support bindings with a lookalike name are
 * intentionally ignored.
 */
export function findReferencedWithdrawnIrUnit(
  fn: IrFunction,
  unitIds: ReadonlySet<IrUnitId>,
): { readonly unitId: IrUnitId; readonly name: string } | undefined {
  let found: { readonly unitId: IrUnitId; readonly name: string } | undefined;
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (found) return;
        const ref =
          nested.kind === "call" ? nested.target : nested.kind === "closure.new" ? nested.liftedFunc : undefined;
        if (ref?.binding.kind === "unit" && unitIds.has(ref.binding.unitId)) {
          found = { unitId: ref.binding.unitId, name: ref.name };
        }
      });
      if (found) return found;
    }
  }
  return found;
}

/**
 * (#3142 Slice 2) Deep-scan a Wasm body for return-class ops (`return`,
 * `return_call`, `return_call_ref`) inside nested blocks. The `__module_init`
 * slot's body must FALL THROUGH — later passes append epilogue instrs
 * (`finalizeInModuleInitFlag`'s flag-clear, #2800) that a mid-body return
 * would skip. The selector's early-return barrier makes this unreachable in
 * practice; the scan is the airtight backstop.
 */
function bodyContainsReturnClassOp(body: readonly Instr[]): boolean {
  for (const instr of body) {
    if (instr.op === "return" || instr.op === "return_call" || instr.op === "return_call_ref") return true;
    const nested = instr as { then?: Instr[]; else?: Instr[]; body?: Instr[]; catchAll?: Instr[] };
    if (nested.then && bodyContainsReturnClassOp(nested.then)) return true;
    if (nested.else && bodyContainsReturnClassOp(nested.else)) return true;
    if (nested.body && bodyContainsReturnClassOp(nested.body)) return true;
    if (nested.catchAll && bodyContainsReturnClassOp(nested.catchAll)) return true;
    const catches = (instr as { catches?: { body: Instr[] }[] }).catches;
    if (catches) {
      for (const c of catches) if (c.body && bodyContainsReturnClassOp(c.body)) return true;
    }
  }
  return false;
}

/** Resolve a checker-owned module declaration to its exact structural/legacy slot pair. */
function resolveModuleBindingGlobal(
  ctx: CodegenContext,
  identity: IrModuleBindingIdentity,
  postWasmStartTdzSafeBindingsByOwnerUnitId?: IrIntegrationLoweringPlans["postWasmStartTdzSafeBindingsByOwnerUnitId"],
): ModuleBindingGlobal {
  const declaration = identity.declaration;
  if (!ts.isIdentifier(declaration.name)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      "module-init: a supported binding identity no longer has an identifier declaration",
    );
  }
  const name = declaration.name.text;
  const globalName = `__mod_${name}`;
  const observed = ctx.programAbiGlobals?.moduleBinding(declaration);
  let global: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    if (!observed || observed.displayName !== name) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `module-init: supported binding '${name}' has no exact allocator-owned module global`,
      );
    }
    global = observed.value;
  } else {
    const globalIdx = ctx.moduleGlobals.get(name);
    if (globalIdx === undefined) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `module-init: supported binding '${name}' is absent from the compatibility module-global registry`,
      );
    }
    global = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  }
  if (!global || global.name !== globalName) {
    throw new IrInvariantError(
      "unknown-global-ref",
      "build",
      `module-init: module-global allocation for '${name}' does not resolve ${globalName}`,
    );
  }
  if (!global.mutable) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `module-init: legacy global ${globalName} is immutable but IR module bindings require a writable slot`,
    );
  }

  let type: IrType;
  let storageType: ValType;
  switch (identity.valueKind.kind) {
    case "f64":
      type = { kind: "val", val: { kind: "f64" } };
      storageType = { kind: "f64" };
      break;
    case "i32":
      type = { kind: "val", val: { kind: "i32" } };
      storageType = { kind: "i32" };
      break;
    case "dynamic":
      type = irDynamic();
      storageType = resolveIrDynamicCarrierType(ctx);
      break;
    case "extern":
    case "capability-extern":
      if (!ctx.externClasses.has(identity.valueKind.className)) {
        throw new IrInvariantError(
          "unknown-type-ref",
          "build",
          `module-init: extern binding '${name}' references unregistered class ${identity.valueKind.className}`,
        );
      }
      type = { kind: "extern", className: identity.valueKind.className };
      storageType = { kind: "externref" };
      break;
    case "native-map": {
      // (#4461) Legacy allocated `__mod_<name>` from `resolveTypeToValType`'s
      // #1103a arm, i.e. `(ref null $Map)`. Materialize the SAME struct here
      // (idempotent) and carry its exact ValType so the storage check below is
      // a real agreement test rather than a restatement.
      ensureMapHelpers(ctx);
      if (ctx.mapTypeIdx < 0) {
        throw new IrInvariantError(
          "unknown-type-ref",
          "build",
          `module-init: native-map binding '${name}' has no registered $Map struct`,
        );
      }
      storageType = { kind: "ref_null", typeIdx: ctx.mapTypeIdx };
      type = { kind: "val", val: storageType };
      break;
    }
  }
  const storageMatches =
    global.type.kind === storageType.kind &&
    ((global.type.kind !== "ref" && global.type.kind !== "ref_null") ||
      (storageType.kind === global.type.kind && storageType.typeIdx === global.type.typeIdx));
  if (!storageMatches) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `module-init: ${globalName} uses legacy ${global.type.kind} storage but IR resolved ${storageType.kind}`,
    );
  }

  const expectedTdzGlobalName = `__tdz_${name}`;
  let tdzGlobal: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    tdzGlobal = observed?.tdz;
    if (ctx.tdzLetConstNames.has(name) && !tdzGlobal) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `module-init: supported binding '${name}' has no exact allocator-owned TDZ global`,
      );
    }
  } else {
    const tdzGlobalIdx = ctx.tdzGlobals.get(name);
    tdzGlobal = tdzGlobalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, tdzGlobalIdx)];
  }
  if (tdzGlobal && tdzGlobal.name !== expectedTdzGlobalName) {
    throw new IrInvariantError(
      "unknown-global-ref",
      "build",
      `module-init: TDZ allocation for '${name}' does not resolve ${expectedTdzGlobalName}`,
    );
  }
  const tdzGlobalName = tdzGlobal ? expectedTdzGlobalName : null;
  const capability = identity.valueKind.kind === "capability-extern" ? identity.valueKind.capability : undefined;
  const globalRef = irSourceGlobalRef(identity.globalBindingId, globalName, capability);
  const tdzGlobalRef = tdzGlobal ? irSourceGlobalRef(identity.tdzBindingId, expectedTdzGlobalName) : null;
  planProgramAbiGlobal(ctx, {
    ref: globalRef,
    anchor: { kind: "source", sourceId: identity.sourceId },
    storageOwnerUnitId: identity.storageOwnerUnitId,
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal: identity.declarationOrdinal,
    global,
  });
  if (tdzGlobal && tdzGlobalRef) {
    planProgramAbiGlobal(ctx, {
      ref: tdzGlobalRef,
      anchor: { kind: "source", sourceId: identity.sourceId },
      storageOwnerUnitId: identity.storageOwnerUnitId,
      roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleTdz,
      derivedOrdinal: identity.declarationOrdinal,
      global: tdzGlobal,
    });
  }
  return {
    ownerUnitId: identity.ownerUnitId,
    globalRef,
    tdzGlobalRef,
    globalName,
    tdzGlobalName,
    type,
    ...(capability ? { capability } : {}),
    ...(postWasmStartTdzSafeBindingsByOwnerUnitId?.get(identity.ownerUnitId)?.has(identity.globalBindingId)
      ? { omitTdzReadCheck: true as const }
      : {}),
  };
}

/**
 * (#3142 Slice 2) Map every top-level declared binding in the module-init
 * population to its legacy-allocated Wasm global (`__mod_<name>`, TDZ flag
 * `__tdz_<name>` when tracked). Capability C admits f64/i32 and branded
 * externref storage; every unsupported representation demotes the whole unit.
 */
function buildModuleBindingsMap(
  ctx: CodegenContext,
  population: readonly ts.Statement[],
  resolveModuleBinding: IrModuleBindingResolver,
): Map<string, ModuleBindingGlobal> {
  const map = new Map<string, ModuleBindingGlobal>();
  for (const stmt of population) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) {
        throw new IrUnsupportedError(
          "module-init-legacy-coupling",
          "build",
          "module-init: top-level destructuring has no one-to-one legacy global mapping",
        );
      }
      const name = d.name.text;
      const inspected = resolveModuleBinding.inspectDirectBinding(d.name);
      if (inspected.kind === "unsupported") {
        throw new IrUnsupportedError(
          "module-init-legacy-coupling",
          "build",
          `module-init: top-level binding '${name}' has no supported legacy storage representation`,
        );
      }
      if (inspected.kind === "not-direct") {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `module-init: declaration '${name}' no longer resolves to the direct top-level binding selected for this unit`,
        );
      }
      const binding = resolveModuleBindingGlobal(ctx, inspected.identity);
      map.set(name, binding);
    }
  }
  return map;
}

/**
 * #1587 rollout gate. The ownership analysis is default-OFF: it only runs the
 * extra (inert) analysis pass when explicitly enabled, so production builds pay
 * nothing and emitted Wasm is unchanged until a consumer opts in.
 */
function ownershipAnalysisEnabled(): boolean {
  return process.env.JS2WASM_IR_OWNERSHIP === "1" || process.env.JS2WASM_IR_OWNERSHIP === "true";
}

/**
 * #747 rollout gate. Escape analysis is default-OFF and inert; enabling it runs
 * the ownership pass (its oracle) too. Stack allocation / scalar replacement
 * consuming the classification is a follow-up — Phase 1 only annotates.
 */
function escapeAnalysisEnabled(): boolean {
  return process.env.JS2WASM_IR_ESCAPE === "1" || process.env.JS2WASM_IR_ESCAPE === "true";
}

/**
 * Run the Phase 3a IR hygiene pipeline to fixpoint.
 *
 * Pipeline order (spec #1167a):
 *   constantFold → deadCode → simplifyCFG
 *
 * Each pass returns the same IrFunction reference when it makes no
 * changes, so reference equality is a reliable "unchanged" signal. The
 * loop iterates until a full pass round is a no-op. An iteration cap
 * guards against pathological non-convergence — with the V1 passes each
 * loop strictly removes instructions or blocks, so real code converges
 * in a handful of rounds.
 */
function runHygienePasses(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  const MAX_ITERS = 10;
  let cur = fn;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const afterCF = constantFold(cur, registry);
    // #4424 — flag-gated structure-tree GVN (default OFF, gate lives in gvn.ts).
    const afterGVN = gvnFromEnv(afterCF);
    const afterDCE = deadCode(afterGVN, registry);
    const afterCFG = simplifyCFG(afterDCE);
    if (afterCFG === cur) return cur;
    cur = afterCFG;
  }
  return cur;
}

/**
 * String-backend funcIdx resolution captured at Phase-3 entry.
 *
 * `ctx.jsStringImports` (host lane) can go stale after the late import shifts
 * triggered during legacy compileDeclarations, so host ops are resolved by name
 * against the current `ctx.funcMap`.
 *
 * (#3909) `ctx.nativeStrHelpers` is the opposite case and used to be described
 * here as equally stale — it is not. Its entries are STABLE-regime handles
 * (`mintDefinedFunc`, #1916 S3) that no shifter touches and that
 * `resolveLayout` maps to a concrete index once, at emit, off the FINAL layout.
 * Preferring a positional `numImportFuncs + i` scan over that handle downgrades
 * a shift-immune id to a live index the shift guard abandons once the import
 * count passes it — the #3909 `__str_trimStart` miscompile. Native helpers
 * therefore resolve via `nativeStrHelperHandle` (src/codegen/func-space.ts).
 */
interface StringBackendIndices {
  /** Native-string helper funcIdx by name — null when missing. */
  readonly nativeHelpers: ReadonlyMap<string, number>;
  /** wasm:js-string import funcIdx by op name — null when missing. */
  readonly hostImports: ReadonlyMap<string, number>;
}

function computeStringBackend(ctx: CodegenContext): StringBackendIndices {
  const nativeHelpers = new Map<string, number>();
  const hostImports = new Map<string, number>();

  // Native helpers are defined functions; resolve each to a handle.
  // (#3909) `nativeStrHelperHandle` prefers the STABLE-regime handle over the
  // positional `numImportFuncs + i` scan this used to do inline — a live index
  // baked here has to be chased by every later shifter, and the shift guard
  // (`idx >= importsBefore`) silently stops chasing it once the import count
  // climbs past it. See the helper's doc comment for the measured failure.
  if (ctx.nativeStrings) {
    for (const name of ["__str_concat", "__str_equals", "__str_concat_owned"]) {
      const h = nativeStrHelperHandle(ctx, name);
      if (h !== undefined) nativeHelpers.set(name, h);
    }
  } else {
    // wasm:js-string imports live in `ctx.funcMap` keyed by op name (see
    // `addStringImports`). `funcMap` IS shift-aware, so this lookup is
    // already in the post-shift index space.
    for (const op of ["concat", "equals", "length"] as const) {
      const idx = ctx.funcMap.get(op);
      if (idx !== undefined) hostImports.set(op, idx);
    }
  }
  return { nativeHelpers, hostImports };
}

/**
 * Late-bound resolver delegate — used so the recursive struct registry
 * (which needs to lower IrType→ValType, including string types via the
 * resolver) and the resolver (whose resolveObject delegates to the
 * registry) can both refer to each other without a circular import.
 */
interface DeferredObjectResolver {
  resolve: (shape: IrObjectShape) => IrObjectStructLowering | null;
}

interface DeferredClosureResolver {
  resolveBase: (sig: IrClosureSignature) => IrClosureLowering | null;
  resolveSubtype: (
    sig: IrClosureSignature,
    fields: readonly IrType[],
    hostOneShot?: boolean,
    domCallbackAuthority?: IrDomCallbackAuthority,
    liftedFuncIdx?: number,
  ) => IrClosureLowering | null;
}

interface DeferredRefCellResolver {
  resolve: (inner: ValType) => IrRefCellLowering | null;
}

interface DeferredClassResolver {
  resolve: (shape: IrClassShape) => IrClassLowering | null;
}

/** Exact binding of one structural source unit to its settled Wasm slot. */
/**
 * Slice 6 part 4 refactor (#1185): build the from-ast subset of the
 * IR resolver eagerly (before Phase 1 IR build). Only the methods
 * from-ast actually consults — `nativeStrings()`, `resolveString()`,
 * `resolveVec()` — are populated; everything else is absent.
 *
 * This is decoupled from `makeResolver` (the full Phase-3 resolver)
 * because the from-ast layer needs resolver-time info during build,
 * but the full resolver depends on lazy registries that don't exist
 * yet at that point. The two share the same logic for the methods
 * both expose — see `makeResolver` for the full body.
 */
/**
 * #1804 — shared `resolveVecForElement` body for both resolvers. Get-or-creates
 * the `$arr`/`$vec` types for `elementValType` via the legacy registry (so the
 * constructed vec shares identity with `compileArrayLiteral` output), and
 * returns the `IrVecLowering` the `vec.new_fixed` emitter needs. Mirrors the
 * legacy elemKind derivation in `compileArrayLiteral` (literals.ts) so the
 * registry keys collide intentionally and no parallel type is registered.
 */
function resolveVecForElementImpl(
  ctx: CodegenContext,
  elementValType: ValType,
): import("./lower.js").IrVecLowering | null {
  // Match the legacy elemKind key: ref/ref_null elements key on `ref_<typeIdx>`,
  // everything else on the ValType kind.
  const elemKind =
    elementValType.kind === "ref" || elementValType.kind === "ref_null"
      ? `ref_${(elementValType as { typeIdx: number }).typeIdx}`
      : elementValType.kind;
  const vecStructTypeIdx = getOrRegisterVecType(ctx, elemKind, elementValType);
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, vecStructTypeIdx);
  if (arrayTypeIdx < 0) return null;
  const arrayDef = ctx.mod.types[arrayTypeIdx];
  if (!arrayDef || arrayDef.kind !== "array") return null;
  return {
    valueType: { kind: "ref", typeIdx: vecStructTypeIdx },
    vecStructTypeIdx,
    lengthFieldIdx: 0,
    dataFieldIdx: 1,
    arrayTypeIdx,
    elementValType: arrayDef.element,
  };
}

/** Recover the exact registered vec layout behind a physical ref carrier. */
function resolvePhysicalVecImpl(ctx: CodegenContext, valueType: ValType): import("./lower.js").IrVecLowering | null {
  if (valueType.kind !== "ref" && valueType.kind !== "ref_null") return null;
  const typeIdx = valueType.typeIdx;
  // A coincidental `{ length: i32, data: ref array }` user struct is not a
  // vector. Only allocator objects registered by the canonical vec registry
  // may cross the prepared boundary as logical `IrType.vec` values.
  if (![...ctx.vecTypeMap.values()].includes(typeIdx)) return null;
  const vecDef = ctx.mod.types[typeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length < 2) return null;
  const lengthField = vecDef.fields[0]!;
  const dataField = vecDef.fields[1]!;
  if (lengthField.type.kind !== "i32") return null;
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
  const arrayTypeIdx = dataField.type.typeIdx;
  const arrayDef = ctx.mod.types[arrayTypeIdx];
  if (!arrayDef || arrayDef.kind !== "array") return null;
  return {
    valueType,
    vecStructTypeIdx: typeIdx,
    lengthFieldIdx: 0,
    dataFieldIdx: 1,
    arrayTypeIdx,
    elementValType: arrayDef.element,
  };
}

/**
 * (#2856) Brand an externref-shaped extern-member result with its extern
 * class name, resolved from the checker's type AT THE USE SITE. Returns
 * `undefined` (no brand — the IR carries a plain externref) when the result
 * isn't externref-shaped, no use-site node is available, or the use-site type
 * has no named symbol (unions of distinct classes, type params, anonymous
 * shapes). An unbranded result still lowers correctly — it just can't
 * dispatch FURTHER member access, which then demotes that function cleanly.
 */
function externResultClassName(
  ctx: CodegenContext,
  node: ts.Node | undefined,
  result: ValType | undefined,
): string | undefined {
  if (!node || !result || result.kind !== "externref") return undefined;
  try {
    const t = ctx.checker.getTypeAtLocation(node);
    const nonNull = ctx.checker.getNonNullableType(t);
    const name = nonNull.getSymbol()?.name;
    if (!name || name === "__type" || name === "__object") return undefined;
    return name;
  } catch {
    return undefined;
  }
}

function resolveStandaloneRegExpTestGlobal(ctx: CodegenContext, plan: IrStaticRegExpTestPlan): IrGlobalRef {
  if (
    plan.globalBindingId === undefined ||
    plan.storageOwnerUnitId === undefined ||
    plan.sourceId === undefined ||
    plan.declarationOrdinal === undefined ||
    !ts.isIdentifier(plan.declaration.name)
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      "standalone RegExp test plan has no exact structural module-global identity",
    );
  }
  const name = plan.declaration.name.text;
  const globalName = `__mod_${name}`;
  const observed = ctx.programAbiGlobals?.moduleBinding(plan.declaration);
  let global: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    if (!observed || observed.displayName !== name) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `standalone RegExp carrier '${name}' has no allocator-owned module global`,
      );
    }
    global = observed.value;
  } else {
    const globalIdx = ctx.moduleGlobals.get(name);
    global = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  }
  if (!global || global.name !== globalName || global.type.kind !== "externref") {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `standalone RegExp carrier ${globalName} is not the legacy externref module slot`,
    );
  }
  const ref = irSourceGlobalRef(plan.globalBindingId, globalName);
  planProgramAbiGlobal(ctx, {
    ref,
    anchor: { kind: "source", sourceId: plan.sourceId },
    storageOwnerUnitId: plan.storageOwnerUnitId,
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal: plan.declarationOrdinal,
    global,
  });
  return ref;
}

function resolveRetainedFunctionMethod(
  ctx: CodegenContext,
  plan: IrRetainedFunctionMethodPlan,
): { readonly receiverGlobal: IrGlobalRef; readonly funcName: string } {
  if (
    plan.receiverUnitId === undefined ||
    plan.methodUnitId === undefined ||
    plan.receiverGlobalBindingId === undefined ||
    plan.receiverStorageOwnerUnitId === undefined ||
    plan.receiverSourceId === undefined ||
    plan.receiverDeclarationOrdinal === undefined ||
    !ts.isIdentifier(plan.receiverDeclaration.name) ||
    plan.receiverDeclaration.name.text !== plan.receiverName
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      "retained function method plan has no exact structural function-expression identity",
    );
  }

  const globalName = `__mod_${plan.receiverName}`;
  const observed = ctx.programAbiGlobals?.moduleBinding(plan.receiverDeclaration);
  let receiverGlobalDef: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    if (!observed || observed.displayName !== plan.receiverName) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `retained function receiver ${plan.receiverName} has no allocator-owned module global`,
      );
    }
    receiverGlobalDef = observed.value;
  } else {
    const globalIdx = ctx.moduleGlobals.get(plan.receiverName);
    receiverGlobalDef = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  }
  if (
    !receiverGlobalDef ||
    receiverGlobalDef.name !== globalName ||
    receiverGlobalDef.type.kind !== "externref" ||
    !receiverGlobalDef.mutable
  ) {
    throw new IrInvariantError(
      "unknown-global-ref",
      "build",
      `retained function receiver ${plan.receiverName} is not the legacy externref module slot`,
    );
  }
  const receiverGlobal = irSourceGlobalRef(plan.receiverGlobalBindingId, globalName);
  planProgramAbiGlobal(ctx, {
    ref: receiverGlobal,
    anchor: { kind: "source", sourceId: plan.receiverSourceId },
    storageOwnerUnitId: plan.receiverStorageOwnerUnitId,
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal: plan.receiverDeclarationOrdinal,
    global: receiverGlobalDef,
  });

  const funcName = `__call_m_${plan.methodName}_${plan.arity}`;
  const dispatcherIdx = ctx.funcMap.get(funcName);
  const dispatcher = dispatcherIdx === undefined ? undefined : definedFuncAt(ctx, dispatcherIdx);
  const signature = dispatcher ? ctx.mod.types[dispatcher.typeIdx] : undefined;
  if (
    !dispatcher ||
    dispatcher.name !== funcName ||
    !signature ||
    signature.kind !== "func" ||
    signature.params.length !== plan.arity + 1 ||
    signature.params.some((param) => param.kind !== "externref") ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref"
  ) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `retained ${plan.receiverName}.${plan.methodName} dispatcher does not have the exact receiver-first externref ABI`,
    );
  }
  return { receiverGlobal, funcName };
}

function resolveFnctorArrayMethod(
  ctx: CodegenContext,
  plan: IrFnctorArrayMethodPlan,
): { readonly receiverGlobal: IrGlobalRef; readonly funcName: string } {
  if (
    plan.receiverGlobalBindingId === undefined ||
    plan.receiverStorageOwnerUnitId === undefined ||
    plan.receiverSourceId === undefined ||
    plan.receiverDeclarationOrdinal === undefined ||
    !ts.isIdentifier(plan.receiverDeclaration.name) ||
    plan.receiverDeclaration.name.text !== plan.receiverName ||
    !plan.constructorDeclaration.name ||
    plan.constructorDeclaration.name.text !== plan.constructorName ||
    plan.methodName !== "filter" ||
    plan.arity !== 1 ||
    ctx.fnctorEscapeGate?.stableArrayPrototypeNames.has(plan.constructorName) !== true
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      "fnctor Array method plan has no exact structural carrier identity",
    );
  }

  const globalName = `__mod_${plan.receiverName}`;
  const observed = ctx.programAbiGlobals?.moduleBinding(plan.receiverDeclaration);
  let receiverGlobalDef: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    if (!observed || observed.displayName !== plan.receiverName) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `fnctor Array receiver ${plan.receiverName} has no allocator-owned module global`,
      );
    }
    receiverGlobalDef = observed.value;
  } else {
    const globalIdx = ctx.moduleGlobals.get(plan.receiverName);
    receiverGlobalDef = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  }
  if (
    !receiverGlobalDef ||
    receiverGlobalDef.name !== globalName ||
    receiverGlobalDef.type.kind !== "externref" ||
    !receiverGlobalDef.mutable
  ) {
    throw new IrInvariantError(
      "unknown-global-ref",
      "build",
      `fnctor Array receiver ${plan.receiverName} is not the legacy externref module slot`,
    );
  }
  const receiverGlobal = irSourceGlobalRef(plan.receiverGlobalBindingId, globalName);
  planProgramAbiGlobal(ctx, {
    ref: receiverGlobal,
    anchor: { kind: "source", sourceId: plan.receiverSourceId },
    storageOwnerUnitId: plan.receiverStorageOwnerUnitId,
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal: plan.receiverDeclarationOrdinal,
    global: receiverGlobalDef,
  });

  const funcName = `__call_m_${plan.methodName}_${plan.arity}`;
  const dispatcherIdx = ctx.funcMap.get(funcName);
  const dispatcher = dispatcherIdx === undefined ? undefined : definedFuncAt(ctx, dispatcherIdx);
  const signature = dispatcher ? ctx.mod.types[dispatcher.typeIdx] : undefined;
  if (
    !dispatcher ||
    dispatcher.name !== funcName ||
    !signature ||
    signature.kind !== "func" ||
    signature.params.length !== 2 ||
    signature.params.some((param) => param.kind !== "externref") ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref"
  ) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `fnctor Array ${plan.receiverName}.${plan.methodName} dispatcher does not have the exact receiver-first externref ABI`,
    );
  }
  return { receiverGlobal, funcName };
}

function resolveStaticNumericArrayGlobal(
  ctx: CodegenContext,
  plan: IrStaticNumericArrayPlan,
  expected: IrType,
): { readonly globalRef: IrGlobalRef; readonly type: IrType } {
  if (
    plan.globalBindingId === undefined ||
    plan.storageOwnerUnitId === undefined ||
    plan.sourceId === undefined ||
    plan.declarationOrdinal === undefined ||
    !ts.isIdentifier(plan.declaration.name) ||
    !acceptsStaticNumericArrayParam(expected)
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      "static numeric array direct-call plan has no exact ref-typed structural identity",
    );
  }
  const name = plan.declaration.name.text;
  const globalName = `__mod_${name}`;
  const observed = ctx.programAbiGlobals?.moduleBinding(plan.declaration);
  let global: GlobalDef | undefined;
  if (ctx.programAbiGlobals) {
    if (!observed || observed.displayName !== name) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `static numeric array '${name}' has no allocator-owned module global`,
      );
    }
    global = observed.value;
  } else {
    const globalIdx = ctx.moduleGlobals.get(name);
    global = globalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  }
  const nameOf = (i: number) => ctx.typeIdxToStructName.get(i);
  if (!global || global.name !== globalName || !staticNumericArrayGlobalMatches(global.type, expected, nameOf)) {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "build",
      `static numeric array ${globalName} does not match the direct callee's vec ABI`,
    );
  }
  const globalRef = irSourceGlobalRef(plan.globalBindingId, globalName);
  planProgramAbiGlobal(ctx, {
    ref: globalRef,
    anchor: { kind: "source", sourceId: plan.sourceId },
    storageOwnerUnitId: plan.storageOwnerUnitId,
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal: plan.declarationOrdinal,
    global,
  });
  return { globalRef, type: expected };
}

function makeFromAstResolver(
  ctx: CodegenContext,
  moduleBindingResolver?: IrModuleBindingResolver,
  postWasmStartTdzSafeBindingsByOwnerUnitId?: IrIntegrationLoweringPlans["postWasmStartTdzSafeBindingsByOwnerUnitId"],
  standaloneDomCapability?: IrStandaloneDomCapabilityPlan,
  fnctorParameterPreselection?: IrFnctorParameterPreselectionPlan,
  fnctorParameterPreselectionIsCurrent?: () => boolean,
): IrFromAstResolver {
  const isAmbientStringBinding = makeAmbientStringBindingPredicate(ctx.checker);
  const supportsBackendCapability = (capability: IrBackendTargetCapability): boolean =>
    supportsIrBackendTargetCapability(projectIrBackendTargetProfile(ctx.targetProfile, { fast: ctx.fast }), capability);
  return {
    ...preparedIrAsyncFromAstResolver(ctx),
    hostIndirectEvalTarget() {
      if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports || ctx.nativeStrings) return null;
      const functionIndex = ctx.funcMap.get("__extern_eval");
      const exactIndex = exactCallableImportIndex(ctx, "env", "__extern_eval");
      if (functionIndex === undefined || exactIndex === undefined || functionIndex !== exactIndex) return null;
      return irImportFuncRef("env", "__extern_eval");
    },
    isHoleyArrayConstructor: (expr) => ctx.holeyArrayConstructorNodes.has(expr),
    isHoleyArrayFilterCall: (expr) => ctx.holeyArrayFilterCallNodes.has(expr),
    isHoleyArrayElementStore: (expr) => {
      if (!ts.isIdentifier(expr.expression)) return false;
      const declaration = ctx.oracle.variableDeclarationOf(expr.expression);
      return declaration !== undefined && ctx.holeyArrayDeclarations.has(declaration);
    },
    standaloneWrapperInstanceOfPlan(ctorName: string) {
      if (
        !supportsBackendCapability("standalone-wrapper-instanceof") ||
        (ctorName !== "Number" && ctorName !== "String" && ctorName !== "Boolean")
      ) {
        return null;
      }
      const funcIdx = ensureStandaloneWrapperInstanceOfHelper(ctx, ctorName as StandaloneWrapperConstructorName);
      const func = definedFuncAt(ctx, funcIdx);
      if (!func) {
        throw new IrInvariantError(
          "unknown-function-ref",
          "build",
          `standalone wrapper instanceof helper ${ctorName} has no allocator-owned function`,
        );
      }
      return { funcName: func.name };
    },
    fnctorArrayMethodPlan(call: ts.CallExpression) {
      if (
        !supportsBackendCapability("standalone-native-regexp-test-carrier") ||
        !supportsBackendCapability("legacy-numeric-array-global") ||
        !moduleBindingResolver
      ) {
        return null;
      }
      const plan = moduleBindingResolver.fnctorArrayMethodPlan(call);
      return plan ? resolveFnctorArrayMethod(ctx, plan) : null;
    },
    retainedFunctionMethodPlan(call: ts.CallExpression) {
      if (
        !supportsBackendCapability("standalone-native-regexp-test-carrier") ||
        !supportsBackendCapability("legacy-numeric-array-global") ||
        !moduleBindingResolver
      ) {
        return null;
      }
      const plan = moduleBindingResolver.retainedFunctionMethodPlan(call);
      return plan ? resolveRetainedFunctionMethod(ctx, plan) : null;
    },
    standaloneRegExpTestPlan(receiver: ts.Expression) {
      if (!supportsBackendCapability("standalone-native-regexp-test-carrier") || !moduleBindingResolver) return null;
      const plan = moduleBindingResolver.staticRegExpTestPlan(receiver);
      if (!plan) return null;
      ensureStandaloneRegExpCarrierTestHelper(ctx);
      return {
        receiverGlobal: resolveStandaloneRegExpTestGlobal(ctx, plan),
        funcName: STANDALONE_REGEXP_CARRIER_TEST_HELPER,
      };
    },
    staticNumericArrayRead(expression: ts.Expression, expected: IrType) {
      if (
        !supportsBackendCapability("legacy-numeric-array-global") ||
        !moduleBindingResolver ||
        !acceptsStaticNumericArrayParam(expected)
      ) {
        return null;
      }
      const plan = moduleBindingResolver.staticNumericArrayPlan(expression);
      return plan ? resolveStaticNumericArrayGlobal(ctx, plan, expected) : null;
    },
    objectDefinePropertyTarget() {
      if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports) return null;
      return irImportFuncRef("env", "__defineProperty_desc");
    },
    functionPrototypeCallTarget() {
      if (!ctx.standalone || ctx.wasi) return null;
      return ensureFunctionPrototypeCallHelper(ctx) === undefined
        ? null
        : irRuntimeFuncRef(FUNCTION_PROTOTYPE_CALL_HELPER);
    },
    resolveDynamic() {
      return resolveIrDynamicCarrierType(ctx);
    },
    dynamicCarrierIsExternref() {
      return !ctx.fast;
    },
    fnctorNativeStringReplace(call: ts.CallExpression) {
      return (
        fnctorParameterPreselection?.nativeStringReplaceCall === call &&
        fnctorParameterPreselectionIsCurrent?.() === true
      );
    },
    // (#2955 slice 5) No raw `nativeStrings()` here anymore — from-ast's
    // interface no longer carries the mode discriminator; every mode
    // decision flows through the named capability/rep/strategy queries.
    // (#2955 slice 2) The WHOLE string-prototype-method mode decision table,
    // relocated here from from-ast's `lowerStringMethodCall` so the front-end
    // reads no `nativeStrings` at that site. Byte-inert by construction: the
    // returned plan reproduces exactly the decisions the old inline reads
    // made — same demotes (null), same target names, same index reps, same
    // pad strategy — so the emitted IR per mode is unchanged. The demote
    // half MUST stay a build-time answer (there is no lower-time demote
    // channel), which is why this is a resolver callback and not an
    // abstract-instr lowering case; promoting the rep half into a true
    // `str.method` instr is #2955's follow-up slice.
    stringMethodPlan(method: string, argCount: number, receiverEncoding: StringEncoding | undefined) {
      const native = ctx.nativeStrings;
      // (#3156) charCodeAt — BOTH modes lower to a guarded defined helper
      // `(recv, i32 idx) -> f64` (src/codegen/char-code-at-helpers.ts;
      // materialized on demand by resolveFunc below). NOT the bare
      // `wasm:js-string charCodeAt` builtin: that one traps out-of-range
      // (#2003) and its bare funcMap name is shadowable by a user function
      // named `charCodeAt` (#1072). An omitted position pads i32 0.
      if (method === "charCodeAt") {
        return {
          funcName: native ? "__str_charCodeAt" : "__jsstr_charCodeAt",
          indexArgRep: "i32" as const,
          padOmitted: "charcode-zero" as const,
        };
      }
      // #4576 — the native search helpers already own the exact one-argument
      // JS defaults: pass an explicit i32 zero for the omitted position. Keep
      // two-argument calls on legacy until the plan models indexOf's boxed host
      // fromIndex independently from the native helper's i32 representation.
      if (native && argCount === 1 && (method === "indexOf" || method === "includes")) {
        return {
          funcName: `__str_${method}`,
          indexArgRep: "i32" as const,
          padOmitted: "search-zero" as const,
          resultRep: method === "indexOf" ? ("i32-number" as const) : undefined,
        };
      }
      // #2002 — the native string backend lowers the position arg via its
      // own __str_* helpers (src/codegen/string-ops.ts); defer to the legacy
      // native path rather than re-implement position handling in the IR.
      if (
        native &&
        (method === "indexOf" || method === "includes" || method === "startsWith" || method === "endsWith")
      ) {
        return null;
      }
      const sig = STRING_METHOD_TABLE[method];
      if (!sig) return null;
      const omitted = argCount < sig.hostArgs.length;
      // Both substring helpers take i32 indices and enforce JS clamp/swap semantics.
      if (method === "substring") {
        return native
          ? {
              funcName: "__str_substring",
              indexArgRep: "i32" as const,
              padOmitted: "native-substring" as const,
            }
          : {
              funcName: JSSTR_SUBSTRING_FN,
              indexArgRep: "i32" as const,
              padOmitted: "native-substring" as const,
            };
      }
      // #1248 — native mode only lowers fully-specified call sites, except
      // `slice(start)` whose implicit end defaults to recv.length.
      if (native && omitted && !(method === "slice" && argCount === 1)) return null;
      const provenAsciiCaseHelper =
        native &&
        receiverEncoding === "ascii" &&
        process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE !== "0" &&
        (method === "toUpperCase" || method === "toLowerCase");
      return {
        funcName: native ? `__str_${method}${provenAsciiCaseHelper ? "_ascii" : ""}` : `string_${method}`,
        indexArgRep: (native ? "i32" : "f64") as "i32" | "f64",
        padOmitted: (native ? "native-slice-len" : "host") as "native-slice-len" | "host",
      };
    },
    preferLegacyFlatSubstringCharCodeAt(receiver: ts.Expression) {
      let current = receiver;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
      }
      if (!ts.isIdentifier(current)) return false;
      const symbol = ctx.checker.getSymbolAtLocation(current);
      const declaration = symbol?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
      const list = declaration.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
      return (
        ts.isCallExpression(declaration.initializer) &&
        ts.isPropertyAccessExpression(declaration.initializer.expression) &&
        declaration.initializer.expression.name.text === "substring"
      );
    },
    // (#3931) Backend half of the #2682 canonical char-read-loop hoist. The
    // front-end has already proven `0 <= i < recv.length` for every read in
    // the loop body; this decides what that proof BUYS in the current string
    // mode.
    //
    // Native strings: everything legacy's hoist did — flatten the receiver
    // once, park `.data`/`.off` in preheader slots, and read code units
    // straight out of the array. The struct types are needed to name the slot
    // ValTypes, so a mode where they are not registered (no string usage yet)
    // declines rather than guessing.
    //
    // Host strings: there is no flattenable descriptor — a host string is an
    // externref the engine owns — so the whole win is dropping the guard
    // around the `wasm:js-string.charCodeAt` builtin (which traps out of
    // range, #2003; the proof is what makes that unreachable). The builtin
    // imports may not be registered until `prepareStrings` runs, so this is
    // deliberately name-only and materialization stays in `resolveFunc`.
    charReadPlan() {
      if (ctx.nativeStrings) {
        if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0 || ctx.nativeStrDataTypeIdx < 0) return null;
        return {
          hoist: { flattenFuncName: NATIVE_FLATTEN_FN, readFuncName: NATIVE_FLAT_CHARCODEAT_FN },
          trustedFuncName: null,
        };
      }
      if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports) return null;
      return { hoist: null, trustedFuncName: JSSTR_CHARCODEAT_TRUSTED_FN };
    },
    stringFromCharCodePlan() {
      return ctx.nativeStrings
        ? { funcName: "__str_fromCharCode", argumentRep: "i32" as const }
        : { funcName: "String_fromCharCode", argumentRep: "f64" as const };
    },
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    // Slice 10 (#1169i): expose the legacy-collected extern-class
    // metadata to the from-ast layer. The legacy `collectExternFromDeclareVar`
    // and `collectInterfaceMembers` passes have already populated
    // `ctx.externClasses` by the time the IR runs, so this is a thin
    // pass-through. The from-ast layer slices `params[0]` off the
    // method signature (the legacy stores the receiver `externref` as
    // the first param so the host import takes a flat
    // `(receiver, args...)` shape).
    getExternClassInfo(className: string) {
      const info = ctx.externClasses.get(className);
      if (!info) {
        if (className !== "Date" || ctx.standalone || ctx.wasi || ctx.strictNoHostImports) return undefined;
        const externref = { kind: "externref" } as const;
        const f64 = { kind: "f64" } as const;
        return {
          className: "Date",
          importPrefix: "Date",
          constructorParams: [],
          methods: new Map([
            ["getDate", { params: [externref], results: [f64] }],
            ["getMonth", { params: [externref], results: [f64] }],
            ["getFullYear", { params: [externref], results: [f64] }],
          ]),
          properties: new Map(),
        };
      }
      return {
        className: info.className,
        importPrefix: info.importPrefix,
        constructorParams: info.constructorParams,
        methods: info.methods,
        properties: info.properties,
      };
    },
    // (#2856) Host-global identifier → the `global_<name>` handle import the
    // legacy `collectDeclaredGlobals` pass registered. Nothing to resolve in
    // host-free modes: that pass skips registration under
    // standalone/strictNoHostImports, so `document` correctly stays
    // unresolvable there (and the selector's capability gate already deferred
    // any function that references it).
    getHostGlobalInfo(name: string) {
      const g = ctx.declaredGlobals.get(name);
      if (!g || !g.className) return undefined;
      return { importName: `global_${name}`, className: g.className };
    },
    // (#2856) Mode flag for the capability invariant assert at the from-ast
    // host-extern arms.
    jsHostExterns(): boolean {
      return !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports);
    },
    standaloneDomOperation(node: ts.Node) {
      return standaloneDomCapability?.operation(node);
    },
    // (#4461) The three host-free capabilities the native-`$Map` arms consult.
    // They live here, on the lower/integration side, for the same #2955 reason
    // the box/unbox predicates do: from-ast reads no mode flags of its own.
    // PURE. Reports the storage type only if the `$Map` struct already exists;
    // it never registers one. The hot-path callers (every method receiver,
    // every `new`) use this one. See `ensureNativeMapStorageType` for the twin
    // and for the 508-file regression that made the split necessary.
    nativeMapStorageType(): IrType | undefined {
      if (!ctx.nativeStrings || ctx.mapTypeIdx < 0) return undefined;
      return { kind: "val", val: { kind: "ref_null", typeIdx: ctx.mapTypeIdx } };
    },
    // MATERIALIZING. Only for a call site that has already PROVEN it is looking
    // at a `Map`: `ensureMapHelpers` emits twelve functions and the struct
    // types, so reaching it speculatively puts the whole collection runtime
    // into modules that never mention `Map`.
    ensureNativeMapStorageType(): IrType | undefined {
      if (!ctx.nativeStrings) return undefined;
      ensureMapHelpers(ctx);
      if (ctx.mapTypeIdx < 0) return undefined;
      return { kind: "val", val: { kind: "ref_null", typeIdx: ctx.mapTypeIdx } };
    },
    // (#2955 slice 3) Rep predicate: the string carrier is externref (host
    // strings), so string SSA values flow unchanged into externref-expected
    // positions (`coerceToExpectedExtern` host-call args) and take the
    // externref-shaped `__extern_is_undefined` arm of the strict
    // undefined-compare. The from-ast string-rep arms consult THIS
    // predicate instead of reading `nativeStrings` directly — the mode
    // knowledge lives here, on the lower/integration side, per #2955's
    // de-polymorph direction. Implementation is deliberately the exact
    // truth value the old in-place reads produced (byte-inert relocation).
    // The demote arm this gates in `coerceToExpectedExtern` is a build-time
    // claim/demote decision (no lower-time demote channel) and — unlike the
    // number-box capability — has no widening follow-up: a native
    // `(ref $AnyString)` can never satisfy an externref host-arg position.
    stringIsExternref(): boolean {
      return !ctx.nativeStrings;
    },
    // (#2955 slice 4) Capability: this lane owns the `number_toString`
    // `(f64) -> externref` host import (legacy pre-registers it on any
    // checker-number `.toString()` in source; its return IS host-mode's
    // string carrier). The from-ast `<number>.toString()` arm consults THIS
    // predicate instead of reading `nativeStrings` directly — same
    // build-time capability shape as the retired number-box predicate,
    // deliberately the
    // exact truth value the old in-place `nativeStrings?.() === false` read
    // produced (byte-inert relocation). Widening — a native number
    // formatter returning the `(ref $AnyString)` carrier — is a semantic
    // follow-up tracked in #2955 and must be validated against the
    // standalone floor (the demote arm is load-bearing there).
    hasHostNumberToString(): boolean {
      return !ctx.nativeStrings;
    },
    // (#4462) The widening #2955 deferred — the disjoint twin of the predicate
    // above: `hasHostNumberToString` is "owns the `env.number_toString` import"
    // (`!nativeStrings`), this is "owns the host-free formatter"
    // (`nativeStrings`), so the two can never claim one call twice.
    nativeNumberToStringAvailable(): boolean {
      return irNativeNumberToStringAvailable(ctx);
    },
    // #4576 — bounded native Number::toFixed has a carrier-correct symbolic
    // provider; selection and build consult the same pure lane predicate.
    nativeNumberToFixedAvailable(): boolean {
      return irNativeNumberToFixedAvailable(ctx);
    },
    // (#4462) Standalone's host-free console sink (#3469). Minted in the
    // pre-body window, which precedes both IR planning and body lowering, so
    // `funcMap` presence is the same fact at claim time and at build time.
    standaloneConsoleSinkAvailable(): boolean {
      return standaloneConsoleSinkAvailable(ctx);
    },
    // (#2955 slice 5) String for-of strategy — the LAST from-ast mode read,
    // relocated. Native strings iterate via the `__str_charAt` counter loop;
    // host strings feed the `__iterator` host protocol (already
    // externref-shaped). Byte-inert: same truth table as the old in-place
    // `nativeStrings?.()` read (absent → iter-host).
    stringForOfPlan(): "char-loop" | "iter-host" {
      return ctx.nativeStrings ? "char-loop" : "iter-host";
    },
    // #2952 slice 5 — the source-independent enumeration ABI. Host mode
    // supplies imports; standalone/WASI supplies the #2964 native object
    // runtime. Both variants snapshot keys and perform per-visit liveness.
    dynamicForInPlan() {
      return ctx.standalone || ctx.wasi || ctx.targetProfile.semanticProviders === "native-first"
        ? {
            keys: "__object_keys_forin",
            len: "__extern_length",
            get: "__extern_get_idx",
            has: "__extern_has",
          }
        : {
            keys: "__for_in_keys",
            len: "__for_in_len",
            get: "__for_in_get",
            has: "__for_in_has",
          };
    },
    // (#2856 C2) TypedArray-view receiver detection for element STORES —
    // the same checker walk as the legacy `elementAccessTypedArrayName`
    // (assignment.ts): symbol name of the receiver's TS type against the
    // TYPED_ARRAY_NAMES registry. Writes into those views carry per-view
    // conversion semantics (ToUint8/ToUint8Clamp/packing) that the plain
    // vec store helper must not bypass, so the IR demotes them.
    isTypedArrayViewExpr(expr: ts.Expression): boolean {
      const t = ctx.checker.getTypeAtLocation(expr);
      let name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
      if ((!name || !TYPED_ARRAY_NAMES.has(name)) && ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
        name = expr.expression.text;
      }
      return !!name && TYPED_ARRAY_NAMES.has(name);
    },
    // (#2856 Capability C) Declaration identity is proven by the checker;
    // only then map it to the legacy slot and retain the logical extern brand.
    resolveModuleBinding(node: ts.Identifier, writeValue?: ts.Expression) {
      const identity = moduleBindingResolver?.(node, writeValue);
      return identity
        ? resolveModuleBindingGlobal(ctx, identity, postWasmStartTdzSafeBindingsByOwnerUnitId)
        : undefined;
    },
    isDirectModuleBinding(node: ts.Identifier): boolean {
      return moduleBindingResolver?.isDirectModuleBinding(node) === true;
    },
    isAmbientBinding(node: ts.Identifier): boolean {
      return moduleBindingResolver?.isAmbientBinding(node) === true;
    },
    isAmbientStringBinding,
    // (#2856) Variant selection for `console.<m>(arg)` — the SAME checker
    // predicates as the legacy `collectConsoleImports` registration scan
    // (string → bool → number → externref, in that order), so the import
    // name the IR resolves (`console_<m>_<variant>`) is registered by
    // construction.
    consoleArgVariant(arg: ts.Expression) {
      const argType = ctx.checker.getTypeAtLocation(arg);
      if (isStringType(argType)) return "string";
      if (isBooleanType(argType)) return "bool";
      if (isNumberType(argType)) return "number";
      return "externref";
    },
    // (#2856) Chain-walking extern-member resolution + use-site result
    // branding. Mirrors the legacy `resolveExtern` (collectUsedExternImports)
    // and `compileExternPropertyGetFromStack` walks: start at the receiver's
    // class, follow `externClassParent` until a class carries the member.
    // The RESULT brand comes from the checker at the use site (`node`) — the
    // same per-site resolution legacy property-access/calls use — because
    // registration-time member signatures collapse overloads (e.g.
    // `Document.createElement`'s first overload returns a type-param) and
    // cannot brand. `getNonNullableType` strips `| null` (e.g.
    // `getElementById(): HTMLElement | null`) so the brand survives unions
    // with null/undefined.
    resolveExternMember(className: string, memberName: string, kind: "method" | "property", node?: ts.Node) {
      let current: string | undefined = className;
      while (current) {
        const info = ctx.externClasses.get(current);
        if (info) {
          if (kind === "method") {
            const method = info.methods.get(memberName);
            if (method) {
              return {
                importPrefix: info.importPrefix,
                method,
                resultClassName: externResultClassName(ctx, node, method.results[0]),
              };
            }
          } else {
            const property = info.properties.get(memberName);
            if (property) {
              return {
                importPrefix: info.importPrefix,
                property,
                resultClassName: externResultClassName(ctx, node, property.type),
              };
            }
          }
        }
        current = ctx.externClassParent.get(current);
      }
      return undefined;
    },
    // Same logic as `IrLowerResolver.resolveVec` in `makeResolver`.
    // Walks `ctx.mod.types` to recover the vec layout from a `(ref|
    // ref_null) $vec_*` ValType. See the corresponding doc on
    // `IrLowerResolver.resolveVec` for the contract.
    resolveVec(valType: ValType) {
      return resolvePhysicalVecImpl(ctx, valType);
    },
    // #1804 — register-or-recover the vec struct for an element ValType, for
    // `vec.new_fixed` construction. See `resolveVecForElementImpl`.
    resolveVecForElement(elementValType: ValType) {
      return resolveVecForElementImpl(ctx, elementValType);
    },
    // #1375 narrow slice — TS-narrowing fast-path for optional chaining.
    // The IR's `isIrTypeNullable` flags `extern` (host class) values as
    // always nullable because at the Wasm level they're `externref`. But
    // TS narrowing often proves the receiver is non-null in context
    // (e.g. `m: Map<string, number>` without `| undefined`). When TS
    // confirms non-null, `lowerPropertyAccess` skips the `?.`-on-nullable
    // throw and lowers as a regular `.` access. Otherwise (genuinely
    // nullable, or no narrowing), legacy fallback continues.
    isExpressionTsNonNullable(expr: ts.Expression): boolean | undefined {
      const t = ctx.checker.getTypeAtLocation(expr);
      const nonNull = ctx.checker.getNonNullableType(t);
      // TS's `Type` objects are interned by the checker, so a strict
      // identity comparison is sound: equal identity ⇒ stripping null/
      // undefined was a no-op ⇒ the type was already non-null.
      return t === nonNull;
    },
  };
}

/**
 * (#4461) Give a reserve-time native runtime function its Program ABI identity
 * NOW, while planning can still see it.
 *
 * Prepared-component dependency discovery runs BEFORE lowering, and it fails a
 * component whose external callables have no planned identity
 * (`unplanned-abi-binding`). `resolveAndObserveCallableProvider` observes at
 * resolve time, which is too late for that check — so any runtime symbol the
 * reserve pass materializes must also be observed by the reserve pass.
 * Best-effort by design: a symbol the lane did not register simply stays
 * unobserved, and the component fails the same way it would have.
 */
function observeNativeRuntimeProvider(ctx: CodegenContext, symbol: string): void {
  const index = ctx.funcMap.get(symbol);
  if (index === undefined) return;
  ctx.programAbiCallableProviders?.observe(irRuntimeFuncRef(symbol), index);
}

function resolveAndObserveCallableProvider(
  ctx: CodegenContext,
  ref: IrFuncRef,
  // (#3526 F2-S1) The whole prepared manifest, not just its intrinsic-provider
  // map: the string-compare arm reads a FEATURE row (`js.string.compare`) that
  // no intrinsic use ever puts in that map, plus the frozen host-capability
  // records the host arm's field name comes from.
  prepared?: PreparedIrRuntimeManifest,
  fuseNativeNumberFormatCarriers = false,
): number {
  const runtimeProviders = prepared?.providers;
  if (ref.binding.kind !== "runtime" && ref.binding.kind !== "intrinsic") {
    throw new TypeError("callable-provider resolution requires a runtime or intrinsic reference");
  }
  const registry = ctx.programAbiCallableProviders;
  const existing = registry?.resolveCurrentIndex(ref);
  if (existing !== undefined) return existing;

  let index: number | null | undefined;
  const { symbol } = ref.binding;
  if (ref.binding.kind === "intrinsic" && isIntrinsicId(symbol)) {
    const provider = runtimeProviders?.get(symbol);
    if (!provider || provider.implementation.kind !== "self-hosted") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `semantic intrinsic ${symbol} has no frozen callable provider`,
      );
    }
    if (ref.name !== provider.implementation.symbol) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `semantic intrinsic ${symbol} changed provider from ${provider.implementation.symbol} to ${ref.name}`,
      );
    }
    index = preparedMathProviderIndex(ctx, provider.implementation.symbol);
  } else if (ref.binding.kind === "intrinsic" && isFmodIntrinsic(symbol)) {
    index = ensureFmodIntrinsic(ctx, symbol);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_ASYNC_CLOCK_SNAPSHOT_FN) {
    if (ctx.standalone) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "standalone async clock snapshot escaped its constant runtime projection",
      );
    }
    index = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_ASYNC_NUMBER_TO_STRING_FN) {
    index = ctx.nativeStrings
      ? ensureIrNativeNumberToString(ctx, fuseNativeNumberFormatCarriers)
      : ensureLateImport(ctx, "number_toString", [{ kind: "f64" }], [{ kind: "externref" }]);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_ASYNC_CONSOLE_LOG_STRING_FN) {
    index = ctx.nativeStrings
      ? (ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN) ?? null)
      : ensureLateImport(ctx, "console_log_string", [{ kind: "externref" }], []);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_ASYNC_STRING_CONCAT_5_FN) {
    index = ctx.nativeStrings
      ? ensureNativeBatchedConcat(ctx, 5)
      : ensureLateImport(
          ctx,
          "__concat_5",
          Array.from({ length: 5 }, () => ({ kind: "externref" }) as const),
          [{ kind: "externref" }],
        );
  } else if (ref.binding.kind === "intrinsic" && parseIrStringConcatManyArity(symbol) !== null) {
    const arity = parseIrStringConcatManyArity(symbol)!;
    index = ctx.nativeStrings
      ? ensureNativeBatchedConcat(ctx, arity)
      : ensureLateImport(
          ctx,
          `__concat_${arity}`,
          Array.from({ length: arity }, () => ({ kind: "externref" }) as const),
          [{ kind: "externref" }],
        );
  } else if (ref.binding.kind === "runtime" && symbol === "__new_ReferenceError") {
    if (ctx.wasi || ctx.standalone) {
      emitWasiErrorConstructor(ctx, "ReferenceError", 1);
      index = ctx.funcMap.get("__new_ReferenceError");
    } else {
      index = ensureLateImport(ctx, "__new_ReferenceError", [{ kind: "externref" }], [{ kind: "externref" }]);
    }
  } else if (ref.binding.kind === "intrinsic" && symbol.startsWith(IR_VEC_ELEM_SET_PREFIX)) {
    const element = parseIrVectorRuntimeElement(symbol, IR_VEC_ELEM_SET_PREFIX);
    index = element ? ensureVecElemSetForElement(ctx, element) : null;
  } else if (ref.binding.kind === "intrinsic" && symbol.startsWith(IR_VEC_NEW_SIZED_PREFIX)) {
    const element = parseIrVectorRuntimeElement(symbol, IR_VEC_NEW_SIZED_PREFIX);
    index = element ? ensureVecNewSizedForElement(ctx, element) : null;
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_HOLEY_ARRAY_NEW) {
    index = ensureHoleyArrayNew(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_HOLEY_ARRAY_ELEM_SET) {
    index = ensureVecElemSet(ctx, getOrRegisterHoleyArrayType(ctx));
  } else if (ref.binding.kind === "runtime" && symbol === IR_NUMBER_TO_STRING_NATIVE_FN) {
    // (#4462) Host-free `Number::toString` in the `(ref $AnyString)` carrier.
    index = ensureIrNativeNumberToString(ctx, fuseNativeNumberFormatCarriers);
  } else if (ref.binding.kind === "runtime" && symbol === IR_NATIVE_PROMISE_DELAY_FN) {
    index = ensureIrNativePromiseDelayProvider(ctx);
  } else if (ref.binding.kind === "runtime" && symbol === IR_ASYNC_PROMISE_ALL_NATIVE_FN) {
    index = ensureIrNativePromiseAllProvider(ctx);
  } else if (ref.binding.kind === "runtime" && symbol === IR_CONSOLE_SINK_APPEND_FN) {
    // (#4462) Host-free console sink. Never minted here: `ensureStandaloneStdoutSink`
    // owns it and runs in the pre-body window so the funcidx is final. Absence is
    // a claim/capability disagreement, which the `null` turns into the standard
    // "cannot materialize callable provider" invariant rather than a silent miss.
    index = ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN) ?? null;
  } else if (ref.binding.kind === "runtime" && symbol === "__hof_holey_array_filter") {
    index = ensureHoleyArrayFilter(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol.startsWith(VEC_ELEM_SET_PREFIX)) {
    const vecTypeIdx = Number(symbol.slice(VEC_ELEM_SET_PREFIX.length));
    index = Number.isInteger(vecTypeIdx) ? ensureVecElemSet(ctx, vecTypeIdx) : null;
  } else if (ref.binding.kind === "intrinsic" && symbol.startsWith(VEC_NEW_SIZED_PREFIX)) {
    const vecTypeIdx = Number(symbol.slice(VEC_NEW_SIZED_PREFIX.length));
    index = Number.isInteger(vecTypeIdx) ? ensureVecNewSized(ctx, vecTypeIdx) : null;
  } else if (ref.binding.kind === "intrinsic" && symbol === JSSTR_CHARCODEAT_FN) {
    // (#3526 F2-S7) The PLAN path keeps its materializer — `stringMethodPlan`
    // baked the lane into this symbol before the freeze, and re-deciding it here
    // would be from-ast-side vocabulary (#2955). What the slice adds is a
    // fail-closed VERIFY: the frozen row and the plan-time symbol are the same
    // `ctx.nativeStrings` fact inside `compile()`, so a disagreement can only
    // come from an adapter that passed a policy AND a demand, and that is an
    // invariant violation, never a lane fact to re-decide locally.
    const arm = preparedStringCharCodeAtProvider(prepared);
    if (!arm || arm.symbol !== symbol) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "plan-time charCodeAt symbol disagrees with the frozen string-char-code-at row",
      );
    }
    index = ensureHostCharCodeAtGuarded(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === JSSTR_SUBSTRING_FN) {
    index = ensureHostSubstringGuarded(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === NATIVE_CHARCODEAT_FN) {
    // (#3526 F2-S7) The native half of the same plan-path verify — see the host
    // arm above. Same materializer, same fail-closed check.
    const arm = preparedStringCharCodeAtProvider(prepared);
    if (!arm || arm.symbol !== symbol) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "plan-time charCodeAt symbol disagrees with the frozen string-char-code-at row",
      );
    }
    index = ensureNativeCharCodeAtHelper(ctx);
  } else if (
    ref.binding.kind === "intrinsic" &&
    (symbol === NATIVE_FLATTEN_FN || symbol === NATIVE_FLAT_CHARCODEAT_FN)
  ) {
    // (#3931) canonical char-read-loop hoist: the preheader flatten, and the
    // unguarded flat read the in-bounds proof licenses.
    // `ensureNativeStringHelpers` first for the same reason the charAt arm
    // does it — the struct types and `__str_flatten` must exist before either
    // of these can be minted.
    ensureNativeStringHelpers(ctx);
    index =
      symbol === NATIVE_FLATTEN_FN
        ? nativeStrHelperHandle(ctx, NATIVE_FLATTEN_FN)
        : ensureNativeFlatCharCodeAtHelper(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === JSSTR_CHARCODEAT_TRUSTED_FN) {
    index = ensureHostCharCodeAtTrusted(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_COMPARE_FN) {
    // (#3526 F2-S1) The arm no longer reads `ctx.nativeStrings`: the frozen
    // manifest's `stringCompare` policy already resolved which authority
    // answers, and this only materializes it through the SAME two routines as
    // before. Fail-closed: an owner whose policy cannot provide the seam is
    // partitioned out before freeze, so a missing row here is an invariant, not
    // a lane fact to re-decide locally.
    const arm = preparedStringCompareProvider(prepared);
    if (!arm) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "string relational compare has no frozen provider under the string-compare policy",
      );
    }
    if (arm.arm === "native") {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, arm.symbol);
    } else {
      // The host arm names the capability record's field — the `env` BASE
      // import the legacy collector already minted. Never `ensureLateImport`:
      // a late registration here would shift every defined funcidx.
      index = ctx.funcMap.get(arm.field);
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_EQUALS_FN) {
    // (#3526 F2-S3) Lifted out of the three-symbol concat/eq branch below and
    // put under manifest authority. The arm no longer reads `ctx.nativeStrings`:
    // the frozen `stringEq` policy already resolved which authority answers, and
    // this only materializes it through the SAME two routines as before. The
    // lift itself is byte-inert — the three symbols are disjoint, so `else if`
    // order between them cannot change which branch a symbol takes.
    const arm = preparedStringEqProvider(prepared);
    if (!arm) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "string equality has no frozen provider under the string-eq policy",
      );
    }
    if (arm.arm === "native") {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, arm.symbol);
    } else {
      // The host arm names the capability record's MODULE and field, and is
      // located by import-section POSITION — never `ctx.funcMap`, which keys
      // `wasm:js-string` builtins on the bare field and so is shadowable by a
      // same-named user function (#1072). Never `ensureLateImport` either: the
      // five-import block is minted by a base-phase caller long before Phase 3,
      // and a late registration here would shift every defined funcidx.
      index = exactCallableImportIndex(ctx, arm.module, arm.field);
    }
  } else if (
    ref.binding.kind === "intrinsic" &&
    (symbol === IR_STRING_CONCAT_FN || symbol === IR_STRING_CONCAT_OWNED_FN)
  ) {
    // (#3526 F2-S5) Under manifest authority, like the compare and the eq
    // before it. The arm no longer reads `ctx.nativeStrings`: the frozen
    // `stringConcat` policy already resolved which authority answers, and the
    // instruction's concat MODE — recovered here from the intrinsic SYMBOL,
    // which is all the resolve table receives — picks which helper on that
    // authority. The two routines below are the same two as before, so the
    // migration is byte-neutral.
    const arm = preparedStringConcatProvider(
      prepared,
      symbol === IR_STRING_CONCAT_OWNED_FN ? "owned-append" : "immutable",
    );
    if (!arm) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "string concatenation has no frozen provider under the string-concat policy",
      );
    }
    if (arm.arm === "native") {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, arm.symbol);
    } else {
      // The host arm names the capability record's MODULE and field and is
      // located by import-section POSITION — never `ctx.funcMap`, which keys
      // `wasm:js-string` builtins on the bare field and so is shadowable by a
      // same-named user function (#1072). Never `ensureLateImport` either: the
      // five-import block is minted by a base-phase caller long before Phase 3,
      // and a late registration here would shift every defined funcidx.
      index = exactCallableImportIndex(ctx, arm.module, arm.field);
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_REPEAT_COUNTED_NATIVE_FN) {
    index = ensureIrNativeCountedStringRepeatProvider(ctx);
    if (index !== undefined && index !== null && !hasExactIrNativeCountedStringRepeatProviderAbi(ctx, index)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared counted-native string.repeat provider has a malformed physical ABI",
      );
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_REPEAT_FN) {
    index = ctx.nativeStrings ? ensureIrNativeStringRepeatProvider(ctx) : ensureIrHostStringRepeatProvider(ctx);
    if (index !== undefined && index !== null && !hasExactIrStringRepeatProviderAbi(ctx, index)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared string.repeat provider has a malformed physical ABI",
      );
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_CHAR_AT_FN) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, "__str_charAt");
    } else {
      index = exactCallableImportIndex(ctx, "env", "string_charAt");
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_CHAR_CODE_AT_FN) {
    // (#3526 F2-S7) THE R6-shaped decision on this seam. The arm no longer reads
    // `ctx.nativeStrings`: the frozen `stringCharCodeAt` policy already resolved
    // which authority answers, and this only materializes it through the SAME
    // two routines as before. Fail-closed: an owner whose policy cannot provide
    // the seam is partitioned out before freeze, so a missing row here is an
    // invariant, not a lane fact to re-decide locally.
    //
    // Both routines return `number | null`, and a `null` keeps its existing
    // meaning exactly: it falls to the `unknown-function-ref` invariant below —
    // a hard compile error — and never registers a late import, which would
    // shift every defined funcidx. `funcMap.get(arm.symbol)` is never used
    // either: these are DEFINED helpers a same-named user export shadows
    // (#1072 / the #3520 pin).
    const arm = preparedStringCharCodeAtProvider(prepared);
    if (!arm) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "charCodeAt has no frozen provider under the string-char-code-at policy",
      );
    }
    index = arm.arm === "native" ? ensureNativeCharCodeAtHelper(ctx) : ensureHostCharCodeAtGuarded(ctx);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_STRING_ITERATOR_CHAR_AT_FN) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, "__str_charAt_cp");
    }
  } else if (ref.binding.kind === "intrinsic" && (symbol === "__str_indexOf" || symbol === "__str_includes")) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, symbol);
    }
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_NUMBER_TO_STRING_FN) {
    index = ensureIrNumberToStringProvider(ctx, fuseNativeNumberFormatCarriers);
  } else if (ref.binding.kind === "intrinsic" && symbol === IR_NUMBER_TO_FIXED_FN) {
    index = ensureIrNumberToFixedProvider(ctx, fuseNativeNumberFormatCarriers);
  } else if (ref.binding.kind === "intrinsic" && parseIrDateSnapshotGetter(symbol) !== undefined) {
    index = ensureDateCivilHelper(ctx);
  } else if (ref.binding.kind === "runtime" && symbol === "__str_replaceAll") {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      index = nativeStrHelperHandle(ctx, symbol);
    }
  } else if (ref.binding.kind === "runtime" && (symbol === "parseInt" || symbol === "parseFloat")) {
    // Exact parser boundaries use the source-qualified ambient builtin map;
    // a same-named source function in funcMap must never steal the call.
    index = ctx.ambientBuiltinFuncMap.get(symbol);
  } else {
    index = ctx.funcMap.get(symbol) ?? nativeStrHelperHandle(ctx, symbol);
  }
  if (index === null || index === undefined) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "resolve",
      `ir/integration: cannot materialize callable provider ${irCallableBindingKey(ref.binding)} / ${ref.name}`,
    );
  }
  return registry?.observe(ref, index) ?? index;
}

function exactCallableImportIndex(ctx: CodegenContext, module: string, field: string): number | undefined {
  let functionIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (imported.module === module && imported.name === field) return functionIndex;
    functionIndex++;
  }
  return undefined;
}

function emitResolvedStringConst(
  ctx: CodegenContext,
  resolver: Pick<IrLowerResolver, "resolveFunc" | "resolveGlobal">,
  value: string,
  alloc?: import("./nodes.js").AllocSiteId,
  storage?: IrGlobalRef,
  materializer?: IrFuncRef,
): readonly Instr[] {
  if (storage && materializer) {
    throw new Error("ir/integration: string literal cannot use storage and a materializer together");
  }
  if (storage) return [{ op: "global.get", index: resolver.resolveGlobal(storage) }];
  if (materializer) return [{ op: "call", funcIdx: resolver.resolveFunc(materializer) }];
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const encoding =
      ctx.utf8Storage && alloc !== undefined && ctx.allocRegistry
        ? ctx.allocRegistry.read<StringEncoding>(alloc, ALLOC_NAMESPACES.encoding)
        : undefined;
    return nativeStringLiteralInstrs(ctx, value, encoding);
  }
  const globalIdx = ctx.stringGlobalMap.get(value);
  if (globalIdx === undefined || globalIdx < 0) {
    throw new Error(`ir/integration: string literal "${value}" was not pre-registered`);
  }
  return [{ op: "global.get", index: globalIdx }];
}

function resolvePreparedImportCallable(
  ctx: CodegenContext,
  ref: IrFuncRef,
  importedCallableCatalog: ReadonlyMap<string, Import>,
  preparedScopeLookup: PreparedComponentScopeLookup | undefined,
): number {
  if (ref.binding.kind !== "import" || !ctx.programAbiSession) {
    throw new IrInvariantError("unknown-function-ref", "lower", `ir/integration: non-import callable ${ref.name}`);
  }
  const structuralReferenceKey = irCallableBindingKey(ref.binding);
  if (preparedScopeLookup) {
    const bindingIds = preparedScopeLookup.bindingIdsForStructuralReference(structuralReferenceKey);
    if (bindingIds.length !== 1) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "lower",
        `ir/integration: exact function import ${ref.binding.module}.${ref.binding.field} has ${bindingIds.length} prepared ABI bindings`,
      );
    }
    return preparedScopeLookup.resolveCurrentIndex(bindingIds[0]!, "function", structuralReferenceKey);
  }
  const exactImport = importedCallableCatalog.get(structuralReferenceKey);
  if (!exactImport || exactImport.desc.kind !== "func") {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `ir/integration: unknown exact function import ${ref.binding.module}.${ref.binding.field}`,
    );
  }
  let functionIndex = 0;
  let resolved = -1;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (imported === exactImport) {
      if (resolved >= 0) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "lower",
          `ir/integration: exact function import ${ref.binding.module}.${ref.binding.field} has duplicate allocator ownership`,
        );
      }
      resolved = functionIndex;
    }
    functionIndex++;
  }
  if (resolved >= 0) return resolved;
  throw new IrInvariantError(
    "unknown-function-ref",
    "lower",
    `ir/integration: exact function import ${ref.binding.module}.${ref.binding.field} lost its allocator object`,
  );
}

function makeResolver(
  ctx: CodegenContext,
  unionRegistry: UnionStructRegistry,
  stringBackend: StringBackendIndices,
  objResolver: DeferredObjectResolver,
  closureResolver: DeferredClosureResolver,
  refCellResolver: DeferredRefCellResolver,
  classResolver: DeferredClassResolver,
  unitCallableSlots: ReadonlyMap<IrUnitId, PreparedIrUnitCallableSlot>,
  importedCallableCatalog: ReadonlyMap<string, Import>,
  preparedRuntimeManifest?: PreparedIrRuntimeManifest,
  fuseNativeNumberFormatCarriers = false,
  fnctorParameterPreselection?: IrFnctorParameterPreselectionPlan,
  fnctorParameterPreselectionIsCurrent?: () => boolean,
  preparedScopeLookup?: PreparedComponentScopeLookup,
): IrLowerResolver {
  // (#2949 slice 3) One dynamic-lowering handle per resolver (undefined =
  // not yet built; null = mode has no dynamic op lowering).
  let dynamicLoweringMemo: IrDynamicLowering | null | undefined;
  const resolver: IrLowerResolver = {
    resolveFunc(ref: IrFuncRef): number {
      if (process.env.JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE === "function") {
        throw new IrInvariantError(
          "unknown-function-ref",
          "lower",
          `injected unknown function ref through resolver (${ref.name})`,
        );
      }
      if (ref.binding.kind === "unit") {
        return resolvePreparedUnitCallable(ctx, ref, unitCallableSlots, preparedScopeLookup);
      }
      if (
        ref.binding.kind === "support" &&
        (ctx.programAbiSession?.hasPlan(ref.binding.bindingId) ||
          preparedScopeLookup?.get(ref.binding.bindingId) !== undefined)
      ) {
        return resolvePreparedSupportCallable(ctx, ref, preparedScopeLookup);
      }
      if (ref.binding.kind === "import" && ctx.programAbiSession) {
        return resolvePreparedImportCallable(ctx, ref, importedCallableCatalog, preparedScopeLookup);
      }
      if (ref.binding.kind === "runtime" || ref.binding.kind === "intrinsic") {
        return resolveAndObserveCallableProvider(ctx, ref, preparedRuntimeManifest, fuseNativeNumberFormatCarriers);
      }
      const adapterName = ref.binding.kind === "import" ? ref.binding.field : ref.name;
      const idx = ctx.funcMap.get(adapterName);
      if (idx !== undefined) return idx;
      // Slice 6 part 4 (#1183): native-string helpers (`__str_charAt`,
      // `__str_concat`, `__str_equals`, `__str_flatten`, etc.) are
      // registered in `ctx.nativeStrHelpers`, not `ctx.funcMap`.
      // (#3909) Resolution order is stable handle → post-shift name scan →
      // whatever the map holds; the old order put the name scan first, which
      // downgraded an unshiftable stable handle to a live index that the
      // shifters stop tracking once the import count passes it.
      const helperIdx = nativeStrHelperHandle(ctx, adapterName);
      if (helperIdx !== undefined) return helperIdx;
      throw new IrInvariantError("unknown-function-ref", "lower", `ir/integration: unknown function ref "${ref.name}"`);
    },
    callResultAdapter(ref: IrFuncRef): "native-string-from-externref" | undefined {
      if (!fuseNativeNumberFormatCarriers || !ctx.nativeStrings) return undefined;
      if (ref.binding.kind !== "runtime" && ref.binding.kind !== "intrinsic") return undefined;
      const symbol = ref.binding.symbol;
      return symbol === IR_NUMBER_TO_STRING_NATIVE_FN ||
        symbol === IR_ASYNC_NUMBER_TO_STRING_FN ||
        symbol === IR_NUMBER_TO_STRING_FN ||
        symbol === IR_NUMBER_TO_FIXED_FN
        ? "native-string-from-externref"
        : undefined;
    },
    resolveGlobal(ref: IrGlobalRef): number {
      if (process.env.JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE === "global") {
        throw new IrInvariantError(
          "unknown-global-ref",
          "lower",
          `injected unknown global ref through resolver (${ref.name})`,
        );
      }
      if (!ctx.programAbiSession) {
        throw new IrInvariantError(
          "unknown-global-ref",
          "lower",
          `ir/integration: global ref "${ref.name}" has no ProgramAbiSession`,
        );
      }
      return preparedScopeLookup
        ? preparedScopeLookup.resolveCurrentIndex(ref.binding.bindingId, "global", irGlobalBindingKey(ref.binding))
        : ctx.programAbiSession.resolveCurrentIndex(ref.binding.bindingId, "global", irGlobalBindingKey(ref.binding));
    },
    resolveType(ref: IrTypeRef): number {
      if (process.env.JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE === "type") {
        throw new IrInvariantError(
          "unknown-type-ref",
          "lower",
          `injected unknown type ref through resolver (${ref.name})`,
        );
      }
      if (!ctx.programAbiSession) {
        throw new IrInvariantError(
          "unknown-type-ref",
          "lower",
          `ir/integration: type ref "${ref.name}" has no ProgramAbiSession`,
        );
      }
      return preparedScopeLookup
        ? preparedScopeLookup.resolveCurrentIndex(ref.binding.bindingId, "type", irTypeBindingKey(ref.binding))
        : ctx.programAbiSession.resolveCurrentIndex(ref.binding.bindingId, "type", irTypeBindingKey(ref.binding));
    },
    internFuncType(type: FuncTypeDef): number {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
    resolveUnion(members: readonly ValType[]): IrUnionLowering | null {
      return unionRegistry.resolve(members);
    },
    resolveObject(shape: IrObjectShape): IrObjectStructLowering | null {
      return objResolver.resolve(shape);
    },
    // -------------------------------------------------------------------
    // Closure / ref-cell dispatch (#1169c).
    // -------------------------------------------------------------------
    resolveClosure(sig: IrClosureSignature): IrClosureLowering | null {
      return closureResolver.resolveBase(sig);
    },
    resolveClosureRoot(): number | null {
      return getFuncRefWrapperRootTypeIdx(ctx) ?? null;
    },
    resolveClosureSubtype: (...args) => closureResolver.resolveSubtype(...args),
    resolveRefCell(inner: ValType): IrRefCellLowering | null {
      return refCellResolver.resolve(inner);
    },
    // -------------------------------------------------------------------
    // Class dispatch (#1169d).
    // -------------------------------------------------------------------
    resolveClass(shape: IrClassShape): IrClassLowering | null {
      return classResolver.resolve(shape);
    },
    // #3521 — exact source/unit fnctor sidecar. A missing observation is a
    // deliberate null so the lowerer cannot fall back to constructorName or
    // the legacy name-keyed maps.
    resolveFnctor(shape: IrFnctorShape): IrFnctorLowering | null {
      return ctx.programAbiFnctors?.resolve(shape) ?? null;
    },
    resolveParamPhysicalType(unitId: IrUnitId, parameterIndex: number, logicalType: IrType) {
      const consumer = fnctorParameterPreselection?.valueConsumer;
      if (!consumer || consumer.unitId !== unitId || parameterIndex !== consumer.parameterIndex) return undefined;
      if (logicalType.kind !== "string") {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "lower",
          `ir/integration: exact fnctor parameter ${unitId}[${parameterIndex}] lost its semantic string type`,
        );
      }
      if (fnctorParameterPreselectionIsCurrent && !fnctorParameterPreselectionIsCurrent()) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "lower",
          `ir/integration: exact fnctor parameter ${unitId}[${parameterIndex}] became stale during lowering`,
        );
      }
      return consumer.parameterPhysicalType.kind === "ref_null"
        ? { type: consumer.parameterPhysicalType, refineNonNull: true as const }
        : { type: consumer.parameterPhysicalType };
    },
    // -------------------------------------------------------------------
    // Vec dispatch (slice 6 part 2 — #1181).
    //
    // Walks the legacy `ctx.mod.types` registry to recover the layout the
    // for-of vec fast path needs from a `(ref $vec_*)` ValType. The legacy
    // `getOrRegisterVecType` always shapes a vec as
    //   { length: i32, data: (ref $arr_<elem>) }
    // so we just verify that shape and read the element ValType off the
    // backing array type. Returns null when the input isn't a recognisable
    // vec — the caller treats that as a selector bug (the for-of selector
    // should have rejected the function).
    // -------------------------------------------------------------------
    resolveVec(valType: ValType): import("./lower.js").IrVecLowering | null {
      return resolvePhysicalVecImpl(ctx, valType);
    },
    // #1804 — register-or-recover the vec struct for an element ValType, for
    // `vec.new_fixed` construction. See `resolveVecForElementImpl`.
    resolveVecForElement(elementValType: ValType): import("./lower.js").IrVecLowering | null {
      return resolveVecForElementImpl(ctx, elementValType);
    },
    // -------------------------------------------------------------------
    // String backend dispatch (#1169a).
    // -------------------------------------------------------------------
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    // -------------------------------------------------------------------
    // Dynamic (boxed-any) carrier dispatch (#2949 slice 1).
    //
    // MUST match legacy `resolveWasmType`'s any/unknown arm EXACTLY
    // (codegen/index.ts — "any/unknown → ref_null $AnyValue in fast mode,
    // externref otherwise") so IR-claimed and legacy-compiled functions
    // agree on the `any` ABI. `ensureAnyValueType` is idempotent and only
    // APPENDS a type (never shifts existing indices), the same lazy
    // registration legacy performs at its own first `any` use.
    // -------------------------------------------------------------------
    resolveDynamic(): ValType {
      return resolveIrDynamicCarrierType(ctx);
    },
    // (#2949 slice 3) Op-emission handle for dynamic box/unbox/tag.test —
    // memoized so all arms of one lowering run share a single handle. The
    // factory's mode split mirrors resolveDynamic above by construction
    // (both key on ctx.fast). Helpers/imports the handle resolves by name
    // were registered up front by preregisterDynamicSupport.
    resolveDynamicLowering(): IrDynamicLowering | null {
      if (dynamicLoweringMemo === undefined) {
        dynamicLoweringMemo = makeDynamicLowering(ctx);
      }
      return dynamicLoweringMemo;
    },
    // Slice 6 part 4 refactor (#1185): expose the nativeStrings mode
    // discriminator so the from-ast for-of arms can dispatch without
    // needing the per-feature shortcut threaded through LowerCtx.
    nativeStrings(): boolean {
      return ctx.nativeStrings;
    },
    emitStringConst(
      value: string,
      alloc?: import("./nodes.js").AllocSiteId,
      storage?: IrGlobalRef,
      materializer?: IrFuncRef,
    ): readonly Instr[] {
      return emitResolvedStringConst(ctx, resolver, value, alloc, storage, materializer);
    },
    emitStringConcat(_alloc, _mode, provider): readonly Instr[] {
      if (provider) {
        return [{ op: "call", funcIdx: resolver.resolveFunc(provider) }];
      }
      // (#3526 F2-S5) The no-provider fallback is RETIRED. It was the adapter's
      // own `ctx.nativeStrings` read — a second, independent copy of the lane
      // decision the frozen manifest now owns, including its own private
      // mode-to-helper mapping — and it was dead: `attachIrStringSupport` binds
      // a callable provider to every `string.concat` in every healthy owner. An
      // owner that reaches lowering with no attachment must demote ALONE rather
      // than silently mint a body from a locally decided lane. Measured before
      // removal: zero reaches across the 65-cell byte matrix (which stayed
      // byte-identical WITH a temporary throw in its place) and 352 passing
      // tests in 22 string suites. The `_mode` parameter stays because the
      // `emitStringConcat` contract is shared with the linear backend, which
      // does dispatch on it.
      throw new Error("ir/integration: string.concat has no prepared runtime provider");
    },
    emitStringRepeat(_alloc, _inputEncoding, provider, countedStringAppendTripCount): readonly Instr[] {
      if (!provider) throw new Error("ir/integration: string.repeat has no prepared provider");
      const call = { op: "call" as const, funcIdx: resolver.resolveFunc(provider) };
      if (provider.binding.kind === "intrinsic" && provider.binding.symbol === IR_STRING_REPEAT_COUNTED_NATIVE_FN) {
        if (!ctx.nativeStrings || countedStringAppendTripCount === undefined) {
          throw new Error("ir/integration: counted-native string.repeat has no authenticated native proof");
        }
        return [{ op: "i32.trunc_f64_s" }, call];
      }
      return ctx.nativeStrings ? [call, { op: "ref.as_non_null" }] : [call];
    },
    emitStringEquals(provider): readonly Instr[] {
      // (#3526 F2-S3) Fail closed rather than re-deciding the lane here. The
      // retired `ctx.nativeStrings` fallback was the seam's SECOND un-governed
      // mode read, and it was dead: `attachIrStringSupport` attaches this
      // provider unconditionally for every `string.eq`
      // (`string-support.ts` — the kind is in the provider-attaching branch and
      // `irStringCallableProviderRef` never returns `undefined` for it), and
      // `prepareStrings` runs that pass over every healthy owner. An owner that
      // reaches lowering with no attachment must demote ALONE, not silently mint
      // a body from a locally decided symbol. Measured before removal: zero
      // reaches across the 55-cell byte matrix and 337 tests in 22 string
      // suites, with a temporary throw in its place.
      if (!provider) {
        throw new Error("ir/integration: string.eq has no prepared runtime provider");
      }
      return [{ op: "call", funcIdx: resolver.resolveFunc(provider) }];
    },
    emitStringLen(_inputEncoding, provider): readonly Instr[] {
      if (provider?.kind === "callable") {
        return [{ op: "call", funcIdx: resolver.resolveFunc(provider.target) }];
      }
      if (provider?.kind === "struct-field") {
        return [
          {
            op: "struct.get",
            typeIdx: resolver.resolveType(provider.ownerType),
            fieldIdx: provider.fieldIndex,
          },
        ];
      }
      // (#3526 F2-S4) The no-provider fallback is RETIRED. It was the adapter's
      // own `ctx.nativeStrings` read — a second, independent copy of the lane
      // decision the frozen manifest now owns — and it was dead:
      // `prepareStringLength` attaches this provider to every `string.len` in
      // every healthy owner from the frozen row. An owner that reaches lowering
      // with no attachment must demote ALONE rather than silently mint a body
      // from a locally decided lane. Measured before removal: zero reaches
      // across the 60-cell byte matrix (byte-identical WITH a temporary throw
      // in its place) and 335 passing tests in 21 string suites.
      throw new Error("ir/integration: string.len has no prepared runtime provider");
    },
    emitStringCharAt(_alloc, _inputEncoding, provider): readonly Instr[] {
      if (provider) {
        const call = { op: "call" as const, funcIdx: resolver.resolveFunc(provider) };
        return ctx.nativeStrings ? [call] : [{ op: "f64.convert_i32_s" }, call];
      }
      if (ctx.nativeStrings) {
        // (#3909) stable handle first — see `nativeStrHelperHandle`.
        const h = nativeStrHelperHandle(ctx, "__str_charAt");
        if (h === undefined) throw new Error("ir/integration: __str_charAt helper not registered");
        return [{ op: "call", funcIdx: h }];
      }
      const idx = ctx.funcMap.get("string_charAt");
      if (idx === undefined) throw new Error("ir/integration: string_charAt import not registered");
      return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: idx }];
    },
    emitStringCharCodeAt(_inputEncoding, provider): readonly Instr[] {
      if (provider) {
        return [{ op: "call", funcIdx: resolver.resolveFunc(provider) }];
      }
      // (#3526 F2-S7) The seam's second un-governed lane read, RETIRED on a
      // measurement: `string-support.ts` attaches the semantic provider to every
      // `string.char_code_at` unconditionally, so this branch was reached zero
      // times across the 65-cell byte matrix (which stayed byte-identical with a
      // throw in its place) and across 39 suites / 604 passing tests. An
      // unattached instruction is now a hard refusal rather than a private
      // re-decision of the authority the manifest already resolved.
      throw new Error("ir/integration: string.char_code_at has no prepared runtime provider");
    },
    // -------------------------------------------------------------------
    // Exception handling dispatch (slice 9 — #1169h).
    //
    // Resolves the already-prepared shared `__exn` tag. The tag has signature
    // `(externref)` and is shared
    // between IR-compiled and legacy-compiled functions so cross-path
    // throws / catches interoperate. The integration loop pre-registers
    // the tag (see `preregisterExceptionSupport`) for any IR function
    // that emits `throw` / `try`; lowering must never allocate it lazily after
    // component dependency evidence has sealed.
    // -------------------------------------------------------------------
    ensureExnTag(): number {
      if (ctx.exnTagIdx < 0) {
        throw new Error("ir/integration: exception tag was not prepared from final IR evidence");
      }
      return ctx.exnTagIdx;
    },
    standardizedExceptions(): boolean {
      return ctx.standalone || ctx.wasi;
    },
    // -------------------------------------------------------------------
    // Async / Promise dispatch (#1373b Slice 1).
    //
    // Lazily registers (or retrieves) the standalone `$Promise` WasmGC
    // struct type. The struct layout matches the canonical registration
    // in `src/codegen/async-scheduler.ts`:
    //   { state: i32, value: externref, callbacks: externref, $bag: externref }
    //
    // Lower's `async.return` / `async.throw` / `await` arms call this
    // to construct or inspect Promise values without going through the
    // JS-host `Promise.resolve` / `Promise.reject` imports.
    // -------------------------------------------------------------------
    resolvePromiseType(): number {
      return getOrRegisterPromiseType(ctx);
    },
    // (#1373b C-1) Lane discriminator for the `await` lowering: native
    // `$Promise` carrier (wasi) → one-level unwrap; JS-host → identity.
    nativePromiseCarrierActive(): boolean {
      return isStandalonePromiseActive(ctx);
    },
  };
  return resolver;
}

// ---------------------------------------------------------------------------
// String pre-registration (#1169a)
// ---------------------------------------------------------------------------

interface BuiltFnRef {
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly fn: IrFunction;
  readonly ownerName: string;
  readonly name: string;
}

interface IrOwnerPreparationFailure {
  readonly owner: IrLegacyUnitProjectionEntry;
  readonly outcome: IrPreparationFailure;
}

function recordOwnerPreparationFailures(
  failures: IrIntegrationFailureLog,
  failedOwners: Set<IrUnitId>,
  records: ReadonlyMap<IrUnitId, IrOwnerPreparationFailure>,
): void {
  for (const { owner, outcome } of records.values()) {
    if (failedOwners.has(owner.unitId)) continue;
    failures.record(owner, integrationFailure(owner.legacyName, outcome));
    failedOwners.add(owner.unitId);
  }
}

function callableProviderRef(instr: IrInstr): IrFuncRef | undefined {
  switch (instr.kind) {
    case "call":
      return instr.target;
    case "intrinsic":
      return instr.provider?.kind === "callable" ? instr.provider.target : undefined;
    case "closure.new":
      return instr.liftedFunc;
    case "class.call":
    case "class.super_init":
    case "class.super_call":
    case "class.static_call":
    case "class.new":
      return instr.target;
    case "string.const":
      return instr.materializer;
    case "string.concat":
    case "string.repeat":
    case "string.eq":
    case "string.char_at":
    case "string.char_code_at":
    case "forof.string":
      return instr.provider;
    default:
      return undefined;
  }
}

/** Resolve every final runtime/intrinsic ref before component discovery seals. */
function preregisterCallableProviders(
  ctx: CodegenContext,
  fns: readonly BuiltFnRef[],
  preparedRuntimeManifest?: PreparedIrRuntimeManifest,
  fuseNativeNumberFormatCarriers = false,
): ReadonlyMap<IrUnitId, IrOwnerPreparationFailure> {
  const failures = new Map<IrUnitId, IrOwnerPreparationFailure>();
  const owners = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
  for (const entry of fns) {
    const existing = owners.get(entry.terminalOwnerUnitId);
    if (existing && existing.legacyName !== entry.ownerName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `terminal owner ${entry.terminalOwnerUnitId} has conflicting labels ${existing.legacyName} and ${entry.ownerName}`,
      );
    }
    owners.set(entry.terminalOwnerUnitId, {
      unitId: entry.terminalOwnerUnitId,
      legacyName: entry.ownerName,
    });
  }
  for (const entry of fns) {
    const owner = owners.get(entry.terminalOwnerUnitId)!;
    const instructionBuffers = [
      ...entry.fn.blocks.map((block) => block.instrs),
      ...(entry.fn.asyncRuntime?.states.map((state) => state.body) ??
        entry.fn.asyncPlan?.states.map((state) => state.body) ??
        []),
    ];
    for (const instrs of instructionBuffers) {
      for (const root of instrs) {
        forEachInstrDeep(root, (instr) => {
          const ref = callableProviderRef(instr);
          if (!ref || (ref.binding.kind !== "runtime" && ref.binding.kind !== "intrinsic")) return;
          try {
            resolveAndObserveCallableProvider(ctx, ref, preparedRuntimeManifest, fuseNativeNumberFormatCarriers);
          } catch (error) {
            if (!failures.has(owner.unitId)) {
              failures.set(owner.unitId, { owner, outcome: classifyIrFailure(error, "resolve") });
            }
          }
        });
      }
    }
  }
  // Seal deferred import indices before prepared component bodies bake them.
  flushLateImportShifts(ctx, null);
  return failures;
}

interface HostDateImportSpec {
  readonly name: string;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

const HOST_DATE_IMPORTS = new Map<string, HostDateImportSpec>([
  ["__date_now", { name: "__date_now", params: [], results: [{ kind: "f64" }] }],
]);

function exactHostDateImport(ctx: CodegenContext, spec: HostDateImportSpec): boolean {
  const idx = ctx.funcMap.get(spec.name);
  if (idx === undefined || idx < 0 || idx >= ctx.numImportFuncs) return false;
  let functionIndex = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (functionIndex++ !== idx) continue;
    if (imported.module !== "env" || imported.name !== spec.name) return false;
    const type = ctx.mod.types[imported.desc.typeIdx];
    if (
      type?.kind !== "func" ||
      type.params.length !== spec.params.length ||
      type.results.length !== spec.results.length
    ) {
      return false;
    }
    return (
      type.params.every((param, i) => param.kind === spec.params[i]!.kind) &&
      type.results.every((result, i) => result.kind === spec.results[i]!.kind)
    );
  }
  return false;
}

/** Register only the synthetic host-Date symbols present in built IR. */
function preregisterHostDateSnapshotSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  const needed = new Set<string>();
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (
            nested.kind === "call" &&
            nested.target.binding.kind === "import" &&
            nested.target.binding.module === "env" &&
            nested.target.binding.field === "__date_now"
          ) {
            needed.add("__date_now");
          }
        });
      }
    }
  }
  if (needed.size === 0) return;
  const exactStandaloneClock =
    ctx.standalone &&
    !ctx.wasi &&
    ctx.requiresStandaloneClockCapability === true &&
    ctx.targetProfile.environment === "none";
  if ((ctx.standalone || ctx.wasi || ctx.strictNoHostImports) && !exactStandaloneClock) {
    throw new Error("ir/integration: synthetic Date snapshots require the JS host");
  }

  let added = false;
  for (const name of needed) {
    const spec = HOST_DATE_IMPORTS.get(name);
    if (!spec) throw new Error(`ir/integration: unsupported synthetic Date import ${name}`);
    if (!ctx.funcMap.has(name)) added = true;
    if (exactStandaloneClock && spec.name === "__date_now") {
      ensureStandaloneClockCapabilityImport(ctx);
    } else {
      ensureLateImport(ctx, spec.name, [...spec.params], [...spec.results]);
    }
  }
  if (added) flushLateImportShifts(ctx, null);

  // `ensureLateImport` intentionally treats an occupied funcMap name as a
  // lookup. Refuse user-defined or wrong-signature occupants rather than
  // resolving them as the ambient Date ABI.
  for (const name of needed) {
    const spec = HOST_DATE_IMPORTS.get(name)!;
    if (
      !exactHostDateImport(ctx, spec) ||
      (exactStandaloneClock && spec.name === "__date_now" && standaloneClockCapabilityImport(ctx) === undefined)
    ) {
      throw new Error(`ir/integration: ${name} is not the exact env host-Date import`);
    }
  }
}

/**
 * Walk every IR function the lowerer is about to emit and pre-register the
 * string-backend support it will need. This must run BEFORE Phase 3 starts
 * because both `addStringImports` and `addStringConstantGlobal` re-shift
 * function/global indices in already-compiled bodies; calling them
 * mid-emission risks invalidating the lowerer's local op buffer.
 *
 * Idempotent — repeat calls are no-ops, and the helpers themselves are
 * idempotent on `(ctx.hasStringImports, ctx.stringGlobalMap)`.
 */
function prepareStrings(ctx: CodegenContext, fns: BuiltFn[]): BuiltFn[] {
  // Find all distinct string literals + whether any string op is used at all.
  // Slice 10 (#1169i): the `extern.regex` instr lowers to two `string.const`
  // ops (pattern + flags). We collect them here too so the host-strings
  // backend pre-registers their `string_constants.<value>` globals before
  // Phase 3 emission. Walk every nested instruction buffer through the
  // canonical IR visitor: loop bodies, condition arms, try regions, and
  // future structured instructions can all contain otherwise-hidden strings.
  const literals = new Set<string>();
  let usesStringOp = false;
  let usesStringLen = false;
  let usesStringCharAt = false;
  let usesGenericStringRepeat = false;
  let usesNativeCountedStringRepeat = false;
  const visit = (instr: IrInstr): void => {
    if (instrUsesStrings(instr)) usesStringOp = true;
    if (instr.kind === "string.const") literals.add(instr.value);
    if (instr.kind === "string.len") usesStringLen = true;
    if (instr.kind === "string.char_at") usesStringCharAt = true;
    if (instr.kind === "string.repeat") {
      if (ctx.nativeStrings && instr.countedStringAppendTripCount !== undefined) {
        usesNativeCountedStringRepeat = true;
      } else {
        usesGenericStringRepeat = true;
      }
    }
    // (#3156) The host guarded-charCodeAt helper wraps the `wasm:js-string`
    // charCodeAt/length builtins — its materialization (resolveFunc) reads
    // `ctx.jsStringImports`, so `addStringImports` must have run BEFORE
    // Phase-3 emission. A claimed function can carry this call with NO other
    // string op (e.g. `f(s: string) { return s.charCodeAt(0); }` — receiver
    // is a param, no literals), so detect the call target explicitly.
    if (
      instr.kind === "call" &&
      instr.target.binding.kind === "intrinsic" &&
      (instr.target.binding.symbol === JSSTR_CHARCODEAT_FN ||
        // (#3931) …and its unguarded twin, for the same reason: a proven
        // char-read loop can be the ONLY string op in a claimed function, and
        // its helper reads `ctx.jsStringImports` at materialization time.
        instr.target.binding.symbol === JSSTR_CHARCODEAT_TRUSTED_FN)
    ) {
      usesStringOp = true;
    }
    // (#3167) A body may carry a string relational (`a < b` on string params)
    // with NO other string op — no literal, concat, or eq. Detect the compare
    // call so host-mode pre-registration (`addStringImports` + any literal
    // globals) and native-mode helper availability are guaranteed before
    // Phase-3 emission. (`resolveFunc` also ensures the native `__str_compare`
    // on demand, but flagging here keeps the host string-import path uniform.)
    if (
      instr.kind === "call" &&
      instr.target.binding.kind === "intrinsic" &&
      instr.target.binding.symbol === IR_STRING_COMPARE_FN
    ) {
      usesStringOp = true;
    }
    if (instr.kind === "extern.regex") {
      // RegExp literal lowers via emitStringConst(pattern) + emitStringConst(flags).
      usesStringOp = true;
      literals.add(instr.pattern);
      literals.add(instr.flags);
    }
  };
  for (const entry of fns) {
    const instructionBuffers = [
      ...entry.fn.blocks.map((block) => block.instrs),
      ...(entry.fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of instructionBuffers) {
      for (const instr of buffer) forEachInstrDeep(instr, visit);
    }
  }
  if (usesStringOp && !ctx.nativeStrings) {
    // Host-string backend: ensure all five `wasm:js-string` imports exist.
    addStringImports(ctx);
    // Pre-register every string literal as a global import. The helper is
    // idempotent on `value`, so repeat calls (e.g. literals also collected
    // by the legacy path) are no-ops.
    for (const value of literals) {
      addStringConstantGlobal(ctx, value);
    }
    if (usesStringCharAt && exactCallableImportIndex(ctx, "env", "string_charAt") === undefined) {
      ensureLateImport(ctx, "string_charAt", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, null);
      if (exactCallableImportIndex(ctx, "env", "string_charAt") === undefined) {
        throw new Error("ir/integration: prepared string.char_at has no exact env.string_charAt import");
      }
    }
    if (usesGenericStringRepeat) {
      ensureIrHostStringRepeatProvider(ctx);
    }
  } else if (usesGenericStringRepeat) {
    const index = ensureIrNativeStringRepeatProvider(ctx);
    if (!hasExactIrStringRepeatProviderAbi(ctx, index)) {
      throw new Error("ir/integration: prepared native string.repeat provider has a malformed ABI");
    }
  }
  if (usesNativeCountedStringRepeat) {
    const index = ensureIrNativeCountedStringRepeatProvider(ctx);
    if (!hasExactIrNativeCountedStringRepeatProviderAbi(ctx, index)) {
      throw new Error("ir/integration: prepared counted-native string.repeat provider has a malformed ABI");
    }
  }
  // Native strings: nothing to pre-register here. The native-string struct
  // types and helpers (`__str_concat`, `__str_equals`, `__str_flatten`) are
  // emitted up front by the legacy codegen whenever any string literal /
  // operation appears in source. The IR selector accepts `string` only when
  // a string operation appears in source, so the helpers are guaranteed to
  // exist by the time Phase 3 runs. (If they don't, the resolver throws
  // with a clear preparation invariant; an IR-owned body is never retried.)
  const registry = ctx.programAbiTypes;
  if (!registry) return fns;
  const carrierRef = registry.stringCarrierRef();
  // (#3526 F2-S4) The length provider is NOT decided here any more. This pass
  // still pre-registers the host `wasm:js-string` block that the host arm binds
  // to (the `usesStringLen` scan above feeds `instrUsesStrings`), but WHICH
  // authority answers `.length` is the frozen manifest's call, and the
  // attachment moved with it — see `prepareStringLength`, which runs inside
  // `prepareBuiltFnRuntimeManifest`.

  const nativeMaterializations = new Map<IrInstrStringConst, NativeStringLiteralMaterialization>();
  const nativeMaterializationFor = (instr: IrInstrStringConst): NativeStringLiteralMaterialization | undefined => {
    if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;
    const existing = nativeMaterializations.get(instr);
    if (existing) return existing;
    const encoding =
      ctx.utf8Storage && instr.alloc !== undefined && ctx.allocRegistry
        ? ctx.allocRegistry.read<StringEncoding>(instr.alloc, ALLOC_NAMESPACES.encoding)
        : undefined;
    const materialization = nativeStringLiteralMaterialization(ctx, instr.value, encoding);
    nativeMaterializations.set(instr, materialization);
    return materialization;
  };

  const storageForConst = (instr: IrInstrStringConst): IrGlobalRef | undefined => {
    if (!ctx.nativeStrings) return programAbiStringConstantRef(ctx, instr.value);
    if (!ctx.programAbiGlobals || ctx.nativeStrTypeIdx < 0) return undefined;
    const materialization = nativeMaterializationFor(instr);
    if (!materialization || materialization.kind !== "global") return undefined;
    const global = ctx.mod.globals[materialization.globalIdx - ctx.numImportGlobals];
    if (!global) {
      throw new Error(`ir/integration: native string literal ${JSON.stringify(instr.value)} lost its interned global`);
    }
    return ctx.programAbiGlobals.prepareNativeStringLiteral(global);
  };

  const materializerRefs = new Map<number, IrFuncRef>();
  const materializerForConst = (instr: IrInstrStringConst): IrFuncRef | undefined => {
    const materialization = nativeMaterializationFor(instr);
    const providerRegistry = ctx.programAbiCallableProviders;
    if (!materialization || materialization.kind !== "callable" || !providerRegistry) return undefined;
    const existing = materializerRefs.get(materialization.funcIdx);
    if (existing) return existing;
    const provider = irIntrinsicFuncRef(`${IR_STRING_LITERAL_MATERIALIZE_FN}:${materializerRefs.size}`);
    providerRegistry.observe(provider, materialization.funcIdx);
    materializerRefs.set(materialization.funcIdx, provider);
    return provider;
  };

  let usesString = false;
  const prepared = fns.map((entry) => {
    const attachment = attachIrStringCarrier(entry.fn, carrierRef);
    usesString ||= attachment.usesString;
    const fn = attachIrStringSupport(attachment.function, {
      storageForConst,
      materializerForConst,
      providerForLength: () => undefined,
      providerForRepeat: (instr) =>
        irIntrinsicFuncRef(
          ctx.nativeStrings && instr.countedStringAppendTripCount !== undefined
            ? IR_STRING_REPEAT_COUNTED_NATIVE_FN
            : IR_STRING_REPEAT_FN,
        ),
    });
    return fn === entry.fn ? entry : { ...entry, fn };
  });
  if (usesString) registry.prepareStringCarrier();
  return prepared;
}

function prepareVectors(ctx: CodegenContext, fns: BuiltFn[]): BuiltFn[] {
  return prepareIrVectorSupport({
    ctx,
    entries: fns,
    resolveVecForElement: (element) => resolveVecForElementImpl(ctx, element),
    resolvePhysicalVec: (value) => resolvePhysicalVecImpl(ctx, value),
    resolveString: () =>
      ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 ? { kind: "ref", typeIdx: ctx.anyStrTypeIdx } : { kind: "externref" },
    typeKey: irTypeKey,
  });
}

function instrUsesStrings(instr: IrInstr): boolean {
  return (
    instr.kind === "string.const" ||
    instr.kind === "string.concat" ||
    instr.kind === "string.repeat" ||
    instr.kind === "string.eq" ||
    instr.kind === "string.len" ||
    instr.kind === "string.char_at" ||
    instr.kind === "string.char_code_at" ||
    instr.kind === "forof.string"
  );
}

// ---------------------------------------------------------------------------
// Iterator pre-registration (#1182)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 3 (#1182): pre-register the iterator host imports if any
 * IR function emits an `iter.*` or `forof.iter` instr. Same pattern and
 * rationale as `prepareStrings`: late import registration
 * shifts function indices, and we want the shift to be a no-op on the
 * IR path's `IrFuncRef` resolution.
 *
 * `addIteratorImports` is idempotent on `ctx.funcMap.has("__iterator")`,
 * so it's safe to call repeatedly.
 */
function preregisterIteratorSupport(
  ctx: CodegenContext,
  fns: readonly BuiltFnRef[],
): ReadonlyMap<IrUnitId, IrOwnerPreparationFailure> {
  const usesIter = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "iter.new":
      case "iter.next":
      case "iter.done":
      case "iter.value":
      case "iter.return":
        return true;
      case "forof.iter": {
        // forof.iter is itself an iter user, but ALSO walk the body in
        // case the IR ever materialises iter.* directly inside.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return true;
      }
      case "forof.vec": {
        // A vec for-of body can syntactically contain nested iter ops.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  };
  const users: BuiltFnRef[] = [];
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesIter(instr)) {
          users.push(entry);
          break;
        }
      }
    }
  }
  if (users.length === 0) return new Map();
  const failures = new Map<IrUnitId, IrOwnerPreparationFailure>();
  const owners = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
  for (const entry of users) {
    const existing = owners.get(entry.terminalOwnerUnitId);
    if (existing && existing.legacyName !== entry.ownerName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `terminal owner ${entry.terminalOwnerUnitId} has conflicting labels ${existing.legacyName} and ${entry.ownerName}`,
      );
    }
    owners.set(entry.terminalOwnerUnitId, {
      unitId: entry.terminalOwnerUnitId,
      legacyName: entry.ownerName,
    });
  }
  if (ctx.standalone || ctx.wasi || ctx.targetProfile.semanticProviders === "native-first") {
    for (const owner of owners.values()) {
      failures.set(owner.unitId, {
        owner,
        outcome: {
          kind: "unsupported",
          code: "late-preparation-unsupported",
          stage: "resolve",
          detail:
            "standalone/WASI generic iteration requires the JS-host iterator protocol; a pure-Wasm Iterator Record path is not available",
        },
      });
    }
    return failures;
  }
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_ITERATOR_REGISTRATION_THROW === "1") {
      throw new Error("injected iterator registration failure");
    }
    addIteratorImports(ctx);
  } catch (error) {
    const failure = classifyIrFailure(error, "resolve");
    for (const owner of owners.values()) {
      failures.set(owner.unitId, { owner, outcome: failure });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Native-string helper pre-registration (#1183)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 4 (#1183): pre-register native-string helpers
 * (`__str_charAt`, `__str_concat`, `__str_equals`, `__str_flatten`, …)
 * if any IR function emits a `forof.string` instr. Same rationale as
 * `preregisterStringSupport` and `preregisterIteratorSupport` —
 * idempotent helper, called eagerly so Phase 3's funcref resolution
 * sees stable indices.
 *
 * `forof.string` is only produced by from-ast in native-strings mode,
 * so the helper call here is a no-op in host-strings mode.
 */
function preregisterNativeStringHelpers(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  if (!ctx.nativeStrings) return;
  const usesForOfString = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "forof.string":
        return true;
      case "call":
        return instr.target.binding.kind === "runtime" && instr.target.binding.symbol === "__str_replaceAll";
      case "forof.vec":
      case "forof.iter":
        for (const sub of instr.body) {
          if (usesForOfString(sub)) return true;
        }
        return false;
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesForOfString(instr)) {
          ensureNativeStringHelpers(ctx);
          return;
        }
      }
    }
  }
}

/**
 * #2952 slice 5 — register the mode-specific dynamic for-in runtime before
 * Phase 3 resolves symbolic calls. Host imports can shift defined function
 * indices, while the standalone object runtime appends a family of defined
 * helpers; both operations therefore belong at this preparation boundary.
 */
function preregisterForInSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  let used = false;
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          if (
            instr.kind === "call" &&
            instr.target.binding.kind === "runtime" &&
            (instr.target.binding.symbol === "__for_in_keys" || instr.target.binding.symbol === "__object_keys_forin")
          ) {
            used = true;
          }
        });
      }
    }
    if (used) break;
  }
  if (!used) return;
  if (ctx.standalone || ctx.wasi) {
    ensureObjectRuntime(ctx);
  } else {
    addForInImports(ctx);
  }
}

/**
 * (#5164 S3) Register the `in` operator's HasProperty probe before Phase 3.
 *
 * The `in` slice emits a direct symbolic `call` to `__extern_has`, which on
 * main is registered only as a side effect of LEGACY compiling the same
 * function (`binary-ops-in.ts`'s own `ensureLateImport`). IR-first skips that
 * body, and then the resolver's `funcMap` lookup finds nothing — an
 * `unknown-function-ref` invariant, i.e. a HARD compile error rather than a
 * demote. Same class of dual-compile dependency #3143 fixed for
 * `__extern_is_undefined`, so it gets the same treatment.
 *
 * Deliberately separate from `preregisterForInSupport`: for-in's host-mode
 * liveness helper is `__for_in_has`, a DIFFERENT import, so neither
 * registration can stand in for the other when a function uses both.
 */
function preregisterInOperatorSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  let used = false;
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          if (
            instr.kind === "call" &&
            instr.target.binding.kind === "runtime" &&
            instr.target.binding.symbol === "__extern_has"
          ) {
            used = true;
          }
        });
      }
    }
    if (used) break;
  }
  if (!used) return;
  if (ctx.standalone || ctx.wasi) {
    ensureObjectRuntime(ctx);
  } else {
    const externref: ValType = { kind: "externref" };
    ensureLateImport(ctx, "__extern_has", [externref, externref], [{ kind: "i32" }]);
  }
  flushLateImportShifts(ctx, null);
}

function preregisterDynamicAndForInSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  preregisterForInSupport(ctx, fns);
  preregisterInOperatorSupport(ctx, fns);
  preregisterDynamicSupport(ctx, fns);
}

/**
 * Slice 9 (#1169h): pre-register the shared `__exn` exception tag if any
 * IR function emits `throw` or `try`. The tag itself doesn't shift
 * function indices (it lives in `ctx.mod.tags`), but pre-registering
 * keeps the resolver path uniform with other lazy registrations and
 * avoids a late `ensureExnTag` call mid-emission.
 */
function preregisterExceptionSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const root of block.instrs) {
        let usesExceptions = false;
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "throw" || instr.kind === "try") usesExceptions = true;
        });
        if (usesExceptions) {
          ensureExnTag(ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic (boxed-any) op lowering (#2949 slice 3)
// ---------------------------------------------------------------------------

/**
 * #2949 slice 3 — does this instruction carry a dynamic box/unbox/tag.test?
 * `tagId` presence is the dynamic-operand discriminator for unbox/tag.test
 * (verifier R2/R3 make it REQUIRED exactly there and reject it elsewhere).
 */
/**
 * (#3143) The function names `addUnionImports` (src/codegen/index.ts) registers
 * — host `env::*` imports OR wasi/standalone native funcs of the same names. A
 * from-ast boxing/unboxing coercion can emit a DIRECT symbolic `call` to one of
 * these (bypassing the `box`/`unbox` IR instruction), relying on legacy's
 * dual-compile side effect to have registered it. Under IR-first that side
 * effect is skipped, so `preregisterDynamicSupport` must register the family
 * itself when it sees such a call. Kept in lockstep with `addUnionImports`.
 */
const UNION_IMPORT_FUNC_NAMES: ReadonlySet<string> = new Set([
  "__box_number",
  "__unbox_number",
  "__box_boolean",
  "__unbox_boolean",
  "__box_bigint",
  "__to_bigint",
  "__bigint_ctor",
  "__bigint_ctor_ref",
  "__box_symbol",
  "__is_truthy",
  "__typeof",
  "__typeof_number",
  "__typeof_string",
  "__typeof_boolean",
  "__typeof_bigint",
  "__typeof_object",
  "__typeof_function",
  "__typeof_undefined",
]);

function isDynamicOp(instr: IrInstr): boolean {
  if (instr.kind === "box") return instr.toType.kind === "dynamic";
  if (instr.kind === "unbox" || instr.kind === "tag.test") return instr.tagId !== undefined;
  // #2949 S5.1 — dyn.truthy always consumes the boxed-any carrier, so its
  // presence requires the dynamic backing (ensureAnyHelpers / addUnionImports).
  if (instr.kind === "dyn.truthy") return true;
  // #2949 S5.3 — dyn.to_number consumes the carrier and calls the canonical
  // ToNumber helper (`__any_to_f64` gc / `__unbox_number` host), so it requires
  // the dynamic backing pre-registered too.
  if (instr.kind === "dyn.to_number") return true;
  // #2949 S5.2 — dyn.eq consumes two carriers and calls the canonical equality
  // helpers, so it too requires the dynamic backing pre-registered.
  if (instr.kind === "dyn.eq") return true;
  // #3053 U1 / #2949 S5.4 — dyn.member_get calls `__dyn_member_get`, which is
  // built on the canonical any-helper family (`__any_from_extern_honest` /
  // `__any_to_extern` / `__box_*`), so it requires the dynamic backing too.
  // The helper itself is registered separately below (`ensureDynMemberGet`).
  if (instr.kind === "dyn.member_get" || instr.kind === "dyn.member_set") return true;
  return false;
}

/**
 * #3053 U1 — does this instruction lower through the unified dynamic-reader
 * carrier primitive `__dyn_member_get` (#3053 U0)? That helper is a DEFINED
 * function built at finalize by `ensureDynMemberGet`, gated on the
 * `ctx.usesDynMemberGet` latch; it must be REGISTERED up-front (before Phase 3)
 * so the handle's `emitMemberGet` can resolve its funcidx by name, exactly like
 * the any/eq helper families above.
 */
function usesDynMemberGet(instr: IrInstr): boolean {
  return instr.kind === "dyn.member_get";
}

function usesDynMemberSet(instr: IrInstr): boolean {
  return instr.kind === "dyn.member_set";
}

/**
 * #2949 S5.2 — does this instruction lower through the canonical any-equality
 * helper family (`__any_strict_eq` / `__any_eq`, plus `__any_from_extern` in
 * host mode)? These are DEFINED functions built by `ensureAnyHelpers`, which
 * the host (non-fast) preregister path does NOT otherwise run — so a `dyn.eq`
 * in a host module needs the extra registration below.
 */
function usesDynEq(instr: IrInstr): boolean {
  return instr.kind === "dyn.eq";
}

/**
 * #2949 slice 3 — map a box target's tag refinement onto `boxToAny`'s
 * `jsType` hint. One partition table (js-tag.ts) → one hint vocabulary
 * (value-tags.ts); "unknown" reproduces the historical kind-keyed dispatch
 * exactly, so an unrefined box is behavior-identical to legacy's unbranded
 * `any` coercion.
 */
function jsTagToStaticType(
  hint: JsTag | undefined,
): "null" | "undefined" | "boolean" | "number" | "string" | "object" | "function" | "unknown" {
  switch (hint) {
    case JsTag.Null:
      return "null";
    case JsTag.Undefined:
      return "undefined";
    case JsTag.Boolean:
      return "boolean";
    case JsTag.NumberI32:
    case JsTag.NumberF64:
      return "number";
    case JsTag.String:
      return "string";
    case JsTag.Object:
      return "object";
    case JsTag.Function:
      return "function";
    default:
      return "unknown";
  }
}

/**
 * #2949 slice 3 — pre-register everything `makeDynamicLowering`'s emit
 * methods can resolve by name, BEFORE Phase-3 emission starts:
 *   - fast (gc strategy): `ensureAnyHelpers` — $AnyValue + the canonical
 *     `__any_box_*` / `__any_unbox_*` family. These are DEFINED functions
 *     (appended, no import shift), but ensureAnyHelpers also pulls string
 *     imports on some paths, so it must not fire mid-emission.
 *   - host: `addUnionImports` — `__box_number` / `__unbox_number` /
 *     `__unbox_boolean` / `__typeof_*`. This is a late-IMPORT registration
 *     that shifts every defined funcIdx; running it here (before any IR
 *     body buffer exists) makes the shift a no-op hazard-wise, exactly
 *     like `preregisterStringSupport`.
 * Both are idempotent, so overlapping legacy registration is a no-op.
 */
/**
 * (#3526 F1-S4) Which arm of the externref undefined probe an instruction's
 * ATTACHED provider names, if any.
 *
 * `__extern_is_undefined` is NOT a member of the `addUnionImports` family: on
 * the host lane it is its own `ensureLateImport` registration, and on the
 * host-free lanes a real Wasm function `ensureObjectRuntime` owns. Its two
 * preregistration detectors therefore stay separate from the union ones, and
 * each must recognise the attached provider target now that the raw `call` they
 * used to key on is gone (the F1-S1/F1-S2 precedent). This returns only the
 * classification — the detector FLAGS still decide when each materializer runs,
 * so the registration order in `preregisterDynamicSupport` is untouched.
 */
function attachedExternIsUndefinedArm(instr: IrInstr): "host" | "native" | undefined {
  if (instr.kind !== "intrinsic" || instr.id !== "js.extern.is_undefined") return undefined;
  if (instr.provider?.kind !== "callable") return undefined;
  const { binding } = instr.provider.target;
  if (binding.kind === "import" && binding.module === "env" && binding.field === "__extern_is_undefined") return "host";
  if (binding.kind === "runtime" && binding.symbol === "__extern_is_undefined") return "native";
  return undefined;
}

function preregisterDynamicSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  const nativeSemanticProviders = ctx.targetProfile.semanticProviders === "native-first";
  let usesDynamicOps = false;
  let usesEq = false;
  let usesToNumber = false;
  let usesMemberGet = false;
  let usesMemberSet = false;
  // (#3143) A from-ast lowering can emit a DIRECT named call to a member of the
  // `addUnionImports` family (`__box_number` / `__unbox_number` / `__box_boolean`
  // / …) rather than a `box`/`unbox` IR instruction — e.g. `coerceToExpectedExtern`
  // boxes f64→externref via `emitCall({name:"__box_number"})` (from-ast.ts:3355),
  // and `coerceReturnValue` unboxes via `__unbox_number`. Under the OVERLAY those
  // imports are registered as a side effect of legacy's own compile of the same
  // function (the documented dual-compile assumption at from-ast.ts:3345). Under
  // IR-first the legacy body is skipped, so that side effect never happens and the
  // funcref resolves to nothing — a hard `unknown function ref` at Phase 3. Detect
  // such a named call here (a `call` whose symbolic target is a union-import name)
  // and pre-register the family. `isDynamicOp` does NOT catch these: they are plain
  // `call` instrs, not the `box`/`unbox`/`dyn.*` kinds it inspects.
  let usesNamedUnionImport = false;
  // (#3143) `__extern_is_undefined` ((externref)->i32) is a from-ast-emitted
  // late-import helper (from-ast.ts:6261, `x !== undefined` on an externref)
  // that legacy registers on demand via `ensureLateImport` — another
  // dual-compile side effect IR-first skips. Detect + register the same way.
  let usesExternIsUndefined = false;
  // #4208 S3/S7 — explicit runtime refs emitted for the IR-owned open
  // OrdinaryToPrimitive literal. These providers must exist before Phase 3:
  // compatibility mode registers late imports, while the native semantic
  // provider materializes the object runtime. `__unbox_number` comes from the
  // union family in every lane.
  let usesOrdinaryToPrimitiveObjectRuntime = false;
  let usesRuntimeUnboxNumber = false;
  // (#4461) The host-free `Map` carrier and the native undefined predicate.
  // Both are REAL Wasm functions on this lane, so they are reserved here —
  // before any Phase-3 body bakes a funcIdx — exactly like the union family.
  let usesNativeMapAdapters = false;
  let usesNativeExternIsUndefined = false;
  const primitiveWrapperConstructors = new Set<"Boolean" | "Number" | "String">();
  const dynamicRuntimeNeeds = new Set<IrDynamicRuntimeNeed>();
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (i) => {
          if (isDynamicOp(i)) usesDynamicOps = true;
          if (usesDynEq(i)) usesEq = true;
          if (i.kind === "dyn.to_number") usesToNumber = true;
          if (usesDynMemberGet(i)) usesMemberGet = true;
          if (usesDynMemberSet(i)) usesMemberSet = true;
          // (#3526 F1-S1, widened by F1-S2) The number and boolean boundaries
          // reach Phase 3 as semantic `intrinsic`s whose frozen providers carry
          // the SAME physical targets the old direct calls used. Provider
          // attachment already ran (the manifest is prepared at the top of the
          // preparation sequence, this preregistration later in the same one),
          // so recognizing the exact attached targets here keeps
          // `addUnionImports` the whole union family's single materializer —
          // and keeps import membership, order and indices identical to the
          // legacy control. No name scanning, no second allocator.
          const boundaryIntrinsicTarget =
            i.kind === "intrinsic" &&
            (i.id === "js.number.box" ||
              i.id === "js.number.unbox" ||
              i.id === "js.boolean.box" ||
              i.id === "js.extern.is_undefined") &&
            i.provider?.kind === "callable"
              ? i.provider.target
              : undefined;
          if (
            boundaryIntrinsicTarget?.binding.kind === "import" &&
            boundaryIntrinsicTarget.binding.module === "env" &&
            UNION_IMPORT_FUNC_NAMES.has(boundaryIntrinsicTarget.binding.field)
          ) {
            usesNamedUnionImport = true;
          }
          if (
            boundaryIntrinsicTarget?.binding.kind === "runtime" &&
            UNION_IMPORT_FUNC_NAMES.has(boundaryIntrinsicTarget.binding.symbol)
          ) {
            usesRuntimeUnboxNumber = true;
          }
          // (#3526 F1-S4) The undefined probe's own arm — see
          // `attachedExternIsUndefinedArm`.
          const probeArm = attachedExternIsUndefinedArm(i);
          if (probeArm === "host") usesExternIsUndefined = true;
          else if (probeArm === "native") usesNativeExternIsUndefined = true;
          if (i.kind === "call" && i.target.binding.kind === "import" && i.target.binding.module === "env") {
            if (UNION_IMPORT_FUNC_NAMES.has(i.target.binding.field)) usesNamedUnionImport = true;
            else if (i.target.binding.field === "__extern_is_undefined") usesExternIsUndefined = true;
          }
          if (i.kind === "call" && i.target.binding.kind === "runtime") {
            switch (i.target.binding.symbol) {
              case "__new_plain_object":
              case "__extern_set":
              case "__to_primitive":
                usesOrdinaryToPrimitiveObjectRuntime = true;
                break;
              case "__unbox_number":
                usesRuntimeUnboxNumber = true;
                break;
              // (#4461) native `$Map` module-binding storage.
              case IR_NATIVE_MAP_NEW_FN:
              case IR_NATIVE_MAP_GET_NUM_FN:
              case IR_NATIVE_MAP_SET_NUM_FN:
                usesNativeMapAdapters = true;
                break;
              case "__extern_is_undefined":
                usesNativeExternIsUndefined = true;
                break;
              case "__new_Boolean":
                primitiveWrapperConstructors.add("Boolean");
                break;
              case "__new_Number":
                primitiveWrapperConstructors.add("Number");
                break;
              case "__new_String":
                primitiveWrapperConstructors.add("String");
                break;
              case IR_DYN_ADD_FN:
                dynamicRuntimeNeeds.add("add");
                break;
              case IR_DYN_LT_FN:
                dynamicRuntimeNeeds.add("lt");
                break;
              case IR_DYN_LE_FN:
                dynamicRuntimeNeeds.add("le");
                break;
              case IR_DYN_GT_FN:
                dynamicRuntimeNeeds.add("gt");
                break;
              case IR_DYN_GE_FN:
                dynamicRuntimeNeeds.add("ge");
                break;
              case IR_DYN_METHOD_CALL_0_FN:
                dynamicRuntimeNeeds.add("method-call-0");
                break;
              case IR_DYN_METHOD_CALL_1_FN:
                dynamicRuntimeNeeds.add("method-call-1");
                break;
              case IR_DYN_STRING_REPLACE_FN:
                dynamicRuntimeNeeds.add("string-replace");
                break;
            }
          }
        });
      }
    }
  }
  if (usesOrdinaryToPrimitiveObjectRuntime) {
    if (nativeSemanticProviders) {
      ensureObjectRuntime(ctx);
    } else {
      ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
      ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
      ensureLateImport(ctx, "__to_primitive", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, null);
    }
  }
  if (primitiveWrapperConstructors.size > 0) {
    // #4208 S4 — explicit runtime refs for the focused primitive-wrapper
    // construction. Host-free lanes materialize the real `$Object` wrappers
    // (including [[PrimitiveValue]]) through the existing object runtime;
    // host mode registers only the exact wrapper imports observed in IR.
    if (ctx.standalone || ctx.wasi) {
      ensureObjectRuntime(ctx);
    } else {
      for (const wrapperConstructor of primitiveWrapperConstructors) {
        ensureLateImport(
          ctx,
          `__new_${wrapperConstructor}`,
          [{ kind: wrapperConstructor === "String" ? "externref" : "f64" }],
          [{ kind: "externref" }],
        );
      }
      flushLateImportShifts(ctx, null);
    }
  }
  if (usesRuntimeUnboxNumber) addUnionImports(ctx);
  // (#4461) Reserve the native undefined predicate and the `$Map` adapters
  // BEFORE Phase 3. `ensureObjectRuntime` / `ensureIrNativeMapAdapters` are
  // both idempotent and both may add an import batch, so they flush here where
  // a funcIdx shift is still hazard-free.
  if (usesNativeExternIsUndefined) {
    ensureObjectRuntime(ctx);
    flushLateImportShifts(ctx, null);
    observeNativeRuntimeProvider(ctx, "__extern_is_undefined");
  }
  if (usesNativeMapAdapters) {
    ensureIrNativeMapAdapters(ctx);
    flushLateImportShifts(ctx, null);
    observeNativeRuntimeProvider(ctx, IR_NATIVE_MAP_NEW_FN);
    observeNativeRuntimeProvider(ctx, IR_NATIVE_MAP_GET_NUM_FN);
    observeNativeRuntimeProvider(ctx, IR_NATIVE_MAP_SET_NUM_FN);
    // A native-map `.get` result reaching an `f64` return unboxes through the
    // native `__unbox_number`, so its provider is discovered here too.
    observeNativeRuntimeProvider(ctx, "__unbox_number");
  }
  // (#3143) A named union-import call needs the host/native import family
  // registered even when no `dyn.*` op is present (the boxing-coercion path).
  // `addUnionImports` covers host (env imports) AND wasi/standalone (native
  // funcs), is idempotent, and runs here — before any Phase-3 body buffer —
  // so its defined-funcIdx shift is hazard-free, exactly like the dynamic-op
  // path below. In `fast` (gc) mode the any-helper family owns boxing, but a
  // from-ast number boundary attaches an `env.__box_number` / `env.__unbox_number`
  // provider only when the frozen manifest resolved this lane's policy to the
  // host arm (#3526 F1-S1), so registering it here is correct in every mode the
  // target can appear.
  if (usesNamedUnionImport) addUnionImports(ctx);
  if (usesExternIsUndefined) {
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    // (#3143) Apply the deferred import's funcIdx shift + defined-body fix-up
    // NOW, before Phase-3 emission bakes any funcIdx. `ensureLateImport` only
    // BATCHES the import; leaving it pending here desyncs the Phase-3 resolver
    // (a sibling IR function's `ctx.funcMap` funcIdx would be read pre-shift and
    // fall out of the defined-function range — the #329/#2078 late-shift class).
    // `addUnionImports` above already self-flushes; this covers the bare
    // extern-is-undefined path (no union import present).
    flushLateImportShifts(ctx, null);
  }
  if (dynamicRuntimeNeeds.size > 0) {
    addUnionImports(ctx);
    ensureIrDynamicRuntime(ctx, dynamicRuntimeNeeds);
  }
  if (!usesDynamicOps) return;
  if (usesToNumber && ctx.standalone) {
    // The canonical standalone ToNumber sequence performs
    // ToPrimitive("number") before unboxing. Reserve that provider now so
    // emitToNumber cannot introduce a late func-index shift while Phase 3
    // already owns detached IR body buffers.
    ensureLateImport(ctx, "__to_primitive", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, null);
  }
  if (ctx.fast) {
    // gc: ensureAnyHelpers registers $AnyValue + the __any_box_*/__any_unbox_*
    // family AND the equality helpers (__any_strict_eq / __any_eq) — one call
    // covers every gc dynamic op, dyn.eq included.
    ensureAnyHelpers(ctx);
  } else {
    // host: the classifier / box import family for box/unbox/tag.test/truthy.
    addUnionImports(ctx);
    // #2949 S5.2 — compatibility semantics call `__host_eq` (JS `===`) /
    // `__host_loose_eq` (JS `==`). Native-first semantics use the native
    // externref classifiers even when JS value interop remains available.
    // Register the selected family up-front so no emit can trigger a shift
    // (#329/#2078), exactly like `addUnionImports` above. Both are idempotent;
    // only fired when a host module actually carries a dyn.eq.
    if (usesEq) {
      if (nativeSemanticProviders) {
        ensureExternStrictEqHelper(ctx);
        ensureExternLooseEqHelper(ctx);
      } else {
        ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
        ensureLateImport(ctx, "__host_loose_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
        // Settle the batch before Phase 3 captures patch-slot and call-target
        // indices. Leaving these two imports pending can shift the eventual IR
        // replacement onto a sibling legacy slot.
        flushLateImportShifts(ctx, null);
      }
    }
  }
  // #3053 U1 — a `dyn.member_get` present in any IR body needs the unified
  // reader primitive `__dyn_member_get` (#3053 U0) REGISTERED up-front so the
  // handle's `emitMemberGet` resolves its funcidx by name at emit time (the
  // finalize `ensureDynMemberGet` runs AFTER Phase 3, too late for that). Flip
  // the latch and register here; `ensureDynMemberGet` mints only DEFINED funcs
  // (`addFuncType` + `mintDefinedFunc` — no import shift) and reuses the any-
  // helper family just registered above, so this is funcidx-shift-safe at
  // preregister time. It self-guards (bails, resetting the latch, if the object
  // runtime's `__extern_get` is not yet registered), and the finalize pass is
  // then idempotent via the `dynMemberGetHelpersEmitted` latch. Byte-inert
  // until S5.P (U2) opens the selector scan: no from-ast producer emits
  // `dyn.member_get` in a claimed function today, so `usesMemberGet` is never
  // set in a production compile.
  if (usesMemberGet) {
    if (nativeSemanticProviders) ensureObjectRuntime(ctx);
    ctx.usesDynMemberGet = true;
    ensureDynMemberGet(ctx);
  }
  if (usesMemberSet) {
    if (nativeSemanticProviders) {
      ensureObjectRuntime(ctx);
    } else {
      ensureLateImport(
        ctx,
        "__extern_set_strict",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      flushLateImportShifts(ctx, null);
    }
    ensureDynMemberSet(ctx);
  }
}

/**
 * #2949 slice 3 — the PRODUCTION `IrDynamicLowering` factory (see
 * `backend/handles.ts` for the full contract, incl. the V2 numeric-class
 * tag.test rule and the payload-field table). Exported so tests exercise
 * the exact implementation the compiler uses, not a mock.
 *
 * Mode split MUST mirror `resolveDynamic()` (same `ctx.fast` test — the
 * carrier and its ops are one decision):
 *   - fast → "gc": `ref_null $AnyValue`; box via `boxToAny` (THE canonical
 *     tag-selection policy — same helper family, same tags, byte-parity
 *     with legacy's `any` coercion for the same operand kind); unbox via
 *     the canonical `__any_unbox_f64` / `__any_unbox_i32` readers (V2:
 *     they accept BOTH numeric tags) or a direct payload `struct.get`;
 *     tag.test via a tag-field read.
 *   - non-fast → "host": externref; `__box_number` family + `__typeof_*`
 *     classifier imports (registered by `preregisterDynamicSupport`).
 *
 * Every funcIdx is resolved BY NAME at emit time (never captured at handle
 * creation) — the #2191/#2193 name-based-repoint discipline.
 *
 * Producer contracts the emit arms rely on (enforced upstream, asserted
 * here defensively):
 *   - unbox is only emitted under a tag.test proof (verifier R2 field
 *     rules + producer discipline) — a wasm-null gc carrier traps.
 *   - a BOOLEAN-branded i32 must not be boxed through `emitBox` (both
 *     strategies box bare i32 as a NUMBER, matching legacy's unbranded
 *     kind-keyed dispatch); a boolean-aware box needs the jsType hint
 *     plumbed through — a later producer slice.
 */
export function makeDynamicLowering(ctx: CodegenContext): IrDynamicLowering | null {
  const nativeSemanticProviders = ctx.targetProfile.semanticProviders === "native-first";
  if (ctx.fast) {
    ensureAnyValueType(ctx);
    const anyTypeIdx = ctx.anyValueTypeIdx;
    const callHelper = (name: string): Instr => {
      const idx = ctx.funcMap.get(name);
      if (idx === undefined) {
        throw new Error(
          `ir/integration: ${name} not registered — preregisterDynamicSupport must run before Phase 3 (#2949)`,
        );
      }
      return { op: "call", funcIdx: idx };
    };
    const payloadFieldIdx = (tag: JsTag): number => {
      switch (jsTagUnboxKind(tag)) {
        case "i32":
          return 1; // i32val (NumberI32 / Boolean)
        case "f64":
          return 2; // f64val (NumberF64)
        case "ref":
          // String rides extern-shaped in `externval` under tag 5 in BOTH
          // string modes (the #42 / tag-5-field-4 contract); Object and
          // Function refs ride in `refval` (eqref).
          return tag === JsTag.String ? 4 : 3;
        default:
          throw new Error(`ir/integration: JsTag ${JsTag[tag]} is a singleton partition — no payload field (#2949)`);
      }
    };
    return {
      carrier: { kind: "ref_null", typeIdx: anyTypeIdx },
      strategy: "gc",
      anyValueTypeIdx: anyTypeIdx,
      tagFieldIdx: 0,
      payloadFieldIdx,
      emitBox(from: ValType, hint?: JsTag): readonly Instr[] {
        // Route through boxToAny — THE canonical boxing entry point. It only
        // touches `fctx.body`, so a body-only context shim is sound; using it
        // (instead of re-deriving the helper choice here) keeps ONE
        // kind→tag policy for legacy and IR (June-audit D4), including the
        // native-string re-tag arm and the honestAnyBoxing flag behavior.
        // The refinement hint maps onto boxToAny's jsType hint verbatim —
        // same "never override representation" contract.
        const shim = { body: [] } as unknown as FunctionContext;
        if (!boxToAny(ctx, shim, from, jsTagToStaticType(hint))) {
          throw new Error(
            `ir/integration: no canonical boxing arm for operand kind "${from.kind}" — ` +
              `was preregisterDynamicSupport skipped? (#2949)`,
          );
        }
        return shim.body;
      },
      emitUnbox(tag: JsTag): readonly Instr[] {
        switch (tag) {
          case JsTag.NumberF64:
            // V2 numeric class: the canonical reader converts a tag-2 i32
            // payload, so a class-proven "number" always reads correctly.
            return [callHelper("__any_unbox_f64")];
          case JsTag.NumberI32:
            // V2 numeric class: trunc-sats a tag-3 f64 payload.
            return [callHelper("__any_unbox_i32")];
          case JsTag.Boolean:
          case JsTag.String:
          case JsTag.Object:
          case JsTag.Function:
            // Exact-tag partitions: direct payload read after the proof.
            return [{ op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: payloadFieldIdx(tag) }];
          default:
            throw new Error(`ir/integration: cannot unbox singleton partition ${JsTag[tag]} (#2949 R2)`);
        }
      },
      emitTagTest(tag: JsTag): readonly Instr[] {
        if (tag === JsTag.NumberI32 || tag === JsTag.NumberF64) {
          // Numeric CLASS test (V2): tag ∈ {2,3} ⇔ (tag − 2) ≤u 1. Keeps
          // gc and host tag.test semantics identical — host `typeof` has
          // exactly one "number".
          return [
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: JsTag.NumberI32 },
            { op: "i32.sub" },
            { op: "i32.const", value: 1 },
            { op: "i32.le_u" },
          ];
        }
        return [
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: tag },
          { op: "i32.eq" },
        ];
      },
      emitToBoolean(): readonly Instr[] {
        // #2949 S5.1 — ToBoolean(carrier) via THE canonical coercion-engine
        // path (D4): for the `$AnyValue` carrier it emits `__any_unbox_bool`
        // (proper JS truthiness — `0`/`NaN`/`""`/`null`/`undefined` falsy).
        // `ensureAnyHelpers` already ran in `preregisterDynamicSupport`, so
        // the internal `ensureAnyHelpers` here is an idempotent no-op — no
        // mid-emission funcIdx shift.
        return emitCoercionToBoolean(ctx, { kind: "ref_null", typeIdx: anyTypeIdx }, []);
      },
      emitToNumber(_scratch?: () => number): readonly Instr[] {
        // #2949 S5.3 — ToNumber(carrier) for the gc `$AnyValue` carrier via
        // `__any_to_f64`: THE canonical boxed-any→f64 helper legacy's
        // `__any_lt`/`__any_gt`/… + arithmetic helpers use (null→0, undefined→
        // NaN, boolean→0/1, number→value) — one ToNumber engine (D4). Chosen
        // directly rather than through `coercion-engine.emitToNumber`, whose
        // `$AnyValue` arm routes to `coerceType(…,"number")` and allocates a
        // temp local (via `allocTempLocal`), which the handle's pure `Instr[]`
        // contract cannot supply. `ensureAnyHelpers` (run up-front in
        // `preregisterDynamicSupport`) registers `__any_to_f64`, so `callHelper`
        // resolves it by name with no mid-emission funcIdx shift.
        return [callHelper("__any_to_f64")];
      },
      emitEqOperand(): readonly Instr[] {
        // #2949 S5.2 — the gc carrier IS `(ref null $AnyValue)`, already the
        // `__any_strict_eq`/`__any_eq` parameter shape. No marshalling.
        return [];
      },
      emitStrictEq(negate: boolean): readonly Instr[] {
        // Canonical `===` engine (D4): the tag-5 classifier — cross-type
        // falsity, numeric-class `23 === 23.0`, `NaN === NaN → false`
        // (`f64.eq`), reference identity — lives in `__any_strict_eq`'s body.
        return negate ? [callHelper("__any_strict_eq"), { op: "i32.eqz" }] : [callHelper("__any_strict_eq")];
      },
      emitLooseEq(negate: boolean): readonly Instr[] {
        return negate ? [callHelper("__any_eq"), { op: "i32.eqz" }] : [callHelper("__any_eq")];
      },
      emitMemberGet(): readonly Instr[] {
        // #3053 U1 / #2949 S5.4 — dynamic member read via the unified reader
        // primitive. The carrier IS `(ref null $AnyValue)`, exactly the
        // `__dyn_member_get(recv, key)` param shape, and the result is the same
        // carrier — no marshalling. Flip the latch that makes the finalize
        // `ensureDynMemberGet` pass build the helper; it was pre-registered
        // up-front by `preregisterDynamicSupport`, so `callHelper` resolves it
        // by name with no mid-emission funcidx shift.
        ctx.usesDynMemberGet = true;
        return [callHelper("__dyn_member_get")];
      },
      emitElementGet(): readonly Instr[] {
        // Indexed form — the reader is key-uniform (the helper's own
        // `__any_to_extern(key)` converts a boxed number key to a decimal
        // property key), so it lowers to the identical bare call.
        ctx.usesDynMemberGet = true;
        return [callHelper("__dyn_member_get")];
      },
      emitMemberSet(): readonly Instr[] {
        return [callHelper("__dyn_member_set")];
      },
    };
  }

  // Non-fast: externref carrier; host imports or standalone/WASI native
  // providers from the union family.
  const callImport = (name: string): Instr => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) {
      throw new Error(
        `ir/integration: host import ${name} not registered — preregisterDynamicSupport must run before Phase 3 (#2949)`,
      );
    }
    return { op: "call", funcIdx: idx };
  };
  return {
    carrier: { kind: "externref" },
    strategy: "host",
    anyValueTypeIdx: -1,
    tagFieldIdx: -1,
    payloadFieldIdx(tag: JsTag): number {
      throw new Error(`ir/integration: host dynamic carrier has no payload fields (asked for ${JsTag[tag]})`);
    },
    emitBox(from: ValType, hint?: JsTag): readonly Instr[] {
      switch (from.kind) {
        case "f64":
          return [callImport("__box_number")];
        case "i32":
          // Boolean-REFINED i32 boxes as a host boolean (mirrors legacy's
          // type-aware coerceType, #2785). Unrefined i32 keeps NUMBER
          // semantics — identical to legacy's unbranded i32→externref
          // coercion.
          if (hint === JsTag.Boolean) {
            return [callImport("__box_boolean")];
          }
          return [{ op: "f64.convert_i32_s" }, callImport("__box_number")];
        case "externref":
          // Host strings / already-host-boxed values ARE the carrier.
          return [];
        case "ref":
        case "ref_null":
        case "eqref":
          // Struct/array/closure refs are anyref subtypes — re-tag.
          return [{ op: "extern.convert_any" }];
        default:
          throw new Error(`ir/integration: no host boxing arm for operand kind "${from.kind}" (#2949)`);
      }
    },
    emitUnbox(tag: JsTag): readonly Instr[] {
      switch (tag) {
        case JsTag.NumberF64:
          return [callImport("__unbox_number")];
        case JsTag.NumberI32:
          // Same narrowing the gc reader applies to a tag-3 payload.
          return [callImport("__unbox_number"), { op: "i32.trunc_sat_f64_s" }];
        case JsTag.Boolean:
          // ToBoolean on a PROVEN boolean is the identity payload read.
          return [callImport("__unbox_boolean")];
        case JsTag.String:
        case JsTag.Object:
        case JsTag.Function:
          // The host carrier IS the host value — identity.
          return [];
        default:
          throw new Error(`ir/integration: cannot unbox singleton partition ${JsTag[tag]} (#2949 R2)`);
      }
    },
    emitTagTest(tag: JsTag, scratch: () => number): readonly Instr[] {
      switch (tag) {
        case JsTag.NumberI32:
        case JsTag.NumberF64:
          // Numeric CLASS test (V2) — host typeof has one "number".
          return [callImport("__typeof_number")];
        case JsTag.String:
          return [callImport("__typeof_string")];
        case JsTag.Boolean:
          return [callImport("__typeof_boolean")];
        case JsTag.Function:
          return [callImport("__typeof_function")];
        case JsTag.Undefined:
          return [callImport("__typeof_undefined")];
        case JsTag.Null:
          // JS null crosses the boundary as THE null externref; undefined
          // is a real (non-null) host value — so ref.is_null is exactly
          // the Null partition test.
          return [{ op: "ref.is_null" }];
        case JsTag.Object: {
          // `typeof v === "object"` is true for null (host semantics);
          // the Object PARTITION excludes it. Read the operand twice via
          // the lazily-allocated carrier scratch local.
          const s = scratch();
          return [
            { op: "local.tee", index: s },
            callImport("__typeof_object"),
            { op: "local.get", index: s },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "i32.and" },
          ];
        }
        default:
          throw new Error(`ir/integration: no host tag.test arm for ${JsTag[tag]} (#2949)`);
      }
    },
    emitToBoolean(): readonly Instr[] {
      // #2949 S5.1 — ToBoolean(externref carrier) via the canonical
      // coercion-engine path (D4): `__is_truthy` (0/NaN/null/undefined/""
      // → falsy). `addUnionImports` already ran in
      // `preregisterDynamicSupport` (which registers `__is_truthy`), so the
      // internal `addUnionImports` / `ensureLateImport` here find the import
      // by name and add nothing — no import shift mid-emission.
      return emitCoercionToBoolean(ctx, { kind: "externref" }, []);
    },
    emitToNumber(scratch?: () => number): readonly Instr[] {
      return emitExternrefDynamicToNumber(ctx, scratch);
    },
    emitEqOperand(): readonly Instr[] {
      // #2949 S5.2 — the host carrier is `externref`, which is EXACTLY the
      // `(externref, externref)` shape `__host_eq` / `__host_loose_eq` take.
      // No marshalling — legacy host `any === any` compares the raw externrefs
      // (verified: a `boxToAny`+`__any_eq` marshalling DIVERGES — it drops the
      // §7.2.15 coercions, giving `"5" == 5 → false`; the `__any_eq` path is the
      // STANDALONE `noJsHost` branch in binary-ops, not host's).
      return [];
    },
    emitStrictEq(negate: boolean): readonly Instr[] {
      // Compatibility semantics delegate to JS. Native-first semantics use the
      // externref classifier + AnyValue comparison helper even with a JS host.
      const helper = nativeSemanticProviders ? "__extern_strict_eq" : "__host_eq";
      return negate ? [callImport(helper), { op: "i32.eqz" }] : [callImport(helper)];
    },
    emitLooseEq(negate: boolean): readonly Instr[] {
      // Compatibility semantics delegate to JS. Native-first classifies both
      // externref carriers and routes through the native `__any_eq` engine.
      const helper = nativeSemanticProviders ? "__extern_loose_eq" : "__host_loose_eq";
      return negate ? [callImport(helper), { op: "i32.eqz" }] : [callImport(helper)];
    },
    emitMemberGet(): readonly Instr[] {
      // #3053 U1 / #2949 S5.4 — dynamic member read. In host mode the carrier
      // IS `externref` and `__dyn_member_get` is a thin `__extern_get` wrapper
      // (a DEFINED function, resolved by name — same funcMap lookup as
      // `callImport`), so the read is a bare call with no box/peel. Flip the
      // latch the finalize `ensureDynMemberGet` reads.
      ctx.usesDynMemberGet = true;
      return [callImport("__dyn_member_get")];
    },
    emitElementGet(): readonly Instr[] {
      ctx.usesDynMemberGet = true;
      return [callImport("__dyn_member_get")];
    },
    emitMemberSet(): readonly Instr[] {
      return [callImport("__dyn_member_set")];
    },
  };
}

// ---------------------------------------------------------------------------
// Object struct registry (#1169b)
// ---------------------------------------------------------------------------

/**
 * Hash-based registry for `IrObjectShape` → WasmGC struct mappings.
 *
 * Slice-2 invariants:
 *   - Same canonical shape always maps to the same struct typeIdx.
 *   - The registry hashes shapes the same way as the legacy
 *     `fieldsHashKey` in `codegen/index.ts`, so a shape registered by
 *     legacy `ensureStructForType` and a shape registered through the IR
 *     converge on a single anonymous struct (`__anon_<n>`).
 *   - Field reference types are widened from `ref` to `ref_null` so
 *     `struct.new` defaults match the legacy `ensureStructForType`
 *     pattern (`codegen/index.ts:4584-4589`).
 *
 * Resolution can fail with `null` when a field IrType cannot be lowered
 * to a ValType — the lowerer surfaces that as a clean error, so the
 * containing function falls back to legacy.
 */
class ObjectStructRegistry {
  private readonly cache = new Map<string, IrObjectStructLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (t: IrType) => ValType,
  ) {}

  resolve(shape: IrObjectShape): IrObjectStructLowering | null {
    const key = this.hashKey(shape);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Lower each field IrType to a ValType. If any field is a kind we
    // can't lower, bail with null so the caller throws a clean error
    // and the function falls back to legacy.
    const fields: FieldDef[] = [];
    for (const f of shape.fields) {
      let wasm: ValType;
      try {
        wasm = this.resolveValType(f.type);
      } catch {
        return null;
      }
      // Widen non-null refs to ref_null so struct.new with default
      // initialization works — matches `codegen/index.ts:4584-4589`.
      if (wasm.kind === "ref") {
        wasm = { kind: "ref_null", typeIdx: wasm.typeIdx };
      }
      fields.push({ name: f.name, type: wasm, mutable: true });
    }

    // Reuse an existing anonymous struct with the same legacy hash key
    // if one was already registered (legacy↔IR convergence).
    const legacyKey = legacyFieldsHashKey(fields);
    let structName = this.ctx.anonStructHash.get(legacyKey);
    let typeIdx: number;
    if (structName !== undefined) {
      typeIdx = this.ctx.structMap.get(structName)!;
      // The structFields entry already exists from the legacy
      // registration; reuse it rather than overwriting.
    } else {
      structName = `__anon_${this.ctx.anonTypeCounter++}`;
      typeIdx = this.ctx.mod.types.length;
      this.ctx.mod.types.push({
        kind: "struct",
        name: structName,
        fields,
      } as StructTypeDef);
      this.ctx.structMap.set(structName, typeIdx);
      this.ctx.typeIdxToStructName.set(typeIdx, structName);
      this.ctx.structFields.set(structName, fields);
      this.ctx.anonStructHash.set(legacyKey, structName);
    }

    const fieldIdxByName = new Map<string, number>();
    fields.forEach((f, i) => fieldIdxByName.set(f.name, i));
    const lowering: IrObjectStructLowering = {
      typeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: shape has no field "${name}"`);
        }
        return idx;
      },
    };
    this.cache.set(key, lowering);
    return lowering;
  }

  /**
   * Canonical hash for a shape — names + recursive IR-type keys, joined
   * with stable separators. Different shapes always hash differently;
   * structurally identical shapes (already pre-sorted by name in the
   * builder) always hash identically.
   */
  private hashKey(shape: IrObjectShape): string {
    return shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join("|");
  }
}

/**
 * Mirror of `fieldsHashKey` in `src/codegen/index.ts`. Re-implemented
 * locally so the IR module doesn't pull on `codegen/index.ts`'s public
 * surface (which is large). The two implementations must stay in sync —
 * they're the legacy↔IR struct-dedup contract.
 */
function legacyFieldsHashKey(fields: readonly FieldDef[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const t = f.type;
    if (t.kind === "ref" || t.kind === "ref_null") {
      parts.push(`${f.name}:${t.kind}:${(t as { typeIdx: number }).typeIdx}`);
    } else {
      parts.push(`${f.name}:${t.kind}`);
    }
  }
  return parts.join("|");
}

/**
 * Slice 3 (#1169c): trivial wrapper around the legacy
 * `getOrRegisterRefCellType` so legacy and IR ref cells share a single
 * WasmGC struct per inner ValType.
 */
class RefCellRegistry {
  constructor(private readonly ctx: CodegenContext) {}

  resolve(inner: ValType): IrRefCellLowering | null {
    const typeIdx = getOrRegisterRefCellType(this.ctx, inner);
    return { typeIdx, fieldIdx: 0 };
  }

  resolveIr(inner: IrType): IrRefCellLowering | null {
    return this.resolve(lowerPreparedClosureSupportType(this.ctx, inner, this));
  }
}

/**
 * Slice 4 (#1169d): per-class lookup over the legacy class registry.
 *
 * The legacy `collectClassDeclaration` pass (in `class-bodies.ts`)
 * registers, for each class declared in source:
 *   - a struct type in `ctx.structMap` (key = className)
 *   - the canonical fields list in `ctx.structFields` (with `__tag` at
 *     field 0 for root classes)
 *   - a constructor function `<className>_new` in `ctx.funcMap`
 *   - one function per callable class member in `ctx.funcMap`
 *
 * `ClassRegistry.resolve` validates the shape's exact `IrClassId`. Callable
 * member refs retain their semantic kind and source name, bind exact source
 * units, and publish inherited compatibility keys as structural aliases.
 * Names remain consistency checks at the allocator seam, never identities.
 * A class that wasn't registered surfaces as `null` and the caller falls back.
 *
 * Cached per `IrClassId`; display labels never establish class identity.
 */
class ClassRegistry {
  private readonly cache = new Map<IrClassId, IrClassLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly classIdByShape: ReadonlyMap<IrClassShape, IrClassId>,
    private readonly identityContext: IrPlanningIdentityContext | undefined,
    private readonly bindUnitCallableSlot: (ref: IrFuncRef, funcIdx: number, physicalName: string) => void,
  ) {}

  private exactClassId(shape: IrClassShape): IrClassId {
    const projectedClassId = this.classIdByShape.get(shape);
    if (projectedClassId !== undefined && projectedClassId !== shape.classId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: class shape ${shape.className} aliases ${projectedClassId} and ${shape.classId}`,
      );
    }
    if (
      this.identityContext &&
      (projectedClassId === undefined || this.identityContext.declarationByClassId.get(shape.classId) === undefined)
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: class shape ${shape.className} has no exact structural identity ${shape.classId}`,
      );
    }
    return shape.classId;
  }

  /** Resolve exact class source allocations structurally in production. */
  private unitFuncIdx(unitId: IrUnitId, compatibilityName: string): number | undefined {
    return (
      this.ctx.programAbiClassCallables?.handleForUnit(unitId) ??
      (this.ctx.programAbiClassCallables ? undefined : this.ctx.funcMap.get(compatibilityName))
    );
  }

  private memberRef(
    classId: IrClassId,
    memberKind: IrClassMemberKind,
    legacyName: string,
    physicalName: string,
  ): IrFuncRef | null {
    const terminalKind = {
      method: "class-instance-method",
      getter: "class-instance-getter",
      setter: "class-instance-setter",
      static: "class-static-method",
    }[memberKind];
    const matches = [...(this.identityContext?.terminalByUnitId.values() ?? [])].filter(
      (terminal) =>
        terminal.kind === terminalKind &&
        terminal.observedKind === "class-member" &&
        terminal.lexicalOwnerId === classId &&
        terminal.legacyMatchName === legacyName,
    );
    if (matches.length > 1) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: class member ${classId} / ${legacyName} is not structurally unique`,
      );
    }
    const terminal = matches[0];
    if (!terminal) return null;
    const funcIdx = this.unitFuncIdx(terminal.id, physicalName);
    if (funcIdx === undefined) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: class member ${terminal.id} / ${physicalName} has no registered slot`,
      );
    }
    const ref = irUnitFuncRef({ unitId: terminal.id, name: physicalName });
    this.bindUnitCallableSlot(ref, funcIdx, physicalName);
    return ref;
  }

  /** Rebind a dependency-sealed symbolic member target into this lowering pass. */
  private preparedMemberTarget(target?: IrFuncRef): IrFuncRef | null {
    if (
      target?.binding.kind !== "unit" ||
      !this.ctx.programAbiSession?.hasPlan(irUnitCallableBindingId(target.binding.unitId))
    ) {
      return null;
    }
    const funcIdx = this.unitFuncIdx(target.binding.unitId, target.name);
    if (funcIdx === undefined) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: prepared class member ${target.binding.unitId} has no slot ${target.name}`,
      );
    }
    this.bindUnitCallableSlot(target, funcIdx, target.name);
    return target;
  }

  /**
   * Publish one inherited class member as an explicit alias of the exact
   * ancestor source unit that owns its allocator slot.
   *
   * The IR retains the semantic member kind separately from its compatibility
   * spelling. The class shape identifies the ancestor declaration, the
   * inventory identifies its source unit, and legacy inheritance must map the
   * child's physical key to that same allocator-owned function.
   */
  private inheritedMemberRef(
    shape: IrClassShape,
    classId: IrClassId,
    memberKind: IrClassMemberKind,
    memberName: string,
    childPhysicalName: string,
  ): IrFuncRef | null {
    const session = this.ctx.programAbiSession;
    if (!session) return null;
    const identity = this.identityContext;
    if (!identity) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: inherited class ${memberKind} ${classId} / ${memberName} has no structural inventory`,
      );
    }

    const ownDescriptors = shape.methods.filter(
      (descriptor) => descriptor.name === memberName && (descriptor.memberKind ?? "method") === memberKind,
    );
    if (ownDescriptors.length > 0) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ir/integration: own class ${memberKind} ${classId} / ${memberName} has no exact source slot`,
      );
    }

    const visited = new Set<IrClassId>([classId]);
    for (let ancestor = shape.parent; ancestor; ancestor = ancestor.parent) {
      const ancestorClassId = this.exactClassId(ancestor);
      if (visited.has(ancestorClassId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${memberName} has a cyclic class shape`,
        );
      }
      visited.add(ancestorClassId);
      const descriptors = ancestor.methods.filter(
        (descriptor) => descriptor.name === memberName && (descriptor.memberKind ?? "method") === memberKind,
      );
      if (descriptors.length > 1) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${ancestorClassId} / ${memberName} is not structurally unique`,
        );
      }
      if (descriptors.length === 0) continue;

      const ancestorDeclaration = identity.declarationByClassId.get(ancestorClassId);
      if (!ancestorDeclaration) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${ancestorClassId} / ${ancestor.className} has no exact declaration`,
        );
      }
      const declarations = ancestorDeclaration.members.filter((member) => {
        if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== memberName) return false;
        const isStatic =
          (ts.canHaveModifiers(member) &&
            ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) ??
          false;
        if (memberKind === "method") return ts.isMethodDeclaration(member) && !isStatic;
        if (memberKind === "getter") return ts.isGetAccessorDeclaration(member) && !isStatic;
        if (memberKind === "setter") return ts.isSetAccessorDeclaration(member) && !isStatic;
        return ts.isMethodDeclaration(member) && isStatic;
      });
      if (declarations.length !== 1) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${ancestorClassId} / ${memberName} has ${declarations.length} exact declarations`,
        );
      }
      const declaration = declarations[0]!;
      const terminalId = identity.unitIdByDeclaration.get(declaration);
      const terminal = terminalId === undefined ? undefined : identity.terminalByUnitId.get(terminalId);
      const terminalKind = {
        method: "class-instance-method",
        getter: "class-instance-getter",
        setter: "class-instance-setter",
        static: "class-static-method",
      }[memberKind];
      const memberSuffix =
        memberKind === "getter" ? `get_${memberName}` : memberKind === "setter" ? `set_${memberName}` : memberName;
      const ancestorLegacyName = `${ancestor.className}_${memberSuffix}`;
      if (
        !terminal ||
        identity.declarationByUnitId.get(terminal.id) !== declaration ||
        terminal.kind !== terminalKind ||
        terminal.observedKind !== "class-member" ||
        terminal.lexicalOwnerId !== ancestorClassId ||
        terminal.staticClassMember !== (memberKind === "static") ||
        terminal.legacyMatchName !== ancestorLegacyName
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${ancestorClassId} / ${memberName} has no consistent exact source unit`,
        );
      }
      const derivedOrdinal = identity.inventory.allUnits.findIndex((unit) => unit.id === terminal.id);
      if (derivedOrdinal < 0) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${terminal.id} is absent from structural inventory order`,
        );
      }

      const ancestorPhysicalName = classMemberFuncKey(this.ctx, ancestorLegacyName);
      const role =
        memberKind === "method"
          ? `class-method-adapter:instance:${memberName}`
          : `class-member-adapter:${memberKind}:${memberName}`;
      const ref = irSupportFuncRef(classId, role, childPhysicalName, derivedOrdinal);
      if (ref.binding.kind !== "support") {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${memberName} has a non-support adapter reference`,
        );
      }
      const inheritedAlias = this.ctx.programAbiClassCallables?.inheritedAlias(classId, terminal.id);
      if (inheritedAlias && inheritedAlias.canonicalUnitId !== terminal.id) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${memberName} aliases ${inheritedAlias.canonicalUnitId}, not exact ancestor ${terminal.id}`,
        );
      }
      const ancestorFuncIdx = this.unitFuncIdx(terminal.id, ancestorPhysicalName);
      const childFuncIdx =
        inheritedAlias?.handle ??
        (this.ctx.programAbiClassCallables ? undefined : this.ctx.funcMap.get(childPhysicalName));
      const ancestorFunc = ancestorFuncIdx === undefined ? undefined : definedFuncAt(this.ctx, ancestorFuncIdx);
      const childFunc = childFuncIdx === undefined ? undefined : definedFuncAt(this.ctx, childFuncIdx);
      if (ancestorFuncIdx === undefined || !ancestorFunc || ancestorFunc.name !== ancestorPhysicalName) {
        throw new IrInvariantError(
          "missing-function-slot",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${terminal.id} has no defined slot ${ancestorPhysicalName}`,
        );
      }
      if (!childFunc) {
        throw new IrInvariantError(
          "missing-function-slot",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${childPhysicalName} has no defined slot`,
        );
      }
      if (childFuncIdx !== ancestorFuncIdx || childFunc !== ancestorFunc) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${childPhysicalName} does not alias exact ancestor ${terminal.id} / ${ancestorPhysicalName}`,
        );
      }
      const signature = this.ctx.mod.types[ancestorFunc.typeIdx];
      if (!signature || signature.kind !== "func") {
        throw new IrInvariantError(
          "abi-type-index-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${terminal.id} / ${ancestorPhysicalName} has non-function type ${ancestorFunc.typeIdx}`,
        );
      }

      const ancestorRef = irUnitFuncRef({ unitId: terminal.id, name: ancestorPhysicalName });
      this.bindUnitCallableSlot(ancestorRef, ancestorFuncIdx, ancestorPhysicalName);
      const aliasOf = irUnitCallableBindingId(terminal.id);
      if (!session.hasPlan(aliasOf)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: ancestor class ${memberKind} ${terminal.id} has no Program ABI callable plan`,
        );
      }
      const resolvedAncestorFuncIdx = session.resolveCurrentIndex(
        aliasOf,
        "function",
        irCallableBindingKey(ancestorRef.binding),
      );
      const resolvedAncestorFunc = definedFuncAt(this.ctx, resolvedAncestorFuncIdx);
      if (resolvedAncestorFunc !== ancestorFunc || resolvedAncestorFunc !== childFunc) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${childPhysicalName} resolves structurally to slot ${resolvedAncestorFuncIdx}, not exact ancestor ${terminal.id}`,
        );
      }

      const bindingId = planProgramAbiSupportCallableAlias(this.ctx, {
        ref,
        anchor: { kind: "class", classId },
        role,
        roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classMethodAdapter,
        derivedOrdinal,
        aliasOf,
        signature,
      });
      if (bindingId !== ref.binding.bindingId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: inherited class ${memberKind} ${classId} / ${memberName} was not accepted as a Program ABI alias`,
        );
      }
      return ref;
    }
    return null;
  }

  /** Resolve the AST-free allocator wrapper owned by the exact class. */
  private constructorRef(classId: IrClassId, physicalName: string): IrFuncRef {
    return this.supportRef(
      classId,
      "class-constructor-new",
      PROGRAM_ABI_CALLABLE_ROLE.classConstructorNew,
      physicalName,
    );
  }

  /** Resolve the source-owned `<Class>_init`. */
  private initRef(shape: IrClassShape, classId: IrClassId, physicalName: string): IrFuncRef {
    const target = shape.constructorInitTarget;
    if (target?.binding.kind === "unit") {
      const funcIdx = this.unitFuncIdx(target.binding.unitId, physicalName);
      if (funcIdx === undefined) {
        throw new IrInvariantError(
          "missing-function-slot",
          "resolve",
          `ir/integration: class constructor init ${target.binding.unitId} / ${physicalName} has no registered slot`,
        );
      }
      this.bindUnitCallableSlot(target, funcIdx, physicalName);
      return target;
    }
    throw new IrInvariantError(
      "missing-function-slot",
      "resolve",
      `ir/integration: class constructor init ${classId} / ${physicalName} has no exact source-unit target`,
    );
  }

  private supportRef(classId: IrClassId, role: string, roleOrdinal: number, physicalName: string): IrFuncRef {
    const ref = irSupportFuncRef(classId, role, physicalName);
    const bindingId = ref.binding.kind === "support" ? ref.binding.bindingId : undefined;
    const funcIdx =
      (bindingId === undefined ? undefined : this.ctx.programAbiClassCallables?.handleForSupport(bindingId)) ??
      (this.ctx.programAbiClassCallables ? undefined : this.ctx.funcMap.get(physicalName));
    const func = funcIdx === undefined ? undefined : definedFuncAt(this.ctx, funcIdx);
    if (!func || func.name !== physicalName) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `ir/integration: class ${classId} has no exact defined ${role} slot ${physicalName}`,
      );
    }
    const signature = this.ctx.mod.types[func.typeIdx];
    if (!signature || signature.kind !== "func") {
      throw new IrInvariantError(
        "abi-type-index-mismatch",
        "resolve",
        `ir/integration: class ${classId} / ${physicalName} has non-function type ${func.typeIdx}`,
      );
    }
    planProgramAbiSupportCallable(this.ctx, {
      ref,
      anchor: { kind: "class", classId },
      role,
      roleOrdinal,
      signature,
      func,
    });
    return ref;
  }

  resolve(shape: IrClassShape): IrClassLowering | null {
    const classId = this.exactClassId(shape);
    const cached = this.cache.get(classId);
    if (cached) return cached;

    // Builtin-backed subclasses (including the JS-host Promise onhost lane)
    // have no WasmGC source-owned `<Class>_init` callable and remain outside this
    // structural class ABI slice.
    if (this.ctx.classExternrefBackedSet.has(shape.className)) return null;

    const classLayout = this.ctx.programAbiTypes?.layoutForClass(classId);
    const structTypeIdx =
      classLayout?.typeIdx ?? (this.ctx.programAbiTypes ? undefined : this.ctx.structMap.get(shape.className));
    if (structTypeIdx === undefined) return null;
    const layoutFields =
      classLayout?.type.fields ?? (this.ctx.programAbiTypes ? undefined : this.ctx.structFields.get(shape.className));
    if (!layoutFields) return null;

    // Derive field indices from the exact allocator layout. This includes the
    // legacy `__tag` prefix and every inherited field before own source fields.
    const fieldIdxByName = new Map<string, number>();
    for (let i = 0; i < layoutFields.length; i++) {
      fieldIdxByName.set(layoutFields[i]!.name, i);
    }

    // (#1983) Route synthetic class-member names through `classMemberFuncKey`
    // so the IR backend resolves the SAME (possibly relocated) funcMap key the
    // legacy pass registered. Without this, a class whose `${className}_new` /
    // `${className}_${method}` key collided with a user function resolves to the
    // user function's funcIdx (wrong signature → validation trap). Identical to
    // the legacy name for every non-colliding class.
    const ctx = this.ctx;
    const constructorFuncName = classMemberFuncKey(ctx, `${shape.className}_new`);
    // #3000-E: the parent-init entry a derived `super(...)` chains to. Legacy
    // registers `<className>_init` for every non-externref-backed class (the
    // only kind that can be an IR subclass parent), keyed the same way.
    const initFuncName = classMemberFuncKey(ctx, `${shape.className}_init`);
    const constructorFunc = this.constructorRef(classId, constructorFuncName);
    const initFunc = this.initRef(shape, classId, initFuncName);

    // (#3144) instanceof-compatible tags: own tag + every transitive
    // descendant's. Mirrors legacy `collectInstanceOfTags` (typeof-delete.ts)
    // exactly — the walk finds children via `classParentMap` (child → parent)
    // so `class.instanceof` compares the identical set `compileInstanceOf`
    // emits. Empty when the class has no tag (lowering folds to false).
    const collectTags = (className: string, seen: Set<string>): number[] => {
      if (seen.has(className)) return []; // circular-inheritance guard
      seen.add(className);
      const ownTag = ctx.classTagMap.get(className);
      if (ownTag === undefined) return [];
      const tags = [ownTag];
      for (const [child, parent] of ctx.classParentMap) {
        if (parent === className) tags.push(...collectTags(child, seen));
      }
      return tags;
    };
    const instanceOfTags = collectTags(shape.className, new Set());

    const lowering: IrClassLowering = {
      structTypeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: class ${shape.className} has no field "${name}"`);
        }
        return idx;
      },
      constructorFunc,
      initFunc,
      instanceOfTags,
      memberFunc: (memberKind: IrClassMemberKind, name: string, target?: IrFuncRef): IrFuncRef => {
        const preparedTarget = this.preparedMemberTarget(target);
        if (preparedTarget) return preparedTarget;
        const suffix = memberKind === "getter" ? `get_${name}` : memberKind === "setter" ? `set_${name}` : name;
        const legacyName = `${shape.className}_${suffix}`;
        const physicalName = classMemberFuncKey(ctx, legacyName);
        const exact =
          this.memberRef(classId, memberKind, legacyName, physicalName) ??
          this.inheritedMemberRef(shape, classId, memberKind, name, physicalName);
        if (exact) return exact;
        if (!ctx.programAbiSession) {
          return irSupportFuncRef(classId, `class-member-adapter:${memberKind}:${name}`, physicalName);
        }
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ir/integration: class ${memberKind} ${classId} / ${name} has no exact source or inherited ABI owner`,
        );
      },
    };
    this.cache.set(classId, lowering);
    return lowering;
  }
}
