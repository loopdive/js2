// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import { registerAnnexBGlobalLiveBindings } from "./annexb-global-live-binding.js";
import { exactClassExpressionTypeName } from "./class-expression-identity.js";
import { emitToBoolean } from "./coercion-engine.js";
import {
  emitNativeErrorBoundaryBridge,
  emitWasiErrorConstructor,
  fillExternGetErrorProps,
} from "./registry/error-types.js";
import { analyzeLinearUint8 } from "./linear-uint8-analysis.js";
import { analyzeFnctorEscapeGate, deriveFnctorFields } from "./fnctor-escape-gate.js";
import { resolveFnctorInstanceType } from "./fnctor-typed-instances.js";
import { resolveFnctorTypedBindingType } from "./fnctor-typed-bindings.js";
import { isLinearU8RepresentableNew } from "./linear-uint8-signatures.js";
import { definedFuncAt, isImportFuncIdx, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import { fillHostFnctorMethodDrivers, maxHostFnctorMethodArity } from "./host-fnctor-method-driver.js";
import { fillNativeConstructDrivers, maxReservedNativeConstructArity } from "./native-construct.js";
import { fillConstructBoundDriver } from "./construct-bound.js"; // (#4196)
import { fillRuntimeEvalConstructDriver } from "./runtime-eval-construct.js"; // (#4438)
import { emitVecDefineWritebackExports } from "./vec-define-writeback.js"; // (#3116)
import { detectArrayReduceFusion } from "./array-reduce-fusion.js";
import { finalizeModuleValueCaches } from "./module-value-caches.js"; // (#4150/#4157)
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import type { TypeFact } from "../checker/oracle.js";
import {
  isBigIntType,
  isBooleanType,
  isExternalDeclaredClass,
  isHeterogeneousPrimitiveUnion,
  isHeterogeneousUnion,
  isNullablePrimitiveType,
  isNumberType,
  isNumberWrapperType,
  isStringType,
  isStringWrapperType,
  isVoidType,
  mapTsTypeToWasm,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { irSupportFuncRef, irUnitFuncRef } from "../ir/callable-bindings.js";
import { irSupportGlobalRef } from "../ir/abi-bindings.js";
import { compileIrPathFunctions, type IrIntegrationError, type IrIntegrationReport } from "../ir/integration.js";
import {
  asVal,
  IR_CLASS_SHAPE_CELL,
  irDynamic,
  isDynamic,
  irVal,
  irVec,
  type IrClassMethodDescriptor,
  type IrFuncRef,
  type IrType,
} from "../ir/nodes.js";
import type { LatticeType } from "../ir/propagate.js";
import {
  classifyIrFailure,
  IrInvariantError,
  IrUnsupportedError,
  type IrObservedOutcome,
  type IrPreparationFailure,
  type IrPreparationStage,
  type IrUnsupportedCode,
} from "../ir/outcomes.js";
import {
  effectiveIrParamTypeNode,
  effectiveIrReturnTypeNode,
  irClosureSignatureFromFunctionTypeNode,
  type IrFallbackReason,
  type IrSelection,
} from "../ir/select.js";
import type {
  IrHostDateGetterLoweringPlan,
  IrHostDateSnapshotLoweringPlan,
  IrHostVoidCallbackLoweringPlan,
  IrImportedCallLoweringPlan,
  IrTopLevelFunctionValueLoweringPlan,
} from "../ir/ast-lowering-plans.js";
import { makeIrAmbientClassCallResolver, makeIrHostGlobalResolver } from "../ir/host-extern.js"; // (#2856/#3214/#3657)
import {
  projectIrBackendTargetProfile,
  supportsIrBackendTargetCapability,
  type IrBackendTargetCapability,
} from "../ir/backend/legality.js";
import { collectModuleInitPopulation, MODULE_INIT_UNIT_NAME } from "../ir/module-init.js";
import { isBoundedPreparedAccessorClass } from "../ir/class-accessor-safety.js";
import {
  buildIrModuleInitPlan,
  reconcileIrModuleInitPlan,
  type IrModuleInitInvocationKind,
  type IrModuleInitPlanningEvidence,
} from "../ir/module-init-plan.js";
import { buildIrRuntimeEvalBoundaryPlan, type IrRuntimeEvalBoundaryPlan } from "../ir/runtime-eval-boundary-plan.js";
import {
  buildIrUnitInventory,
  type BuildIrUnitInventoryOptions,
  type IrBindingId,
  type IrClassId,
  type IrUnitKind,
  type IrUnitId,
} from "../ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "../ir/planning-identity.js";
import { makeIrPromiseDelayResolver } from "../ir/promise-delay.js";
import { containsStringBuilderLoopShape } from "../ir/string-builder-shape.js";
import {
  buildIrPromiseDelayLoweringPlans,
  collectIrPromiseDelayOwners,
  type IrPromiseDelayLoweringPlans,
} from "../ir/promise-delay-lowering.js";
import {
  makeIrArrayExpressionPredicate,
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrLocalClassExpressionResolver,
  makeIrModuleBindingResolver,
  makeIrPrimitiveExpressionClassifier,
  makeIrRegExpExpressionPredicate,
  type IrModuleBindingResolver,
} from "../ir/module-bindings.js"; // (#2856 Capability C)
import {
  collectPreparedIrAsyncOwners,
  prepareIrAsyncSelectionOptions,
  registerIrAsyncPromiseDelayResolver,
} from "./async-ir-planning.js";
import { unwrapPromiseTypeNode } from "../ir/async-static.js"; // (#1373b C-1)
import { createCodegenContext } from "./context/create-context.js";
import { ProgramAbiSession, type PublishedProgramAbi } from "./program-abi-session.js";
import { stripHostBridgeExports } from "./host-bridge-exports.js";
import { eliminateDeadLayoutAndPlanProgramAbi } from "./program-abi-finalization.js";
import { emitDataStructHostBridgeManifest } from "./data-struct-host-bridge.js";
import { planProgramAbiFunctionValue, planProgramAbiGlobal, PROGRAM_ABI_GLOBAL_ROLE } from "./program-abi-planning.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import { planIrImportedCalls, recordIrOverlayPreparationFailure } from "./ir-imported-call-planning.js";
import { hasFullyAnnotatedScalarAbi } from "./ir-legacy-caller-abi.js";
import {
  canPrepareHostDateSnapshotLoweringByIdentity,
  closeIrBlockedComponentByIdentity,
  hasExactCurrentEnvFunctionImportManifest,
  hasExactHostVoidCallbackMakerImport,
  prepareHostVoidCallbackLoweringByIdentity,
  preparePromiseDelayLoweringByIdentity,
  type IrHostDateSnapshotImportPlan,
} from "./ir-overlay-finalize.js";
import {
  applyIrFinalContextFunctionUnitIds,
  finalizePreparedIrSelection,
  prepareHostDateSnapshotPreflight,
  synchronizeIrSafeFunctionSelection,
} from "./ir-overlay-preparation.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import {
  auditIrSkippedClassMemberSlots,
  auditIrSkippedFunctionSlots,
  auditIrSkippedModuleInitSlot,
  buildWholeSourceFailureOutcomes,
  reconcileIrOverlayOutcomes,
} from "./ir-overlay-outcomes.js";
import {
  collectIrClassShapeDeclarations,
  createIrClassShapeSidecar,
  orderIrClassShapeDeclarationsForProjection,
  projectIrClassCallableTarget,
  resolveIrClassShapeFromType,
  resolveIrClassShapeFromTypeReference,
  resolveIrParentClassId,
  type IrClassShapeEntry,
  type IrClassShapeLookup,
  type IrClassShapeSidecar,
} from "./ir-class-shapes.js";
import {
  buildIrExactFunctionClaimIndex,
  buildIrRequestedFunctionSkipProjection,
  correlateIrSkippedBodyNames,
  correlateIrSkippedBodyUnitIds,
  correlateIrSkippedFunctionNames,
  type IrExactFunctionClaim,
} from "./ir-overlay-safety.js";
import {
  collectDirectCallerActivationTargetUnitIds,
  completePreparedIrIntegration,
  collectPreparedTopLevelFunctionValueTargetUnitIds,
  computePreparedInheritedIrFirstSkipUnitIds,
  finalizeR3PreparedOwnerPopulation,
  prepareIrBodies,
  selectR2PreparedOwnerComponents,
  selectR3PreparedPromiseDelayFunctions,
  selectPreparedClassMemberUnitIds,
  type PreparedIrClassMemberBodies,
  type PreparedIrFreeFunctionBodies,
  type PreparedIrModuleInitBody,
} from "./ir-prepared-free-functions.js";
import {
  assertMultiPreparedFunctionValueLeafRouteCurrent,
  assertMultiPreparedScalarLeafRouteCurrent,
  buildMultiIrGraphSafety,
  collectMultiIrFunctionNameCollisions,
  compileMultiPreparedScalarLeafDeclarations,
  planEarlyMultiPreparedScalarLeafRoute,
  type EarlyMultiPreparedScalarLeafState,
  type MultiPreparedFunctionValueSupportReceipt,
  type MultiPreparedScalarLeafGraphSafety,
} from "./multi-prepared-scalar-leaf.js";
import {
  assertMultiPreparedFibonacciPairRouteCurrent,
  planEarlyMultiPreparedFunctionValueRoutes,
} from "./multi-prepared-fibonacci-pair.js";
import * as irTimerShim from "./ir-timer-shim-planning.js";
import { buildLeakedHostImportError, scanForLeakedHostImports } from "./host-import-allowlist.js";
import {
  hasCertifiedStandaloneClockCapabilityProvider,
  isValidatedPlatformCapabilityImport,
} from "../capability-registry.js";
import { isDomCapabilityImportName, isDomInteractionImportName } from "../dom-capability-contract.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type {
  ClosureInfo,
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  ExternClassInfo,
  FunctionContext,
  OptionalParamInfo,
  RestParamInfo,
} from "./context/types.js";
import type { NodeBuiltinImport } from "../import-resolver.js";
import { ensureMapRuntimeTypes } from "./map-runtime.js";
import { scanForNewTarget } from "./new-target.js"; // (#2023)
import { scanForDynamicProto, fillDynamicProtoHelpers } from "./dynamic-proto.js"; // (#802)
import { scanForArrayHoles, ensureHoleType } from "./array-holes.js"; // (#2001 S1)
import {
  hoistedVarRetypesToConcreteRef,
  inferArrayVecType,
  inferTaViewType,
  usageInferredLocalType,
} from "./statements/variables.js"; // (#2106 S1 PR-2) hoist undefined-init retype predicate; (#684) usage-based any-local f64 override
import {
  bindingHasMixedAssignmentCarrier,
  numericProofOverridesMixedCarrier,
  widenedCarrierOracleFor,
} from "./analysis/mixed-assignment-carrier.js";
import { symbolBrand } from "./symbol-field-carrier.js";
import { ensureDynReadHelpers, ensureDynMemberGet } from "./dyn-read.js"; // (#2580 M0) / (#3053 U0)
import { collectClosureBaseWrapperTypeIdxs, buildClosureRefTestArms } from "./closure-classifier.js"; // (#2175 V2-S1)
import {
  ensureRuntimeEvalAotCallableCarrierTypes,
  fillRuntimeEvalCallablePropertyGetArm,
} from "./runtime-eval-callable.js";
import { ensureNativeIteratorRuntime, fillNativeIteratorLateArms } from "./iterator-native.js";
import { emitResizableAbExports } from "./dataview-native.js"; // (#3058)
import { fillCombinatorToVec } from "./promise-combinators.js"; // (#2922) dynamic combinator-arg drain fill
import { fillClosedMethodDispatch, fillPromiseThenableHelpers } from "./closed-method-dispatch.js";
import { fillDirectCallTrampolines } from "./typed-this.js"; // (#3683 S3) direct-call trampoline fill
import { fillSetRecFieldGetters } from "./collections-es2025.js"; // (#3172)
import { fillIterHofSteppers } from "./iter-hof-native.js"; // (#2903)
import { fillLazyIterLadderArms } from "./iter-lazy-native.js"; // (#2903 R3)
import { fillMemberSetDispatch, reserveVecFieldMaterializers } from "./member-set-dispatch.js";
import { reserveColdTailAllocators } from "./fnctor-cold-tail.js"; // (#3927) hot/cold fnctor split
import { fillClosedStructExternSetArms } from "./closed-struct-extern-set.js"; // (#4194) computed-write arms
import { reserveFnctorResidAllocators } from "./fnctor-layout-emit.js"; // (#3927) per-type layouts
import { fillMemberGetDispatch, fillTypedMemberGetF64Dispatch } from "./member-get-dispatch.js";
import { fuseBoxBooleanSinks } from "./box-boolean-fuse.js"; // (#4157) unboxed boolean fusion, default OFF
import { inlineIsTruthyCallSites } from "./is-truthy-inline-ic.js"; // (#4157) ToBoolean call-site fast path
import { inlineMemberGetCallSites } from "./member-get-inline-ic.js"; // (#4157) call-site inline cache
import { fillFusedToNumber } from "./tonumber-fast-paths.js"; // (#4157) flag-gated, default ON
import { fillTypedMemberSetF64Dispatch } from "./member-set-f64.js"; // (#4157 A) write-side f64 twin
import { emitUndefined, ensureGetUndefined, reconcileNativeStrFinalizeShift } from "./expressions/late-imports.js";
import { fillProtoIteratorDriver } from "./expressions/proto-override.js";
import { CALL_ACCESSOR_GET, fillAccessorDrivers } from "./accessor-driver.js";
import { fillDisposableStackDisposeDriver } from "./disposable-runtime.js";
import {
  collectGlobalObjectPropertyNames,
  recordSloppyImplicitGlobalNames,
  recordScriptGlobalLexicalBindingNames,
  recordScriptVarBindingNames,
  sourceContainsClass,
  scanModuleMemberDeletes,
  sourceHasDynamicTaConstruct,
  sourceContainsBindingPattern,
  sourceOverridesArrayIterator,
} from "./source-scan-predicates.js"; // (#3104) whole-program AST pre-scan predicates
// Re-exported for existing external consumers (e.g. tests/issue-1719-s1.test.ts).
export { sourceOverridesArrayIterator } from "./source-scan-predicates.js";
import {
  fillApplyClosure,
  fillBindDynHelper,
  fillBuiltinFnMeta,
  fillClosedStructEnumerationArms,
  fillClosedStructExternGetArms,
  fillClosedStructHasOwnArms,
  fillClosedStructOwnPropertyNamesArms,
  fillDynamicForinVecArms,
  fillExternArrayLikeStructArms,
  fillExternGetIdxVecArms,
  fillExternSetVecArms,
  fillFnctorPrototypeDispatchArms,
  fillExternIsArray,
  fillProxyDispatch,
  unshiftExternGetProtoCacheArm,
  unshiftExternGetWrapperCtorArm,
} from "./object-runtime.js";
import { fillVecLengthDynamicArms } from "./vec-length-set.js";
import { fillTaCtorGetMetaArm } from "./ta-ctor-meta.js"; // `$__ta_ctor` name/length meta arm
import { moduleMentionsObjectIdentifier, moduleReadsConstructorProp } from "./wrapper-constructor-carrier.js"; // (#4223/#4232)
import { unshiftNativeProtoHasOwnArms } from "./native-proto-own-props.js"; // (#4248) builtin-proto own members
import { unshiftRegExpAccessorSetGuard } from "./regexp-accessor-set-guard.js"; // (#2875 w4-F)
import { unshiftNativeProtoDeleteArm } from "./native-proto-delete.js"; // (#2875 w4-F)
import { unshiftNativeProtoToPrimitiveArm } from "./native-proto-wrapper-primitive.js"; // (#4248) proto [[PrimitiveValue]]
import { unshiftExternGetProtoMethodArm } from "./native-proto-instance-method-read.js"; // (#4248) inherited method value
import { fillClosurePropHelpers } from "./closure-props.js"; // (#3468 C-core) closure-own-property side table
import { fillClosurePrototypeEdge } from "./closure-prototype-edge.js"; // (#2660 M3) function-value → prototype-object edge
import { fillInstanceTombstones } from "./instance-tombstones.js"; // (#4098 G1 s1) per-instance own-property deletability
import { fillFunctionInstanceProps } from "./function-instance-props.js"; // (#4436) user-closure `length` own property
import { fillInstanceProps } from "./instance-props.js"; // (#4194) instance expando bag substrate
import { fillErrorPropHelpers } from "./error-props.js"; // (#4098) native Error `$props` shared MOP
import { fillVecPropHelpers } from "./vec-props.js"; // (#3537) array ($Vec) expando side table
import { fillProtoIndexStore } from "./proto-index-store.js"; // (#4160) prototype-index companions
import { fillHoleyArrayHasIdxArm } from "./holey-array-presence.js"; // (#4222) nominal sparse carrier
import { finalizeFunctionPoisonPillCalls } from "./function-poison-pill.js";
import { fillDataViewConstructProtoArm, fillTaDynViewMopArms } from "./ta-dyn-mop.js"; // (#3177/#3371) native view prototype arms
import { fillObjVecReflectionHelpers } from "./objvec-array-proto.js"; // (#3666) RegExp indices Array reflection
import { fillReflectIsConstructor } from "./reflect-construct-native.js";
import { fillArrayToPrimitive } from "./array-to-primitive.js";
import { fillClassToPrimitive } from "./class-to-primitive.js";
import {
  fixupExternConvertAny,
  fixupStructNewArgCounts,
  fixupStructNewResultCoercion,
  markLeafStructsFinal,
  repairStructTypeMismatches,
} from "./fixups.js";
import { emitInlineMathFunctions } from "./math-helpers.js";
import { ensureFuncClosureSingleton, finalizeMethodTrampolines, getFuncRefWrapperRootTypeIdx } from "./closures.js";
import { peepholeOptimize } from "./peephole.js";
import { repairCrossHierarchyOperands } from "./cross-hierarchy-operands.js"; // (#4157 park 6)
import { installAllocCensus } from "./alloc-census.js"; // (#3921) per-type allocation census
import { installExecCensus } from "./exec-census.js"; // (#4157) deterministic executed-call counts
import { inlineUserFunctions } from "./ir-inline.js"; // (#4157) IR-level inliner for user code
import { inlineExternGetCallSites } from "./extern-get-inline-ic.js"; // (#4157) __extern_get static-name IC
import { inlineMemberSetCallSites } from "./member-set-inline-ic.js"; // (#4157) write-side member IC
import { inlineCallDispatchSites } from "./call-dispatch-ic.js"; // (#4157) __call_m_* devirtualization
import { inlineFlatStrCallSites } from "./flat-str-ic.js"; // (#4157) __str_flatten/__str_equals call-site fast paths
import { brandCollidingShapeTypes } from "./shape-brand.js";
import {
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  nextModuleGlobalIdx,
  // #808 — moved to registry/imports.ts; imported back for index.ts's own callers.
  addStringImports,
  addUnionImports,
  collectAllSourceImports,
  collectUsedExternImports,
} from "./registry/imports.js";
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterSubviewType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import {
  enableStdinReactor,
  ensureTimerHeap,
  exportDrainMicrotasksIfRegistered,
  exportPromiseBoundaryIfRegistered,
  getDrainFuncIdxForWasiStart,
  getRunLoopFuncIdxForWasiStart,
  shiftAsyncSideChannelFuncIdxs,
} from "./async-scheduler.js";
import { ensureUnhandledRejectionReporter } from "./unhandled-rejection.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { inLiveShiftRange } from "../emit/resolve-layout.js"; // (#1916 S3) stable handles never shift
import { profileCount, profilePhase } from "../compile-profile.js";
import { frameSnapshotAtCompile } from "./function-body.js";
import { describeInternalError } from "./internal-error.js";
import {
  brandExternMethodResult,
  ensureLateImport,
  flushLateImportShifts,
  registerAddStringImports,
  registerAddUnionImports,
} from "./shared.js";
import {
  stackBalance,
  getFixupEvents,
  summarizeFixups,
  strictBalanceDiagnostics,
  callArgCoercionInstrs,
} from "./stack-balance.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureRegexMatchVecType } from "./native-regex.js";
import { STANDALONE_REGEXP_REFLECTION_PROPS } from "./regexp-standalone.js";
import { ensureVecElemSet, ensureVecNewSized } from "./vec-elem-set.js";

// ── Extracted sub-modules ──────────────────────────────────────────────────
import {
  buildIsUndefinedExternBody,
  emitWrapperValueOfFunctions,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  ensureAnyToExternHelper,
  ensureAnyValueType,
  ensureWrapperTypes,
  isAnyValue,
  undefinedSingletonActive,
} from "./any-helpers.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
import {
  buildShapePropFlagsTable,
  collectClassDeclaration,
  collectDeclaredFuncRefs,
  compileClassBodies,
  resolveClassMemberName,
} from "./class-bodies.js";
import { finalizeForwardClassCallableAbis } from "./class-callable-abi.js";
import { finalizeForwardClassFieldLayouts } from "./class-field-layout.js";
import { classMemberFuncKey, fnctorAncestorOfClass, moduleHasFnctorSubclass } from "./class-member-keys.js"; // (#1983 / #3123)
import {
  applyShapeInference,
  collectDeclarations,
  collectDynamicObjectReturnCarrierTypes,
  inferImplicitAnyParamType,
  inferNumericReturnTypes,
  inferBindingAwareNumericReturnTypes,
  bindingAwareNumericCallEvidence,
  collectEmptyObjectWidening,
  collectObjectLiteralAssignedPropertyNames,
  collectGrowableObjectLiterals,
  createUnifiedCollectorState,
  finalizeUnifiedCollector,
  functionReturnsDynamicObjectCarrier,
  preallocateModuleInitCallable,
  unifiedVisitNode,
} from "./declarations.js";
import { compileDeclarations } from "./audited-declarations.js";
import { snapshotLegacyBodyAudit } from "./legacy-body-audit.js";
import type { ModuleInitMode } from "./declarations.js";
import { prepareModuleTdzGlobals } from "./module-global-registration.js";
import { hoistedVarPreInitValueIsObserved } from "./declarations/hoisted-var-preinit-read.js";
import { inferParamTypeFromCallSites } from "./declarations/param-return-inference.js";
import {
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
} from "./destructuring-params.js";
import {
  emitExceptionRenderExports,
  emitStdoutSinkExports,
  emitTestRuntimeStringHelpers,
  ensureAnyToStringHelper,
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureStandaloneStdoutSink,
  flatStringType,
  nativeStringType,
  nativeStringTypeNullable,
  standaloneConsoleSinkAvailable,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitStandaloneDomStringBoundary } from "./dom-string-boundary.js";
import { irNativeNumberToFixedAvailable, irNativeNumberToStringAvailable } from "./number-format-native.js"; // #4462/#4576
import { emitJsonQuoteString } from "./json-runtime.js";
import { isSyntheticStructName, exportFunc } from "./emit-helpers.js"; // (#3272) DRY helpers
import {
  hasExportModifier,
  hasDeclareModifier,
  hasAsyncModifier,
  hasAbstractModifier,
  hasStaticModifier,
  isGeneratorFunction,
} from "./ast-modifiers.js"; // (#3272) extracted verbatim
import {
  LINEAR_U8_ARENA_START,
  reserveLinearU8AllocType,
  reserveTypedArraySubviewTypes,
  reserveObjVecArrType,
  reserveFnctorStructTypes,
  ensureLinearU8AllocHelper,
} from "./linear-type-reservations.js"; // (#3272) extracted verbatim
import {
  reserveVecMethodHelper,
  emitVecAccessExports,
  finalizeVecHostBridgeExports,
  emitVecSetByteExport,
  emitNewVecF64Export,
  emitDataViewByteExports,
} from "./vec-access-exports.js"; // (#3272) extracted verbatim
import {
  emitClosureCallExport,
  publishStandaloneTimerCallbackDispatch,
  emitClosureCallExport1,
  emitClosureCallExport2,
  emitClosureCallExport3,
  emitClosureCallExport4,
  emitClosureMethodCallExportN,
  emitIsClosureExport,
  emitClosureArityExport,
  emitClosureHasRestExport,
  emitIsDataStructExport,
  fillStandaloneTypeofClosureArms,
} from "./closure-exports.js"; // (#3272) extracted verbatim
import {
  hasReservedStandaloneDomCallbackDispatch,
  reserveStandaloneDomCallbackDispatch,
} from "./standalone-dom-callback-authority.js";
import {
  collectIrCalendarLoweringPlans,
  planIrCalendarResolvers,
  planMultiCalendar,
  planSingleSourceStandaloneCalendar,
  planStandaloneDomCapability,
} from "./calendar-codegen-planning.js";
import { emitDateHostBridge } from "./date-host-bridge.js";
import {
  emitStructFieldGetters,
  emitStructFieldBooleanMarkers,
  emitStructFieldPresenceGetters,
  emitStructFieldSetters,
  resolveSameShapeFieldNameCollisions,
} from "./struct-field-exports.js"; // (#3272) extracted verbatim
import { analyzeBooleanPropertyNames, recoverBooleanStructFieldBrands } from "./struct-field-boolean-brand.js";
import {
  analyzeNumericPropertyNames,
  applyNumericPropertyAnalysis,
  refineNumericLocalsWithCallReturns,
} from "./numeric-property-analysis.js"; // (#3683 S4a)
import type { NumericPropertyAnalysisHost } from "./numeric-property-analysis.js";
import { collectUserMethodNames } from "./user-method-names.js"; // (#3673)
import {
  registerWasiImports,
  emitDeferredWasiHelpers,
  ensureWasiStartExnPrinter,
  ensureWasiFdWriteAllHelper,
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteAnyStringFdHelper,
  ensureWasiWriteUint8ArrayHelper,
  ensureWasiWriteArrayBufferHelper,
  WASI_STDIN_BUF_START,
  WASI_WRITE_SCRATCH_START,
  WASI_FD_WRITE_MAX_CHUNK,
  WASI_READSYNC_IOV_OFFSET,
  WASI_READSYNC_NREAD_OFFSET,
} from "./wasi.js"; // (#3272) extracted verbatim
import {
  registerBuiltinExternClasses,
  getPseudoExternClassInfo,
  resolveMethodDispatchTarget,
  collectReferencedGlobalNames,
  collectExternDeclarations,
  collectDeclaredGlobals,
  registerNodeBuiltinImports,
  registerJsxRuntimeImports,
  sourceUsesLibGlobals,
  checkWasiDomUsage,
  rejectTimersUnderWasi,
  collectEnumDeclarations,
} from "./extern-declarations.js"; // (#3272) extracted verbatim
import { buildLibDeclIndex } from "./lib-decl-index.js"; // (#4218) syntactic lib walk
import { typeIsForeignReturnFnctorInstance } from "./fnctor-foreign-return.js"; // (#2071)

// ── Re-exports for public API compatibility ─────────────────────────────────
export {
  hasExportModifier,
  hasDeclareModifier,
  hasAsyncModifier,
  hasAbstractModifier,
  hasStaticModifier,
  isGeneratorFunction,
  reserveLinearU8AllocType,
  reserveTypedArraySubviewTypes,
  reserveObjVecArrType,
  reserveFnctorStructTypes,
  ensureLinearU8AllocHelper,
  reserveVecMethodHelper,
  emitDeferredWasiHelpers,
  ensureWasiFdWriteAllHelper,
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteAnyStringFdHelper,
  ensureWasiWriteUint8ArrayHelper,
  ensureWasiWriteArrayBufferHelper,
  WASI_STDIN_BUF_START,
  WASI_WRITE_SCRATCH_START,
  WASI_FD_WRITE_MAX_CHUNK,
  WASI_READSYNC_IOV_OFFSET,
  WASI_READSYNC_NREAD_OFFSET,
  registerBuiltinExternClasses,
  getPseudoExternClassInfo,
  resolveMethodDispatchTarget,
  collectEnumDeclarations,
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  ensureAnyToExternHelper,
  ensureAnyValueType,
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureWrapperTypes,
  flatStringType,
  isAnyValue,
  nativeStringType,
  nativeStringTypeNullable,
};
function projectClassCallableTarget(
  ctx: CodegenContext,
  identityContext: IrPlanningIdentityContext,
  classId: IrClassId,
  declaration: ts.Node,
  expectedKind: IrUnitKind,
  legacyName: string,
): IrFuncRef | undefined {
  return projectIrClassCallableTarget(
    identityContext,
    classId,
    declaration,
    expectedKind,
    classMemberFuncKey(ctx, legacyName),
  );
}

/**
 * Report a codegen error with source location extracted from an AST node.
 * Pushes the error into ctx.errors so it can be propagated to the caller.
 */
/**
 * Extract a compile-time constant from a parameter initializer (#869).
 * Returns the constant default info if the initializer is a numeric/boolean literal,
 * undefined/null, or a unary minus on a numeric literal. Returns undefined otherwise.
 */
/**
 * TypedArray constructor names. Most still lower to `(ref null $Vec[f64])`;
 * native Uint8Array lowers to packed byte storage.
 */
export const TYPED_ARRAY_NAMES: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
]);

function typedArrayNameFromTypeNode(node: ts.TypeNode): string | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  return TYPED_ARRAY_NAMES.has(node.typeName.text) ? node.typeName.text : null;
}

// (#2593) Per-view packed storage for the integer typed arrays under
// standalone/WASI. A width-matched packed element type makes `array.set` truncate
// to the view's width (ToInt8/ToUint16/… for free) and `array.get_s`/`get_u`
// sign/zero-extend on read. Before #2593 only `Uint8Array` was packed (i8); every
// other integer view fell through to f64, which stored the full double with no
// width truncation. Float views stay f64. Host/gc mode stays f64 for all but
// Uint8Array — the JS-host marshalling boundary already classifies non-Uint8
// typed arrays as `number[]`-on-return; packing host-side risks that boundary and
// is deferred (#2593 note). The packed map is gated on `ctx.wasi || ctx.standalone`.
const TYPED_ARRAY_PACKED_STORAGE: Readonly<Record<string, { key: string; type: ValType }>> = {
  Int8Array: { key: "i8_byte", type: { kind: "i8" } },
  Uint8Array: { key: "i8_byte", type: { kind: "i8" } },
  Uint8ClampedArray: { key: "i8_byte", type: { kind: "i8" } },
  Int16Array: { key: "i16_byte", type: { kind: "i16" } },
  Uint16Array: { key: "i16_byte", type: { kind: "i16" } },
  // (#2835) Int32/Uint32 ELEMENT storage uses a DEDICATED `i32_elem` vec key —
  // SPLIT from the `i32_byte` key that backs the ArrayBuffer/DataView BYTE buffer.
  // Both shapes are `struct { length: i32, data: array(mut i32) }` today (PR-1 is a
  // pure refactor, no rep change), but they are semantically distinct: an
  // `i32_elem` slot holds a full 32-bit element, an `i32_byte` slot holds one byte
  // (0..255). Keeping them as one type blocked #2835 PR-2 from packing the byte
  // buffer to `array(mut i8)` — that would truncate every Int32/Uint32 element.
  // The split isolates the byte-buffer rep so PR-2 can repack `i32_byte` → i8 safely.
  Int32Array: { key: "i32_elem", type: { kind: "i32" } },
  Uint32Array: { key: "i32_elem", type: { kind: "i32" } },
};

/**
 * (#838) The two BigInt typed-array views. Unlike the numeric views these can
 * NOT fall back to `f64` element storage — an f64 cannot hold an arbitrary
 * 64-bit BigInt. They always use a dedicated `i64` element vec in BOTH the
 * host/gc and standalone/WASI lanes (BigInt is represented as a first-class
 * `{ kind: "i64", bigint: true }` value throughout the compiler, so `array.get`/
 * `array.set` on the i64 backing array need no packing/unpacking). `BigInt64Array`
 * stores signed 64-bit two's-complement; `BigUint64Array` stores the same 64 raw
 * bits interpreted unsigned — the wasm i64 element holds identical bits either
 * way (ToBigInt64/ToBigUint64 both reduce mod 2^64, which i64 arithmetic already
 * does), so both map to the same `i64` storage.
 */
export const BIGINT_TYPED_ARRAY_NAMES: ReadonlySet<string> = new Set(["BigInt64Array", "BigUint64Array"]);

export function typedArrayVecStorage(ctx: CodegenContext, name: string): { key: string; type: ValType } {
  // (#838) BigInt views always use i64 storage, independent of target mode —
  // f64 cannot represent a 64-bit BigInt.
  if (BIGINT_TYPED_ARRAY_NAMES.has(name)) return { key: "i64", type: { kind: "i64" } };
  if (ctx.wasi || ctx.standalone) {
    const packed = TYPED_ARRAY_PACKED_STORAGE[name];
    if (packed) return packed;
  }
  return { key: "f64", type: { kind: "f64" } };
}

/**
 * (#2593) The signedness of a packed integer typed-array element, driving the
 * read opcode: `array.get_s` for signed views (`Int8`/`Int16`/`Int32`),
 * `array.get_u` for unsigned (`Uint8`/`Uint8Clamped`/`Uint16`/`Uint32`). MUST be
 * keyed on the TS view NAME, not the storage kind — a signed `Int8Array` and an
 * unsigned `Uint8Array` share `i8` storage but read with opposite extension.
 * Returns undefined for non-integer views (Float*, or a non-typed-array name).
 */
export function typedArrayPackedSignedness(name: string): "s" | "u" | undefined {
  switch (name) {
    case "Int8Array":
    case "Int16Array":
    case "Int32Array":
      return "s";
    case "Uint8Array":
    case "Uint8ClampedArray":
    case "Uint16Array":
    case "Uint32Array":
      return "u";
    default:
      return undefined;
  }
}

/**
 * (#1700) Classify a TS type at an export boundary for the runtime
 * `wrapExports` marshalling step. The Wasm signature for `Uint8Array` and
 * `number[]` is identical (`(ref null $Vec[f64])`), so we surface the
 * TS-level distinction as metadata.
 *
 * - "uint8array"  → caller may pass JS Uint8Array; result-side wraps as Uint8Array
 * - "typed-array" → any other TypedArray (Int8Array / Float32Array / ...) — v1
 *                   treats these like number[] on the return path; tracked for
 *                   element-fidelity follow-up
 * - "other"       → not a typed array; wrapper is a no-op for this slot
 */
export function classifyTypedArrayType(
  tsType: ts.Type,
  checker: ts.TypeChecker,
): import("../ir/types.js").TypedArrayKind {
  // Strip null/undefined/void/Promise wrappers so `Uint8Array | undefined`,
  // `Promise<Uint8Array>` etc. still classify. Match `resolveWasmType`'s
  // own unwrapping rules.
  let t = tsType;
  if (t.isUnion()) {
    const non = t.types.filter(
      (x) => !(x.flags & ts.TypeFlags.Null) && !(x.flags & ts.TypeFlags.Undefined) && !(x.flags & ts.TypeFlags.Void),
    );
    if (non.length === 1) t = non[0]!;
  }
  const sym = t.aliasSymbol ?? t.getSymbol();
  if (sym?.name === "Promise") {
    const args = checker.getTypeArguments(t as ts.TypeReference);
    if (args.length > 0) return classifyTypedArrayType(args[0]!, checker);
  }
  const name = sym?.name;
  if (!name || !TYPED_ARRAY_NAMES.has(name)) return "other";
  return name === "Uint8Array" ? "uint8array" : "typed-array";
}

/**
 * Fold a default-parameter initializer to a compile-time numeric constant (#869).
 *
 * Handles pure literal-composed expressions — numeric literals, the read-only
 * numeric globals `NaN`/`Infinity`/`undefined`, parenthesized expressions,
 * unary `-`/`+`/`~`/`!`/`void`, and binary arithmetic/bitwise/logical operators
 * — so defaults like `= 30 * 1000`, `= 1 << 4`, `= 60 * 60`, or `= Infinity`
 * take the clean caller-side direct-emit path instead of the sNaN sentinel.
 *
 * IMPORTANT — identifier handling is deliberately narrow. Only the read-only
 * numeric globals (`NaN`/`Infinity`/`undefined`) and **immutable `const`
 * numeric bindings** are folded. `let`/`var` are NEVER folded: a default like
 * `= base` over a reassignable binding must observe the CURRENT value of `base`
 * at call time (§10.2.11), so folding it to the binding's initializer would be a
 * correctness regression. `const` is safe precisely because it cannot be
 * reassigned — its value is fixed for the program's lifetime. `const` resolution
 * is delegated to `ctx.oracle.constInitializerOf` (the checker boundary); when
 * `ctx` is absent, `const` folding is simply skipped (identical to prior
 * behavior). Any operand that is not itself constant-foldable makes the whole
 * expression unfoldable (returns `undefined`), so side-effecting operands
 * (`void foo()`, `a + bar()`) are never dropped — they fall through to the
 * existing expression-default path.
 *
 * The evaluation uses native JS operators, which already apply the correct
 * ECMAScript coercions (ToInt32 for bitwise, IEEE-754 for arithmetic), so the
 * folded value byte-matches what the callee would have computed.
 */
export function foldConstantNumericDefault(expr: ts.Expression, ctx?: CodegenContext, depth = 0): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isParenthesizedExpression(expr)) return foldConstantNumericDefault(expr.expression, ctx, depth);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return NaN;
  if (ts.isIdentifier(expr)) {
    // The read-only numeric globals first — never shadowable to a foldable
    // value in practice, and cheap to special-case.
    switch (expr.text) {
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "undefined":
        return NaN;
    }
    // Immutable `const` numeric binding: resolve to the const's initializer and
    // fold that. `let`/`var` are excluded by the oracle (reassignable → must
    // read the call-time value). `depth` bounds pathological const chains.
    if (ctx && depth < 16) {
      const init = ctx.oracle.constInitializerOf(expr);
      if (init) return foldConstantNumericDefault(init, ctx, depth + 1);
    }
    return undefined;
  }
  if (ts.isVoidExpression(expr)) {
    // `void <constant>` → undefined → NaN, but only when the operand is itself
    // foldable so a side-effecting operand (`void foo()`) is never dropped.
    return foldConstantNumericDefault(expr.expression, ctx, depth) === undefined ? undefined : NaN;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const v = foldConstantNumericDefault(expr.operand, ctx, depth);
    if (v === undefined) return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
        return -v;
      case ts.SyntaxKind.PlusToken:
        return +v;
      case ts.SyntaxKind.TildeToken:
        return ~v;
      case ts.SyntaxKind.ExclamationToken:
        return v ? 0 : 1;
      default:
        return undefined;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const l = foldConstantNumericDefault(expr.left, ctx, depth);
    if (l === undefined) return undefined;
    const r = foldConstantNumericDefault(expr.right, ctx, depth);
    if (r === undefined) return undefined;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return l + r;
      case ts.SyntaxKind.MinusToken:
        return l - r;
      case ts.SyntaxKind.AsteriskToken:
        return l * r;
      case ts.SyntaxKind.SlashToken:
        return l / r;
      case ts.SyntaxKind.PercentToken:
        return l % r;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return l ** r;
      case ts.SyntaxKind.LessThanLessThanToken:
        return l << r;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return l >> r;
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return l >>> r;
      case ts.SyntaxKind.AmpersandToken:
        return l & r;
      case ts.SyntaxKind.BarToken:
        return l | r;
      case ts.SyntaxKind.CaretToken:
        return l ^ r;
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return l && r;
      case ts.SyntaxKind.BarBarToken:
        return l || r;
      case ts.SyntaxKind.QuestionQuestionToken:
        // Numeric operands are never null/undefined, so the left value wins.
        return l;
      default:
        return undefined;
    }
  }
  return undefined;
}

export function extractConstantDefault(
  initializer: ts.Expression,
  paramType: ValType,
  ctx?: CodegenContext,
): OptionalParamInfo["constantDefault"] {
  if (paramType.kind === "f64") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "f64", value: Number(initializer.text) };
    }
    // true/false → 1/0 in f64 context
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "f64", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "f64", value: 0 };
    }
    // undefined → NaN in f64 context
    if (
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "f64", value: NaN };
    }
    // null → 0 in f64 context
    if (initializer.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: "f64", value: 0 };
    }
    // Unary minus: -42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: -Number(initializer.operand.text) };
    }
    // Unary plus: +42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.PlusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: Number(initializer.operand.text) };
    }
    // Compile-time-constant numeric expressions: `30 * 1000`, `1 << 4`,
    // `Infinity`, immutable `const` numeric bindings, etc. (#869) — emitted
    // directly at the call site.
    const folded = foldConstantNumericDefault(initializer, ctx);
    if (folded !== undefined) return { kind: "f64", value: folded };
    return undefined;
  }
  if (paramType.kind === "i32") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "i32", value: Number(initializer.text) | 0 };
    }
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "i32", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "i32", value: 0 };
    }
    if (
      initializer.kind === ts.SyntaxKind.NullKeyword ||
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "i32", value: 0 };
    }
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "i32", value: -Number(initializer.operand.text) | 0 };
    }
    // Compile-time-constant numeric expressions folded to a JS number, then
    // ToInt32-truncated (`| 0`) for the i32 slot — matches the callee's
    // coercion of the same default (#869). NaN/Infinity truncate to 0.
    const folded = foldConstantNumericDefault(initializer, ctx);
    if (folded !== undefined) return { kind: "i32", value: folded | 0 };
    return undefined;
  }
  // For ref types (externref, ref_null, etc.), constant defaults not supported yet
  return undefined;
}

/**
 * Lift a propagated lattice type into the backend IrType used by the IR
 * lowerer. Only concrete primitives are valid here; the caller must have
 * ensured the lattice entry is `f64` or `bool`. Non-primitive entries
 * throw — the caller should guard with `isConcreteLattice` first.
 */
function latticeToIr(t: LatticeType): IrType {
  if (t.kind === "f64") return irVal({ kind: "f64" });
  if (t.kind === "bool") return irVal({ kind: "i32", boolean: true });
  // #1169a — strings flow as the backend-agnostic `IrType.string`; the
  // resolver picks the concrete Wasm representation at lowering time.
  if (t.kind === "string") return { kind: "string" };
  throw new Error(`latticeToIr: non-primitive lattice type ${t.kind}`);
}

function isConcreteLattice(t: LatticeType | undefined): t is LatticeType & { kind: "f64" | "bool" | "string" } {
  return t !== undefined && (t.kind === "f64" || t.kind === "bool" || t.kind === "string");
}

function arrayElementRequiresOpaqueStorage(node: ts.TypeNode): boolean {
  while (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) node = node.type;
  return node.kind === ts.SyntaxKind.UnknownKeyword || ts.isUnionTypeNode(node);
}

const STANDALONE_DOM_EXTERN_POSITION_CLASSES = new Set(["Document", "HTMLElement", "CSSStyleDeclaration"]);

/**
 * Resolve the IR type for a function's param or return position, using
 * the AST's explicit TypeNode first (authoritative) and the TypeMap
 * lattice entry only as a fallback. If neither yields a concrete
 * primitive (or, slice 2, a representable object shape) this is a
 * selector bug — throw so the caller can skip the function and fall
 * through to legacy.
 *
 * #1169b widens this to accept TypeLiteral / TypeReference TypeNodes
 * by deriving an `IrType.object` from the TS checker. Shapes that the
 * resolver can't faithfully represent (callable types, methods,
 * non-primitive non-object fields, empty objects) cause the helper to
 * return `null`; the caller then throws so the function falls back to
 * the legacy path.
 */
function resolvePositionType(
  node: ts.TypeNode | undefined,
  mapped: LatticeType | undefined,
  ctx: CodegenContext,
  classShapes?: IrClassShapeLookup,
): IrType {
  if (node) {
    // `readonly T[]` parses as a `readonly`-TypeOperatorNode wrapping the array
    // type. `readonly` is a TS-only modifier with no runtime representation, so
    // resolve the inner type directly (parallels the ReadonlyArray handling in
    // resolveWasmType — #1748).
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      return resolvePositionType(node.type, mapped, ctx, classShapes);
    }
    if (node.kind === ts.SyntaxKind.NumberKeyword) return irVal({ kind: "f64" });
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return irVal({ kind: "i32" });
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
    // (#2949 slice 3b) AnyKeyword IS the dynamic type. The historical #1228
    // mapping (externref in ALL modes) diverged from legacy's fast-mode
    // `any` ABI — legacy `resolveWasmType` is mode-split (fast →
    // `ref_null $AnyValue`, host → externref), so an IR-claimed
    // `f(x: any)` had a DIFFERENT fast-mode signature than its legacy
    // callers/callees (measured in the slice-2 session; class-method
    // claims hit the typeIdx-parity guard for the same reason). `dynamic`
    // lowers through `resolveDynamic()`, which mirrors that mode split
    // exactly — one `any` ABI for both front-ends in both modes. Host-mode
    // bytes are unchanged (dynamic lowers to externref there).
    if (node.kind === ts.SyntaxKind.AnyKeyword) return irDynamic();
    // Slice 6 part 2 (#1181) — array type (T[] or Array<T>) resolves to a
    // vec ref. The legacy `getOrRegisterVecType` produces the same
    // (ref_null $vec_<elem>) struct ref the for-of vec fast path needs,
    // and the IR resolver's `resolveVec` (in integration.ts) reads the
    // struct shape back to recover element ValType. Numeric / boolean /
    // string element types are accepted; nested-vec or object-element
    // types throw and fall back to legacy.
    if (ts.isArrayTypeNode(node)) {
      const elemIr = arrayElementRequiresOpaqueStorage(node.elementType)
        ? irDynamic()
        : resolvePositionType(node.elementType, undefined, ctx, classShapes);
      if (elemIr.kind === "val" && (elemIr.val.kind === "f64" || elemIr.val.kind === "i32")) {
        return irVec(elemIr, true);
      }
      // (#2949 slice 3b) `any[]` elements keep their historical externref
      // vec representation — the AnyKeyword POSITION arm above now returns
      // `dynamic`, but element storage is a vec-layout decision (the
      // boxed-any element rep is #2379/#1852 territory, not this slice).
      // Byte-preserving for every currently-claimed `any[]` shape.
      const elemVal =
        elemIr.kind === "val"
          ? elemIr.val
          : elemIr.kind === "string" || elemIr.kind === "dynamic"
            ? ({ kind: "externref" } as ValType)
            : null;
      if (!elemVal) {
        throw new Error(
          `array element TypeNode ${ts.SyntaxKind[node.elementType.kind]} could not be lowered to a primitive ValType`,
        );
      }
      const elemKey =
        elemVal.kind === "ref" || elemVal.kind === "ref_null"
          ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
          : elemVal.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
      return irVal({ kind: "ref_null", typeIdx: vecIdx });
    }
    if (ts.isTypeLiteralNode(node) || ts.isTypeReferenceNode(node)) {
      // Slice 4 (#1169d) — a TypeReferenceNode whose checker symbol resolves
      // to an exact projected class resolves to `IrType.class`. Take this path
      // FIRST: classes also satisfy the
      // generic `objectIrTypeFromTsType` heuristic (they're "Object"
      // type-flag types), so without the explicit class detection we'd
      // fall into the data-object path, which doesn't carry method or
      // constructor info.
      if (classShapes && ts.isTypeReferenceNode(node)) {
        const entry = resolveIrClassShapeFromTypeReference(ctx.checker, node, classShapes);
        if (entry) return { kind: "class", shape: entry.shape };
      }
      // TypedArray<TArrayBuffer> (TS 5.7+) carries an ArrayBufferLike type
      // argument that is erased at runtime. Lower it exactly like the bare
      // typed-array annotation.
      const typedArrayName = typedArrayNameFromTypeNode(node);
      if (typedArrayName) {
        const storage = typedArrayVecStorage(ctx, typedArrayName);
        const vecIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
        return irVal({ kind: "ref_null", typeIdx: vecIdx });
      }
      // Slice 6 part 2 (#1181) — `Array<T>` TypeReferenceNode resolves
      // to a vec ref, parallel to the `T[]` ArrayTypeNode arm above.
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray")
      ) {
        const typeArgs = node.typeArguments;
        if (typeArgs && typeArgs.length === 1) {
          const elementType = typeArgs[0]!;
          const elemIr = arrayElementRequiresOpaqueStorage(elementType)
            ? irDynamic()
            : resolvePositionType(elementType, undefined, ctx, classShapes);
          if (elemIr.kind === "val" && (elemIr.val.kind === "f64" || elemIr.val.kind === "i32")) {
            return irVec(elemIr, true);
          }
          const elemVal =
            elemIr.kind === "val"
              ? elemIr.val
              : elemIr.kind === "string" || elemIr.kind === "dynamic"
                ? ({ kind: "externref" } as ValType)
                : null;
          if (!elemVal) {
            throw new Error(
              `Array<T> element TypeNode ${ts.SyntaxKind[typeArgs[0]!.kind]} could not be lowered to a primitive ValType`,
            );
          }
          const elemKey =
            elemVal.kind === "ref" || elemVal.kind === "ref_null"
              ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
              : elemVal.kind;
          const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
          return irVal({ kind: "ref_null", typeIdx: vecIdx });
        }
      }
      // Slice 6 part 3 (#1182) — built-in generic iterables (Map / Set /
      // WeakMap / WeakSet / Iterable / Iterator / Generator / Async*).
      // These all have host-managed runtime representations and the IR
      // doesn't model their internal structure; treat them as opaque
      // externref values. The IR's iter-host arm of `lowerForOfStatement`
      // accepts externref iterables and routes them through the
      // `__iterator` host import.
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text;
        if (
          name === "Map" ||
          name === "Set" ||
          name === "WeakMap" ||
          name === "WeakSet" ||
          name === "Iterable" ||
          name === "Iterator" ||
          name === "IterableIterator" ||
          name === "Generator" ||
          name === "AsyncIterable" ||
          name === "AsyncIterator" ||
          name === "AsyncGenerator"
        ) {
          return irVal({ kind: "externref" });
        }
      }
      // (#2856) Host extern class annotation (`: HTMLElement`, `: Element`,
      // …) — an ambient lib interface the legacy backend models as an extern
      // class (opaque externref + per-member `<Class>_get_<p>` /
      // `<Class>_<m>` imports). JS-host lane only; in host-free modes the
      // object-lowering fallback below keeps throwing (→ legacy → the
      // existing #1472 refusal). Placed AFTER the local-class / typed-array /
      // Array / iterable arms so it can't shadow them, and BEFORE
      // `objectIrTypeFromTsType`, which rejects method-carrying interfaces
      // anyway.
      const tsType = ctx.checker.getTypeFromTypeNode(node);
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const refType = tsType;
        const className = refType.getSymbol()?.name ?? node.typeName.text;
        const exactStandaloneDomPosition =
          ctx.requiresStandaloneDomCapability === true &&
          ctx.standalone &&
          !ctx.wasi &&
          !ctx.strictNoHostImports &&
          STANDALONE_DOM_EXTERN_POSITION_CLASSES.has(className);
        if (
          isExternalDeclaredClass(refType, ctx.checker) &&
          (!(ctx.standalone || ctx.wasi || ctx.strictNoHostImports) || exactStandaloneDomPosition)
        ) {
          return { kind: "extern", className };
        }
      }
      const ir = objectIrTypeFromTsType(ctx, tsType);
      if (ir) return ir;
      throw new Error(`object TypeNode ${ts.SyntaxKind[node.kind]} could not be lowered to IrType.object`);
    }
    // #2859 / #3214 B0+B3 — function-typed source boundary
    // (`fn: () => number` or `(): () => number`). Mirrors the selector's
    // FunctionTypeNode arms: the signature is
    // built by the SAME helper, so the override the lowerer receives compares
    // `irTypeEquals`-equal to the signature a slice-3 closure literal argument
    // produces. A claimed function reaching the throw below means selector and
    // override builder diverged (the standard out-of-sync guard → legacy).
    // Results and parameters share the canonical externref callable ABI; the
    // AST lowerer explicitly packs a returned internal closure at that seam.
    if (ts.isFunctionTypeNode(node)) {
      const signature = irClosureSignatureFromFunctionTypeNode(node);
      if (signature) return { kind: "callable", signature };
      throw new Error(`function TypeNode not expressible as an IR callable signature`);
    }
    throw new Error(`unsupported TypeNode kind ${ts.SyntaxKind[node.kind]}`);
  }
  if (isConcreteLattice(mapped)) return latticeToIr(mapped);
  if (mapped?.kind === "object") {
    // #1231 Phase 1 — the lattice carries a recursive structural shape
    // (`fields: { name, type }[]`) so we can build an `IrType.object`
    // directly from flow evidence, without consulting the TS checker.
    // This is what enables typed structs (e.g. `(field $x f64)`) for
    // unannotated functions like `function createPoint(x, y) { return {x, y}; }`.
    const ir = objectIrTypeFromLattice(mapped);
    if (ir) return ir;
    throw new Error(`object position type — lattice shape not lowerable to IrType.object`);
  }
  // #2949 slice 2 — UNANNOTATED position whose lattice converged to `unknown`
  // (no evidence) or `dynamic` (top): the position is honestly dynamic. MUST
  // stay predicate-identical to the selector's `resolveParamType` /
  // `resolveReturnType` dynamic arms (select.ts) — the selector claims
  // exactly the functions this resolver maps, so a drift here would either
  // drop claimed functions at resolve time (kind "resolve" demotions) or
  // hand the from-ast builder types the move-only scan never approved.
  // Lowering: `lowerIrTypeToValType`'s dynamic arm → `resolveDynamic()` =
  // legacy `resolveWasmType`'s any/unknown carrier (fast: ref_null $AnyValue,
  // host: externref), so the claimed function's Wasm signature equals what
  // legacy gives the same declaration. `node` is undefined here (annotated
  // positions — including element/field recursion, which always passes a
  // node — returned or threw above).
  if (mapped && (mapped.kind === "unknown" || mapped.kind === "dynamic")) {
    return irDynamic();
  }
  throw new Error(`no concrete type (mapped=${mapped?.kind ?? "missing"})`);
}

/**
 * #1231 Phase 1 — walk a `LatticeType` (must be `kind: "object"`) into
 * an `IrType.object`. Each field's atom is recursively mapped to an
 * `IrType` (primitives → `IrType.val`, strings → `IrType.string`,
 * nested objects → recursive call). Returns `null` if any field fails
 * to lower so the caller can fall back to legacy.
 *
 * The resulting `IrType.object` is consumed by the IR's
 * `ObjectStructRegistry` (in `src/ir/integration.ts`) which dedups by
 * the legacy `fieldsHashKey` — so a lattice-derived `{x: f64, y: f64}`
 * produces the same anonymous struct (`__anon_<n>`) the legacy path
 * would have produced for an explicit `{ x: number, y: number }`
 * annotation.
 */
function objectIrTypeFromLattice(t: LatticeType): IrType | null {
  if (t.kind !== "object") return null;
  if (t.fields.length === 0) return null;
  const fields: { name: string; type: IrType }[] = [];
  for (const f of t.fields) {
    const ir = atomToFieldIr(f.type);
    if (!ir) return null;
    fields.push({ name: f.name, type: ir });
  }
  // Lattice atom field lists are canonicalised at construction time,
  // but the IrObjectShape contract is "sorted by name" — re-sort here
  // defensively (cheap; matches `objectIrTypeFromTsType`).
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "object", shape: { fields } };
}

/**
 * Map a `LatticeAtom` to its `IrType` field-position lowering.
 * Mirrors `tsTypeToFieldIr` — but driven by flow evidence rather than
 * the TS checker. Returns `null` for atoms whose IR projection isn't
 * representable in field position (none today; reserved for forward
 * compatibility).
 */
function atomToFieldIr(a: import("../ir/propagate.js").LatticeAtom): IrType | null {
  if (a.kind === "f64") return irVal({ kind: "f64" });
  if (a.kind === "bool") return irVal({ kind: "i32" });
  if (a.kind === "string") return { kind: "string" };
  // A LatticeAtom of `kind: "object"` is also a LatticeType, so pass it
  // through to recurse over the nested field list.
  if (a.kind === "object") return objectIrTypeFromLattice(a);
  return null;
}

/**
 * Convert a TypeScript object type to an `IrType.object` shape.
 * Returns `null` if the type isn't a plain "data" object — methods,
 * getters, callable types, external declared classes, tuples, and
 * shapes containing fields the IR can't represent fall back to legacy.
 *
 * Field names are sorted into canonical (ascending) order to match
 * the `IrObjectShape` invariant.
 *
 * (#4019) `onPath` carries the object types currently being expanded on this
 * descent. A SELF-REFERENTIAL type — `interface Node { parent: Node }`, and the
 * far more common structural equivalents throughout real npm `.d.ts` files —
 * otherwise recurses forever through `tsTypeToFieldIr`, and the resulting
 * `RangeError: Maximum call stack size exceeded` is caught by the codegen
 * try/catch and reported as an opaque hard error that aborts the WHOLE compile.
 * A larger `--stack-size` does not help, because the recursion is unbounded
 * rather than merely deep.
 *
 * Re-entering a type already on the path yields `null`, the established "IR
 * cannot represent this — fall back to legacy" signal. That is the correct
 * answer on the merits, not just a safety valve: `IrObjectShape` is a finite,
 * flat field list, and a cyclic type has no such finite expansion.
 *
 * The set is PATH-scoped (removed on the way out), so a type appearing in two
 * sibling fields is still expanded normally; only a genuine cycle is rejected.
 */
function objectIrTypeFromTsType(ctx: CodegenContext, tsType: ts.Type, onPath?: Set<ts.Type>): IrType | null {
  if (!(tsType.flags & ts.TypeFlags.Object)) return null;
  if (tsType.getCallSignatures().length > 0) return null; // callable
  if (isExternalDeclaredClass(tsType, ctx.checker)) return null;
  if (isTupleType(tsType)) return null;
  const path = onPath ?? new Set<ts.Type>();
  if (path.has(tsType)) return null; // cyclic shape — no finite IR expansion

  const props = tsType.getProperties();
  if (props.length === 0) return null; // empty object — defer to a future slice

  const fields: { name: string; type: IrType }[] = [];
  path.add(tsType);
  try {
    for (const prop of props) {
      const decl = prop.valueDeclaration;
      if (
        decl &&
        (ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl))
      ) {
        return null;
      }
      const propType = ctx.checker.getTypeOfSymbol(prop);
      const fieldIr = tsTypeToFieldIr(ctx, propType, path);
      if (!fieldIr) return null;
      fields.push({ name: prop.name, type: fieldIr });
    }
  } finally {
    path.delete(tsType);
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "object", shape: { fields } };
}

/**
 * Field-type subset for object shapes: primitives + nested objects +
 * strings. Anything else (any/unknown/union/array/etc.) returns null,
 * which causes `objectIrTypeFromTsType` to bail and the function to
 * fall back to legacy.
 */
function tsTypeToFieldIr(ctx: CodegenContext, t: ts.Type, onPath?: Set<ts.Type>): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  // (#4019) thread the in-progress descent so a self-referential shape is
  // rejected instead of recursing until the stack dies.
  if (t.flags & ts.TypeFlags.Object) return objectIrTypeFromTsType(ctx, t, onPath);
  return null;
}

/**
 * Slice 4 (#1169d): build the per-class IR shape registry from the
 * legacy class collection state. Only top-level `ts.ClassDeclaration`
 * nodes are included (no class expressions, no nested-in-function
 * classes — same scope as the IR selector's `localClasses` set).
 *
 * The returned exact sidecar carries:
 *   - `fields`: user-visible struct fields in canonical (alphabetical)
 *               order. The legacy `__tag` prefix is stripped here so
 *               consumers see only TS-source-level fields. The IR's
 *               `IrType.class` doesn't expose the tag; the resolver
 *               accounts for it when computing Wasm field indices.
 *   - `methods`: instance methods only (no static methods). Their
 *                signatures come from the legacy method func's typeIdx
 *                in the WasmGC type registry, but here we re-derive
 *                from the AST so the IR types are symbolic / shape-
 *                preserving (matching what `resolvePositionType` does
 *                for top-level functions).
 *   - `constructorParams`: the constructor's user-visible param list,
 *                          re-derived from the AST.
 *
 * Classes whose constructor or any field/method type can't be lowered
 * to a representable IrType are SKIPPED — `resolvePositionType` then
 * falls through instead of substituting a same-spelled shape. That mirrors
 * the slice 2 / slice 3 behavior: best-effort acceptance with a clean
 * legacy fallback for unrepresentable shapes.
 */
function buildIrClassShapes(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  topLevelAccessorEvidence:
    | { readonly kind: "selection-candidate" }
    | { readonly kind: "selected"; readonly unitIds: ReadonlySet<IrUnitId> },
): IrClassShapeSidecar {
  const out = new Map<IrClassId, IrClassShapeEntry>();
  const lookup: IrClassShapeLookup = { identityContext, byClassId: out };
  const declarationsInCollectionOrder = collectIrClassShapeDeclarations(sourceFile, identityContext);
  const collectionPosition = new Map(
    declarationsInCollectionOrder.map((entry, index) => [entry.classId, index] as const),
  );
  const declarations = orderIrClassShapeDeclarationsForProjection(
    ctx.oracle,
    declarationsInCollectionOrder,
    identityContext,
  );
  // Local classes are allocated as identity-stable descriptor cells
  // before any member type is projected. TypeScript permits self-recursive and
  // mutually recursive annotations, so a later class must be resolvable while
  // its descriptor is still being filled. The cells are planning-only: only
  // completely populated dependency-closed shapes are published below.
  const provisionalEntries = new Map<IrClassId, IrClassShapeEntry>();
  const populatedProvisionalIds = new Set<IrClassId>();
  for (const { classId, declaration } of declarationsInCollectionOrder) {
    if (!ts.isClassDeclaration(declaration) || !declaration.name) {
      continue;
    }
    const className = declaration.name.text;
    if (
      !ctx.classSet.has(className) ||
      !ctx.structFields.has(className) ||
      ctx.classExternrefBackedSet.has(className)
    ) {
      continue;
    }
    const shape: import("../ir/nodes.js").IrClassShape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId,
      className,
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const entry = { classId, legacyName: className, declaration, shape };
    provisionalEntries.set(classId, entry);
    out.set(classId, entry);
  }
  for (const { classId, declaration: stmt } of declarations) {
    const className = ts.isClassExpression(stmt) ? ctx.anonClassExprNames.get(stmt) : stmt.name?.text;
    if (!className) continue;
    // The selector needs a provisional descriptor population in order to
    // prove the bounded class atomically. Every downstream shape rebuild uses
    // exact selected UnitIds instead, so a rejected syntactic candidate cannot
    // perturb lowering or the direct fallback ABI.
    const boundedAccessorSelectionCandidate =
      topLevelAccessorEvidence.kind === "selection-candidate" && isBoundedPreparedAccessorClass(stmt);
    // #3000-E: a single-level `extends` of a LOCAL user class projects (its own
    // shape carries the parent as `.parent`, driving `super(...)` / `super.method`
    // lowering). A class with `extends` of a builtin / externref-backed / not-yet-
    // built parent, or a non-identifier heritage expression, still defers to legacy
    // — `parentShape` stays undefined and the `continue` below drops it. An
    // `implements`-only class (no `extends`) is structurally flat and projects. This
    // predicate MIRRORS the selector's `hasParent && parentIsLocalClass` gate
    // (`src/ir/select.ts`) so a claimed subclass member always finds a shape here.
    let parentShape: import("../ir/nodes.js").IrClassShape | undefined;
    const parentClassId = resolveIrParentClassId(ctx.checker, stmt, identityContext);
    if (parentClassId !== null) {
      const parentPosition = parentClassId === undefined ? undefined : collectionPosition.get(parentClassId);
      const currentPosition = collectionPosition.get(classId)!;
      // Dependency ordering may move a later type-position dependency before
      // this class. It must not also widen the heritage policy: a parent that
      // was not earlier in the authoritative collection remains direct.
      if (parentPosition === undefined || parentPosition >= currentPosition) continue;
      const parentEntry = parentClassId === undefined ? undefined : out.get(parentClassId);
      if (!parentEntry) continue; // parent isn't this exact projected earlier class (builtin, foreign, or unsupported)
      parentShape = parentEntry.shape;
    }
    if (!ctx.classSet.has(className)) continue;
    if (!ctx.structFields.has(className)) continue;
    const callableTarget = (declaration: ts.Node, kind: IrUnitKind, suffix: string): IrFuncRef | undefined =>
      projectClassCallableTarget(ctx, identityContext, classId, declaration, kind, `${className}_${suffix}`);
    const placementFor = (declaration: ts.Node): IrClassMethodDescriptor["placement"] | undefined => {
      const unitId = identityContext.unitIdByDeclaration.get(declaration);
      const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
      if (
        !unit ||
        unit.lexicalOwnerId !== classId ||
        identityContext.declarationByUnitId.get(unitId!) !== declaration
      ) {
        return undefined;
      }
      return { classId, unitId: unit.id, staticClassMember: hasStaticModifier(declaration) };
    };

    // Constructor params — re-derived from AST so types come through
    // the same `tsTypeToFieldIr`-style projection. Reject if any param
    // has a non-representable type (e.g. union, function, generic).
    const ctor = stmt.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
    const constructorParams: IrType[] = [];
    let ctorOk = true;
    if (ctor) {
      for (const p of ctor.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          ctorOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, lookup);
        if (!ir) {
          ctorOk = false;
          break;
        }
        constructorParams.push(ir);
      }
    } else if (parentShape) {
      // A derived class with no source constructor has the spec-synthesized
      // `constructor(...args) { super(...args); }`. The direct backend already
      // clones the nearest user-parent constructor ABI for this support body;
      // project the same exact ABI so `new Derived(args)` can be prepared
      // instead of being rejected as an apparent zero-arity call.
      constructorParams.push(...parentShape.constructorParams);
    }
    if (!ctorOk) continue;
    const constructorInitTarget = callableTarget(
      ctor ?? stmt,
      ctor ? "class-constructor" : "class-implicit-constructor",
      "init",
    );
    const constructorTarget = irSupportFuncRef(
      classId,
      "class-constructor-new",
      classMemberFuncKey(ctx, `${className}_new`),
    );

    // Fields — read from the legacy `structFields` (which fixes the
    // authoritative field set: names, count, and the backend ValType each
    // struct slot commits to). Strip the `__tag` prefix and map each remaining
    // field to an IrType.
    //
    // #3000 Phase-1b (string-field-shape) — re-derive each field's IR type
    // from the AST/checker instead of the *lossy* legacy ValType. A `string`
    // field lowers to externref (host) / (ref $AnyString) (native); the ValType
    // alone can't tell a string from an `any`/object in host mode (both are
    // externref), so the old `valTypeToIrField(ValType)` returned null for
    // strings and the WHOLE class (e.g. classes.ts's `Animal`, whose `#name`
    // is a string) got no IrClassShape — leaving every accessor / method / ctor
    // byte-inert on legacy. We build a checker-derived field→IrType map keyed
    // by the SAME mangled name legacy stores in `structFields`, then adopt the
    // richer type ONLY when it is byte-compatible with the legacy struct slot
    // (`irFieldTypeMatchesLegacyValType` — a field-level parity guard). Fields
    // the AST can't resolve, or whose projection disagrees with the struct
    // slot, fall back to the original ValType path. Net effect: string (and
    // boolean/number) fields now project; unresolvable shapes still reject the
    // class, so the worst case remains a clean legacy fallback.
    const astFieldIr = new Map<string, IrType>();
    const recordField = (nameNode: ts.PropertyName, tsNode: ts.Node): void => {
      let mangled: string;
      if (ts.isPrivateIdentifier(nameNode)) mangled = "__priv_" + nameNode.text.slice(1);
      else if (ts.isIdentifier(nameNode)) mangled = nameNode.text;
      else return; // computed / string-literal / numeric names → leave to ValType path
      if (astFieldIr.has(mangled)) return;
      const tsType = ctx.checker.getTypeAtLocation(tsNode);
      const ir = tsTypeToClassPositionIr(ctx, tsType, lookup);
      if (ir) astFieldIr.set(mangled, ir);
    };
    // #3000-E: the legacy `structFields` for a subclass is `[...parentFields,
    // ...ownFields]` (see `collectClassDeclaration`), so a subclass's slot set
    // includes fields DECLARED on its ancestors — e.g. Dog's `__priv_name` is
    // Animal's string field. The AST re-derivation must therefore walk the whole
    // ancestor chain (self + every local parent), or an inherited STRING field
    // has no `astFieldIr` entry and falls to the null-returning ValType path,
    // rejecting the whole subclass. Numeric/boolean inherited fields survive the
    // ValType path regardless; this walk is what recovers inherited string fields.
    const chain: (ts.ClassDeclaration | ts.ClassExpression)[] = [stmt];
    const visitedClassIds = new Set<IrClassId>([classId]);
    for (let cursor = parentClassId; cursor !== null && cursor !== undefined; ) {
      if (visitedClassIds.has(cursor)) break;
      const decl = identityContext.declarationByClassId.get(cursor);
      if (
        !decl ||
        (!ts.isClassDeclaration(decl) && !ts.isClassExpression(decl)) ||
        decl.getSourceFile() !== sourceFile
      ) {
        break;
      }
      visitedClassIds.add(cursor);
      chain.push(decl);
      cursor = resolveIrParentClassId(ctx.checker, decl, identityContext);
    }
    for (const decl of chain) {
      // Property declarations (`#name: string;`, `x: number;`) — legacy reads the
      // field type off the member node itself; mirror that source exactly.
      for (const member of decl.members) {
        if (ts.isPropertyDeclaration(member) && member.name && !hasStaticModifier(member)) {
          recordField(member.name, member);
        }
      }
      // Constructor-body `this.x = …` field introductions — legacy reads the
      // field type off the property-access LHS node; mirror that source.
      const declCtor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
      if (declCtor?.body) {
        for (const s of declCtor.body.statements) {
          if (
            ts.isExpressionStatement(s) &&
            ts.isBinaryExpression(s.expression) &&
            s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(s.expression.left) &&
            s.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            recordField(s.expression.left.name, s.expression.left);
          }
        }
      }
    }

    const legacyFields = ctx.structFields.get(className)!;
    const fields: { name: string; type: IrType }[] = [];
    let fieldsOk = true;
    for (const f of legacyFields) {
      if (f.name === "__tag") continue;
      const astIr = astFieldIr.get(f.name);
      const ir = astIr && irFieldTypeMatchesLegacyValType(ctx, astIr, f.type) ? astIr : valTypeToIrField(ctx, f.type);
      if (!ir) {
        fieldsOk = false;
        break;
      }
      fields.push({ name: f.name, type: ir });
    }
    if (!fieldsOk) continue;
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Methods — instance methods only, re-derived from the AST.
    const methods: IrClassMethodDescriptor[] = [];
    let methodsOk = true;
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      if (hasStaticModifier(member)) continue; // slice 4 defers static methods
      if (hasAbstractModifier(member)) continue;
      if (!ts.isIdentifier(member.name)) continue; // computed names → defer
      if (member.asteriskToken) continue; // generators → defer
      const methodName = member.name.text;
      const params: IrType[] = [];
      for (const p of member.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          methodsOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, lookup);
        if (!ir) {
          methodsOk = false;
          break;
        }
        params.push(ir);
      }
      if (!methodsOk) break;
      // Return type — null for void (matches IrClassMethodDescriptor).
      let returnType: IrType | null = null;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const retTs = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retTs)) {
          const ir = tsTypeToClassPositionIr(ctx, retTs, lookup);
          if (!ir) {
            methodsOk = false;
            break;
          }
          returnType = ir;
        }
      }
      const target = callableTarget(member, "class-instance-method", methodName);
      const placement = placementFor(member);
      methods.push({
        name: methodName,
        params,
        returnType,
        ...(target ? { target } : {}),
        ...(placement ? { placement } : {}),
      });
    }
    if (!methodsOk) continue;

    // (#3144) Accessor + static-method descriptor projections — BEST-EFFORT:
    // an unprojectable accessor/static is simply skipped (a claimed use then
    // misses the descriptor at from-ast and demotes that one function),
    // never rejecting the WHOLE class like the instance-method loop above
    // would (which would regress classes that project today). Getters carry
    // the property name with `memberKind: "getter"` ([] -> T); setters
    // `"setter"` ([T] -> null); statics `"static"` (no `this` param at the
    // Wasm level — invoked via `class.static_call`). Instance-member lookups
    // filter on `memberKind`, so these never leak into `class.call`
    // resolution.
    for (const member of stmt.members) {
      if (!member.name) continue;
      const placement = placementFor(member);
      const placementTerminal = placement ? identityContext.terminalByUnitId.get(placement.unitId) : undefined;
      const nestedAccessorPlacement = placementTerminal?.containingTerminalOwnerId !== undefined;
      const exactSelectedTopLevelAccessorPlacement =
        placement !== undefined &&
        topLevelAccessorEvidence.kind === "selected" &&
        topLevelAccessorEvidence.unitIds.has(placement.unitId);
      const exactAccessorPlacement =
        nestedAccessorPlacement || boundedAccessorSelectionCandidate || exactSelectedTopLevelAccessorPlacement;
      if (
        (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
        !exactAccessorPlacement &&
        !ts.isIdentifier(member.name)
      ) {
        continue;
      }
      const memberName = resolveClassMemberName(ctx, member.name);
      if (memberName === undefined) continue;
      if (ts.isGetAccessorDeclaration(member)) {
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (!sig) continue;
        const retTs = ctx.checker.getReturnTypeOfSignature(sig);
        if (isVoidType(retTs)) continue; // void getter — degenerate, skip
        const ir = tsTypeToClassPositionIr(ctx, retTs, lookup);
        if (!ir) continue;
        const isStatic = hasStaticModifier(member);
        if (isStatic && !exactAccessorPlacement) continue;
        const target = callableTarget(
          member,
          isStatic ? "class-static-getter" : "class-instance-getter",
          `get_${memberName}`,
        );
        methods.push({
          name: memberName,
          params: [],
          returnType: ir,
          memberKind: "getter",
          ...(target ? { target } : {}),
          ...(placement ? { placement } : {}),
        });
      } else if (ts.isSetAccessorDeclaration(member)) {
        if (member.parameters.length !== 1) continue;
        const p = member.parameters[0]!;
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) continue;
        const parameterType = ctx.checker.getTypeAtLocation(p);
        const ir =
          exactAccessorPlacement && p.type === undefined
            ? irDynamic()
            : tsTypeToClassPositionIr(ctx, parameterType, lookup);
        if (!ir) continue;
        const isStatic = hasStaticModifier(member);
        if (isStatic && !exactAccessorPlacement) continue;
        const target = callableTarget(
          member,
          isStatic ? "class-static-setter" : "class-instance-setter",
          `set_${memberName}`,
        );
        methods.push({
          name: memberName,
          params: [ir],
          returnType: null,
          memberKind: "setter",
          ...(target ? { target } : {}),
          ...(placement ? { placement } : {}),
        });
      } else if (
        ts.isMethodDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        hasStaticModifier(member) &&
        !hasAbstractModifier(member) &&
        !member.asteriskToken
      ) {
        const params: IrType[] = [];
        let ok = true;
        for (const p of member.parameters) {
          if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
            ok = false;
            break;
          }
          const ir = tsTypeToClassPositionIr(ctx, ctx.checker.getTypeAtLocation(p), lookup);
          if (!ir) {
            ok = false;
            break;
          }
          params.push(ir);
        }
        if (!ok) continue;
        let returnType: IrType | null = null;
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (sig) {
          const retTs = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isVoidType(retTs)) {
            const ir = tsTypeToClassPositionIr(ctx, retTs, lookup);
            if (!ir) continue;
            returnType = ir;
          }
        }
        // A same-name instance method + static method share ONE legacy
        // funcMap key (`${className}_${name}` — class-bodies.ts skips the
        // second registration), so resolving either would call the wrong
        // body. Project the static only when no instance member takes the
        // name (from-ast then demotes the ambiguous call cleanly).
        if (methods.some((m) => m.name === memberName && (m.memberKind ?? "method") === "method")) continue;
        const target = callableTarget(member, "class-static-method", memberName);
        methods.push({
          name: memberName,
          params,
          returnType,
          memberKind: "static",
          ...(target ? { target } : {}),
          ...(placement ? { placement } : {}),
        });
      }
    }

    const shape: import("../ir/nodes.js").IrClassShape = {
      classId,
      className,
      fields,
      methods,
      constructorParams,
      constructorTarget,
      ...(constructorInitTarget ? { constructorInitTarget } : {}),
      // #3000-E: present only for a single-level subclass of a local user class.
      ...(parentShape ? { parent: parentShape } : {}),
    };
    const provisional = provisionalEntries.get(classId);
    if (provisional) {
      Object.assign(provisional.shape, shape);
      populatedProvisionalIds.add(classId);
    } else {
      out.set(classId, { classId, legacyName: className, declaration: stmt, shape });
    }
  }
  for (const classId of provisionalEntries.keys()) {
    if (!populatedProvisionalIds.has(classId)) out.delete(classId);
  }

  // A provisional target can fail after another descriptor already consumed
  // its cell. Remove that owner as well; publishing a dangling class identity
  // would turn an atomic typed fallback into a late lowering invariant.
  const directShapeDependencies = (shape: import("../ir/nodes.js").IrClassShape): ReadonlySet<IrClassId> => {
    const dependencies = new Set<IrClassId>();
    const seen = new Set<IrType>();
    const addType = (type: IrType): void => {
      if (seen.has(type)) return;
      seen.add(type);
      switch (type.kind) {
        case "class":
          dependencies.add(type.shape.classId);
          return;
        case "object":
          for (const field of type.shape.fields) addType(field.type);
          return;
        case "vec":
          addType(type.elementType);
          return;
        case "closure":
        case "callable":
          for (const parameter of type.signature.params) addType(parameter);
          if (type.signature.returnType) addType(type.signature.returnType);
          return;
        case "union":
          for (const member of type.members) addType(member);
          return;
        case "boxed":
          addType(type.inner);
          return;
        default:
          return;
      }
    };
    for (const field of shape.fields) addType(field.type);
    for (const parameter of shape.constructorParams) addType(parameter);
    for (const method of shape.methods) {
      for (const parameter of method.params) addType(parameter);
      if (method.returnType) addType(method.returnType);
    }
    if (shape.parent) dependencies.add(shape.parent.classId);
    return dependencies;
  };
  let removedDanglingShape = true;
  while (removedDanglingShape) {
    removedDanglingShape = false;
    for (const [classId, entry] of out) {
      if ([...directShapeDependencies(entry.shape)].some((dependency) => !out.has(dependency))) {
        out.delete(classId);
        removedDanglingShape = true;
      }
    }
  }
  // Dependency construction order is an internal planning detail. Publish the
  // registry in the authoritative collection order so type/global planning and
  // legacy compatibility views remain byte-stable for existing programs.
  const published = new Map<IrClassId, IrClassShapeEntry>();
  for (const { classId } of declarationsInCollectionOrder) {
    const entry = out.get(classId);
    if (entry) published.set(classId, entry);
  }
  return createIrClassShapeSidecar(published, identityContext);
}

/**
 * Slice 4 (#1169d): project a TypeScript type that appears in a class
 * member position (constructor param, method param, method return,
 * field) into an IrType. Returns `null` if the type isn't
 * representable — the caller skips the whole class in that case.
 *
 * Recognises:
 *   - primitives (number → f64, boolean → i32, string)
 *   - object shapes via `objectIrTypeFromTsType`
 *   - already-projected classes through their checker declaration and exact
 *     `IrClassId` (never through a symbol/display name)
 */
function tsTypeToClassPositionIr(ctx: CodegenContext, t: ts.Type, classShapes: IrClassShapeLookup): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  const entry = resolveIrClassShapeFromType(ctx.checker, t, classShapes);
  if (entry) return { kind: "class", shape: entry.shape };
  if (t.flags & ts.TypeFlags.Object) {
    const ir = objectIrTypeFromTsType(ctx, t);
    if (ir) return ir;
  }
  return null;
}

/**
 * Slice 4 (#1169d): map a legacy `ValType` (already lowered to Wasm)
 * back to an IrType for a class field descriptor. Used so the IR's
 * field-type discriminator stays consistent with what the legacy
 * struct emits.
 *
 * Conservative: only primitives + ref types pass. Ref types lower to
 * `IrType.val` carrying the same Wasm typeIdx — works for both
 * class-instance fields (typeIdx points at another class struct) and
 * anonymous struct fields. Field reads against these types return
 * `(ref $...)` values which the IR can compose with subsequent
 * operations only via the surrounding class.get / class.set; that's
 * fine for slice 4's surface.
 */
function valTypeToIrField(_ctx: CodegenContext, vt: import("../ir/types.js").ValType): IrType | null {
  if (vt.kind === "f64" || vt.kind === "i32") return irVal(vt);
  // `string`-typed class fields are handled by the AST/checker projection in
  // `buildIrClassShapes` (#3000 Phase-1b) — the legacy ValType (externref /
  // (ref $AnyString)) is ambiguous in host mode, so string recovery can't be
  // done from the ValType alone. This ValType path stays the fallback for
  // non-string fields; returning null here still rejects any field the AST
  // couldn't resolve (e.g. tagged-union / `any` refs), so the class falls back
  // to legacy cleanly.
  return null;
}

/**
 * #3000 Phase-1b — field-level parity guard. Does an AST/checker-derived class
 * field `IrType` lower to the SAME backend `ValType` the legacy struct slot
 * already committed to? We only adopt the richer AST-derived type when it is
 * byte-compatible with the struct, so `class.get`/`class.set` against the shape
 * produce exactly the ValType the struct holds — no invalid Wasm, no ABI drift
 * versus legacy-compiled callers, and the #1370 method-signature parity guard
 * (`integration.ts`) sees identical typeIdx on both sides.
 *
 * Scope is intentionally narrow: primitives (`f64`/`i32`), `string`, and an
 * exact local `class` whose identity-projected shape resolves to the same
 * committed struct index. The `string` arm mirrors `resolveWasmType`'s string
 * arm + the `ref`→`ref_null` field widening in `collectClassDeclaration`
 * (native → `(ref/ref_null $AnyString)`; host → `externref`), which is exactly
 * what `resolveString()` resolves an `IrType.string` to at lower time. The
 * class arm likewise accepts either nullability of the same struct index
 * because class fields are nullable storage while source parameters/results
 * remain non-null class references. Any other IR kind returns false → the
 * caller falls back to the ValType path.
 */
function irFieldTypeMatchesLegacyValType(
  ctx: CodegenContext,
  ir: IrType,
  vt: import("../ir/types.js").ValType,
): boolean {
  if (ir.kind === "val") {
    const a = ir.val;
    if (a.kind !== vt.kind) return false;
    if (a.kind === "ref" || a.kind === "ref_null") {
      return a.typeIdx === (vt as { typeIdx: number }).typeIdx;
    }
    return true;
  }
  if (ir.kind === "string") {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      return (vt.kind === "ref" || vt.kind === "ref_null") && vt.typeIdx === ctx.anyStrTypeIdx;
    }
    return vt.kind === "externref";
  }
  if (ir.kind === "class") {
    const structTypeIdx = ctx.structMap.get(ir.shape.className);
    return structTypeIdx !== undefined && (vt.kind === "ref" || vt.kind === "ref_null") && vt.typeIdx === structTypeIdx;
  }
  return false;
}

// ---------------------------------------------------------------------------
// #1530 — IR fallback phase-out hooks.
//
// A compatibility strict-mode set that lets later PRs close the selector
// fallback path for specific rejection classes. Typed preparation outcomes,
// not diagnostic text, own post-selection policy (#3519).
//
// `STRICT_IR_REASONS`     — selector-rejection reasons that must NOT show
//                           up in any compilation. When non-empty, the
//                           selector is run with `trackFallbacks: true` and
//                           every matching reason is surfaced as a hard
//                           compile error rather than silently flowing to
//                           legacy. Add a reason here once its bucket in
//                           `scripts/ir-fallback-baseline.json` hits zero.
//
// See `plan/log/ir-adoption.md` for the per-bucket ownership + target
// dates that drive this list.
// ---------------------------------------------------------------------------
const STRICT_IR_REASONS: ReadonlySet<IrFallbackReason> = new Set<IrFallbackReason>();
// Empty as of #1530 — and #3341 established that a bucket reaching zero in
// `scripts/ir-fallback-baseline.json` is NECESSARY but NOT SUFFICIENT to add
// its reason here. That baseline is measured against the 13-file playground
// corpus only; corpus-zero does NOT mean the reason is unreachable on real
// code. Most rejection reasons describe LEGITIMATE IR-non-claimability that the
// legacy path must still catch — e.g. `external-call` (a call to a
// non-whitelisted external fn), `call-graph-closure` (an unclaimable callee),
// `param-type-not-resolvable` / `return-type-not-resolvable` /
// `type-resolution-failure` (TypeMap can't resolve the type), `class-method`
// (still covers computed/generator/abstract names, static super,
// subclass-of-builtin — see plan/log/ir-adoption.md), and the destructuring
// param buckets. Adding any of these here would promote a legitimate fallback
// to a HARD COMPILE ERROR and regress real programs. So a reason may be
// promoted to strict ONLY once it is genuinely UNREACHABLE in the IR (i.e. the
// IR is now expected to always claim+lower that construct, so a rejection is a
// bug) — real #2855-family adoption work, reason by reason, not a doc flip.
// #2856 reached corpus-zero for `body-shape-rejected` on 2026-07-21, but the
// reason remains non-strict under this rule: unsupported real-world bodies are
// still expected to route through the direct front-end.
// The intended promotion order once each becomes genuinely unreachable
// (cheapest first, see plan/log/ir-adoption.md):
//   "param-type-not-resolvable",
//   "call-graph-closure",
//   "body-shape-rejected",

// ---------------------------------------------------------------------------
// (#3341 Slice C) STRICT POST-CLAIM CODES — the promotion vector that works.
//
// `STRICT_IR_REASONS` above governs SELECTOR rejections and is correctly empty:
// a selector reason names a construct the IR may legitimately decline before
// claiming. This set governs the other side of the claim boundary: a unit the
// selector ALREADY CLAIMED that then fails, carrying a typed `IrUnsupportedCode`
// at a post-claim `stage`. There the demote is only legitimate when it is a
// documented capability gap; when the failing arm restates a condition the
// selector's OWN gate already decided, firing it post-claim is a
// selector<->builder desync (a compiler bug), and the demote hides it.
//
// PROMOTION BAR — all four, per the Slice C re-spec. Corpus-zero alone is
// explicitly NOT sufficient (that premise is what this issue was re-scoped to
// correct, and what forced the #3565/#3784/#4035 narrowings of Slice B):
//   1. every LIVE throw site for the code at a post-claim stage restates a
//      predicate the selector already evaluated, using the SAME shared helper
//      (not a parallel re-implementation) — so a valid program cannot reach it;
//   2. zero in `scripts/ir-fallback-baseline.json`'s `postClaim` section;
//   3. zero on a test262-scale stride sweep through production `compile()`;
//   4. documented in plan/log/ir-adoption.md as "IR must always handle".
//
// STAGE SCOPE (`isStrictIrPostClaimStage`) is `build`/`verify`/`lower`/
// `backend-legality` — exactly the four `postClaim` baseline buckets. `select`
// is pre-claim and belongs to `STRICT_IR_REASONS`. `resolve` is deliberately
// OUT: it is where the claim is withdrawn during preparation, and it carries
// the #1921 contract (`type-resolution-unsupported`, ~2690 below) plus
// `abi-signature-parity` / `late-preparation-unsupported` / `new-target-
// threading` — all designed withdrawals that keep a working legacy body.
//
// NEVER PROMOTE (documented demote-to-legacy contracts; citations kept so a
// future author does not re-run the #3565 mistake):
//   - `element-store-unsupported`, `element-access-unsupported`,
//     `return-type-legacy-coupling`, `compound-assign-unsupported` — the four
//     #3565-restored contracts (see src/ir/outcomes.ts).
//   - `type-resolution-unsupported` at `resolve` — the #1921 contract; a
//     class-typed cross-function return the IR cannot represent is a
//     capability gap, and hard-failing it regresses real programs.
//   - `unboxed-number-local-unprovable` (#3784), `throw-value-unsupported` and
//     `unknown-class-construction` (#4035) — same class, found later.
//   - `body-shape-rejected` at build: one of its two post-claim arms
//     (`dynamicForInPlan` absent, from-ast.ts) is a REAL capability gap on the
//     linear backend, whose resolver does not supply that plan.
//   - `array-representation-unsupported`: three of its four arms mirror the
//     selector's holey-Array gate, but the fourth (widening/heterogeneous sink,
//     from-ast.ts ~4229) is a deliberate demote to the safe boxed lowering.
//   - `constructor-arity-unsupported` at build: `new Number()` / `new Boolean()`
//     reach it with no selector arity gate for primitive wrappers.
//
// Measured 2026-08-15 on this branch (post-#2951/#2952/#3583/#3518 wave):
// corpus `postClaim` = all buckets empty; test262 stride-40 sweep = 1340 files
// compiled, THREE post-claim rows total, none of them a promoted code
// (`module-init-legacy-coupling`@build 1, `abi-signature-parity`@resolve 1,
// and one `unexpected-internal-throw` invariant that already hard-errors).
// ---------------------------------------------------------------------------
const STRICT_IR_POSTCLAIM_CODES: ReadonlySet<IrUnsupportedCode> = new Set<IrUnsupportedCode>([
  // `class-member-unsupported` — its ONLY post-claim site (src/ir/integration.ts,
  // the `isCtorMember` arm) demotes when `collectIrClassInstanceInitializers`
  // returns undefined, i.e. the class has a dynamically computed instance-field
  // name. The selector calls THAT EXACT helper first, in both the explicit-
  // constructor gate and the implicit-constructor gate
  // (`constructorFieldInitializersAreIrSafe`, src/ir/select.ts), and refuses
  // the claim on the same undefined. One predicate, two call sites, same
  // argument: a claimed constructor member cannot legitimately reach the build
  // arm, so reaching it means the selector gate was bypassed or drifted.
  // Sweep: 154 rejections at `select` (the contract working) and 0 at any
  // post-claim stage.
  "class-member-unsupported",
]);

/** The four `postClaim` baseline buckets; `select`/`resolve` are pre-commitment. */
function isStrictIrPostClaimStage(stage: IrPreparationStage): boolean {
  return stage === "build" || stage === "verify" || stage === "lower" || stage === "backend-legality";
}

/**
 * (#3341 Slice C) True when a post-claim failure must be a HARD compile error
 * rather than the usual demote-to-legacy warning. Scoped to typed `unsupported`
 * outcomes: `invariant` outcomes are already hard-errored by
 * `formatIrPathFallbackDiagnostic`, and widening this predicate to them would
 * defeat the #680 target-omitted-host-import narrowing.
 */
export function isStrictIrPostClaimFailure(failure: IrPreparationFailure): boolean {
  return (
    failure.kind === "unsupported" &&
    isStrictIrPostClaimStage(failure.stage) &&
    STRICT_IR_POSTCLAIM_CODES.has(failure.code)
  );
}

/**
 * (#3143) Escape-hatch check for default-ON env flags: only an explicit
 * `0`/`false` disables. Unset / empty / any other value means "default on".
 */
function explicitlyDisabledEnv(v: string | undefined): boolean {
  return v === "0" || v === "false";
}

// (#680 / #3341) The host-only generator/async-generator buffer imports that
// `addGeneratorImports` (registry/imports.ts) intentionally does NOT register
// under `--target standalone`/`wasi` (it early-returns there). In those targets
// the native #680 `__GenState` state machine lowers generators host-free, so an
// IR generator path that still emits a ref to one of these names (src/ir/
// from-ast.ts) is referencing a TARGET-UNAVAILABLE host import — NOT a
// builder↔finalize desync. Keep this list in lockstep with `addGeneratorImports`.
function isHostOnlyGeneratorImportName(name: string): boolean {
  return (
    name.startsWith("__gen_") ||
    name === "__create_generator" ||
    name === "__create_async_generator" ||
    name === "__get_caught_exception"
  );
}

/**
 * (#680) True when a hard IR-build INVARIANT is actually a reference to a host
 * import that the CURRENT TARGET intentionally omits, not a builder↔finalize
 * desync. #3341 promoted the `unknown-function-ref` name-repoint invariant to a
 * hard compile error on the premise that "no valid TS source can produce an
 * unresolvable ref on a correctly-claimed function" — validated on the gc-target
 * playground corpus, which MISSED the standalone-target dimension: a basic
 * `function* g(){ yield 1 }` under `--target standalone` makes the IR generator
 * path emit a ref to the host-only `__gen_create_buffer`, which standalone never
 * registers, so it hard-errored instead of demoting to the working native path
 * (regressed #680, bisected to #3341 / PR #3249).
 *
 * Scoped PRECISELY (per the fix decision): fires ONLY when the target lacks JS
 * host imports AND the unresolved FUNCTION-ref name is in the host-only
 * generator-import family. A genuine desync — an unknown ref to an IR-builder-
 * created `$…` entity, ANY unknown global/type ref, or ANY unknown ref in a
 * host/gc build where these imports DO register — is not matched and still
 * hard-errors.
 */
function isTargetOmittedHostImportInvariant(
  err: IrIntegrationError,
  ctx?: Pick<CodegenContext, "standalone" | "wasi">,
): boolean {
  if (!ctx || !(ctx.standalone || ctx.wasi)) return false;
  if (err.outcome.kind !== "invariant" || err.outcome.code !== "unknown-function-ref") return false;
  const name = /unknown function ref "([^"]+)"/.exec(err.message)?.[1];
  return name !== undefined && isHostOnlyGeneratorImportName(name);
}

export function formatIrPathFallbackDiagnostic(
  err: IrIntegrationError,
  ctx?: Pick<CodegenContext, "standalone" | "wasi">,
): {
  readonly message: string;
  readonly severity: "error" | "warning";
} {
  const body = `IR path failed for ${err.func}: ${err.message} [IR-FALLBACK]`;
  const hard =
    (err.outcome.kind === "invariant" && !isTargetOmittedHostImportInvariant(err, ctx)) ||
    // (#3341 Slice C) A typed `unsupported` code whose post-claim arm restates a
    // gate the selector already applied — see STRICT_IR_POSTCLAIM_CODES.
    isStrictIrPostClaimFailure(err.outcome);
  return {
    message: hard ? `Codegen error: ${body}` : body,
    severity: hard ? "error" : "warning",
  };
}

// ---------------------------------------------------------------------------
// #2138 — IR-first compile-once inversion (flag-gated investigation)
//
// `planIrOverlay` owns propagation → selection → class shapes → the override
// and safe-selection projections. IR-first runs it before `compileDeclarations`
// so claimed bodies can skip legacy emission; the opt-out runs it afterward.
// The order remains gated because planning is not side-effect-free:
// `resolvePositionType` can register Wasm types, while `buildIrClassShapes`
// reads fields that body compilation can add (#516). Keeping both positions
// preserves the opt-out pipeline's type-index and body-emission behavior.
// ---------------------------------------------------------------------------

interface IrOverlayPlan {
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly selection: import("../ir/select.js").IrSelection;
  readonly classShapeSidecar: IrClassShapeSidecar;
  readonly classShapes: ReadonlyMap<string, import("../ir/nodes.js").IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, import("../ir/nodes.js").IrClassShape>;
  readonly overrideMapByUnitId: ReadonlyMap<IrUnitId, { params: IrType[]; returnType: IrType | null }>;
  readonly overrideMap: Map<string, { params: IrType[]; returnType: IrType | null }>;
  readonly safeSelection: {
    funcs: Set<string>;
    classMembers?: ReadonlySet<string>;
    classMemberUnitIds?: ReadonlySet<IrUnitId>;
    // (#3142 Slice 2) Claim-feeding module-init assessment, forwarded from
    // `selection` so `compileIrPathFunctions` can lower + patch the
    // `__module_init` slot. Cleared alongside funcs under the `new.target`
    // coarse gate.
    moduleInit?: import("../ir/select.js").IrModuleInitAssessment;
  };
  /** Verbose histogram switch; outcome collection is independent of logging. */
  readonly logFallbacks: boolean;
  /** Pre-integration terminal failures retained through exact reconciliation. */
  readonly preparationFailuresByUnitId: Map<IrUnitId, IrPreparationFailure>;
  readonly declByName: ReadonlyMap<string, ts.FunctionDeclaration>;
  /** Checker-certified source-unit and ambient-host call sites, keyed by exact AST node. */
  readonly importedCalls: Map<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: Map<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  /** Exact ambient addEventListener void arrows admitted by B2/Calendar. */
  readonly hostVoidCallbacks: Map<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  /** Exact ambient Date snapshot constructors and getter uses admitted by Calendar. */
  readonly hostDateSnapshots: Map<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters: Map<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  /** Synthetic host-Date ABI labels keyed by each exact certified terminal owner. */
  readonly hostDateImportsByOwnerUnitId: ReadonlyMap<IrUnitId, IrHostDateSnapshotImportPlan>;
  /** Exact Promise-delay plans, keyed separately by each owned AST call. */
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
  readonly suspendingAsyncUnitIds: ReadonlySet<IrUnitId>;
  readonly importedFunctionResolver?: irOverlayIdentity.IrIdentityImportedFunctionResolver;
}

/**
 * Allocate and freeze direct function-value singleton support before a target
 * body can seal through Prepared IR. A direct caller may still materialize the
 * value later, but it must reuse these exact allocator objects rather than
 * adding ABI drafts to an already sealed target component.
 */
function prepareTopLevelFunctionValueTargetSupport(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  selectedLegacyNames: ReadonlySet<string>,
): ReadonlyMap<IrUnitId, MultiPreparedFunctionValueSupportReceipt> {
  const receipts = new Map<IrUnitId, MultiPreparedFunctionValueSupportReceipt>();
  const selectedUnitIds = new Set(
    [...selectedLegacyNames].map((legacyName) =>
      irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName),
    ),
  );
  const valueTargetUnitIds = collectPreparedTopLevelFunctionValueTargetUnitIds(ctx, sourceFile, plan.identityPlan);
  for (const unitId of valueTargetUnitIds) {
    if (!selectedUnitIds.has(unitId)) continue;
    const claim = plan.functionClaimsByUnitId.get(unitId);
    const funcIdx = claim ? ctx.programAbiSourceCallables?.handleForUnit(unitId) : undefined;
    const target = claim ? irUnitFuncRef({ unitId, name: claim.legacyName }) : undefined;
    if (claim === undefined || funcIdx === undefined || target === undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} has no exact allocated source callable`,
      );
    }
    const singleton = ensureFuncClosureSingleton(ctx, claim.legacyName, funcIdx, false);
    const trampoline = singleton ? definedFuncAt(ctx, singleton.trampolineFuncIdx) : undefined;
    const cache = singleton ? ctx.mod.globals[localGlobalIdx(ctx, singleton.cacheGlobalIdx)] : undefined;
    if (!singleton || !trampoline || !cache) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} could not allocate its exact singleton support`,
      );
    }
    const functionValuePlan = {
      target,
      trampoline: irSupportFuncRef(unitId, "function-value-trampoline", trampoline.name),
      cacheGlobal: irSupportGlobalRef(unitId, "function-value-cache", cache.name),
    };
    if (!planProgramAbiFunctionValue(ctx, functionValuePlan, trampoline, cache)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} could not freeze its singleton Program ABI`,
      );
    }
    if (
      functionValuePlan.trampoline.binding.kind !== "support" ||
      functionValuePlan.cacheGlobal.binding.kind !== "support"
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} lost its exact support binding identities`,
      );
    }
    receipts.set(
      unitId,
      Object.freeze({
        targetFunction: ctx.programAbiSourceCallables!.functionForUnit(unitId)!,
        targetHandle: funcIdx,
        trampolineFunction: trampoline,
        trampolineHandle: singleton.trampolineFuncIdx,
        trampolineRef: functionValuePlan.trampoline,
        trampolineBindingId: functionValuePlan.trampoline.binding.bindingId,
        cacheGlobal: cache,
        cacheGlobalHandle: singleton.cacheGlobalIdx,
        cacheGlobalRef: functionValuePlan.cacheGlobal,
        cacheGlobalBindingId: functionValuePlan.cacheGlobal.binding.bindingId,
      }),
    );
  }
  return receipts;
}

function recordWholeSourceFailure(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  failure: IrPreparationFailure,
  identityContext?: IrPlanningIdentityContext,
): void {
  if (!identityContext || ctx.irOutcomes === undefined) return;
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (ctx.irOutcomes.some((outcome) => outcome.sourceId === sourceId)) return;
  const target: IrObservedOutcome["target"] = ctx.wasi ? "wasi" : ctx.standalone ? "standalone" : "gc";
  ctx.irOutcomes.push(...buildWholeSourceFailureOutcomes({ sourceFile, identityContext, failure, target }));
}

/** Reconcile raw selection, final preparation, integration, and patch exactly once. */
function recordObservedIrOutcomes(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">,
  report: IrIntegrationReport,
  skippedBodyUnitIds: ReadonlySet<IrUnitId>,
): void {
  if (ctx.irOutcomes === undefined) return;
  const target: IrObservedOutcome["target"] = ctx.wasi ? "wasi" : ctx.standalone ? "standalone" : "gc";
  const reconciled = reconcileIrOverlayOutcomes({
    sourceFile,
    identityPlan: plan.identityPlan,
    initialSelection: plan.selection,
    preparedSelection,
    preparationFailuresByUnitId: plan.preparationFailuresByUnitId,
    skippedBodyUnitIds,
    report,
    existingOutcomes: ctx.irOutcomes,
    target,
  });
  ctx.irOutcomes.push(...reconciled.outcomes);
  for (const diagnostic of reconciled.diagnostics) reportErrorNoNode(ctx, diagnostic);
}

const IR_IMPLICIT_PARAM_PROJECTION_BINARY_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
]);

function collectIrImplicitParamProjectionCandidates(
  declaration: ts.FunctionDeclaration,
): ReadonlySet<ts.ParameterDeclaration> {
  // Projecting an untyped numeric parameter can make an existing builder
  // benchmark newly IR-claimable. Until #3745 migrates the legacy loop-local
  // integer promotion, keep that family on its current optimized path.
  if (declaration.body && containsStringBuilderLoopShape(declaration.body)) return new Set();
  const paramsByName = new Map<string, ts.ParameterDeclaration>();
  for (const parameter of declaration.parameters) {
    if (!parameter.type && ts.isIdentifier(parameter.name)) paramsByName.set(parameter.name.text, parameter);
  }
  const candidates = new Set<ts.ParameterDeclaration>();
  const feedsSupportedShape = (identifier: ts.Identifier): boolean => {
    let child: ts.Node = identifier;
    let parent = child.parent;
    while (ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    if (ts.isBinaryExpression(parent) && IR_IMPLICIT_PARAM_PROJECTION_BINARY_OPS.has(parent.operatorToken.kind)) {
      return parent.left === child || parent.right === child;
    }
    if (
      ts.isPrefixUnaryExpression(parent) &&
      (parent.operator === ts.SyntaxKind.PlusToken || parent.operator === ts.SyntaxKind.MinusToken)
    ) {
      return parent.operand === child;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
      return parent.name.text === "length";
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === child) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === child) return true;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parameter = paramsByName.get(node.text);
      if (parameter && feedsSupportedShape(node)) candidates.add(parameter);
    }
    forEachChild(node, visit);
  };
  if (declaration.body) forEachChild(declaration.body, visit);
  return candidates;
}

// #2949 S5.P — declaration lowering already specializes an implicit-any
// parameter when its call sites establish one concrete ABI. Project
// that same decision into structural selection and the IR override map so a
// claimed function cannot widen to dynamic and then lose ABI parity after
// the direct callable has been allocated.
interface IrImplicitParamProjection {
  readonly kind: "f64" | "bool" | "string" | "object" | "dynamic";
  readonly type: IrType;
}

function makeIrImplicitParamTypeResolver(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  moduleBindingResolver?: IrModuleBindingResolver,
): (parameter: ts.ParameterDeclaration) => IrImplicitParamProjection | undefined {
  const candidatesByDeclaration = new WeakMap<ts.FunctionDeclaration, ReadonlySet<ts.ParameterDeclaration>>();
  return (parameter) => {
    if (parameter.type) return undefined;
    const declaration = parameter.parent;
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || declaration.parent !== sourceFile) {
      return undefined;
    }
    let candidates = candidatesByDeclaration.get(declaration);
    if (!candidates) {
      candidates = collectIrImplicitParamProjectionCandidates(declaration);
      const onlyStatement = declaration.body?.statements.length === 1 ? declaration.body.statements[0] : undefined;
      const returned = onlyStatement && ts.isReturnStatement(onlyStatement) ? onlyStatement.expression : undefined;
      const returnedCall = returned && ts.isCallExpression(returned) ? returned : undefined;
      const receiverFirstPlan = returnedCall
        ? (moduleBindingResolver?.retainedFunctionMethodPlan(returnedCall) ??
          moduleBindingResolver?.fnctorArrayMethodPlan(returnedCall))
        : undefined;
      if (receiverFirstPlan && returnedCall) {
        const projected = new Set(candidates);
        for (let index = 0; index < declaration.parameters.length; index++) {
          const argument = returnedCall.arguments[index];
          const candidate = declaration.parameters[index]!;
          if (
            argument &&
            ts.isIdentifier(argument) &&
            ts.isIdentifier(candidate.name) &&
            ctx.oracle.valueDeclarationOf(argument) === ctx.oracle.valueDeclarationOf(candidate.name)
          ) {
            projected.add(candidate);
          }
        }
        candidates = projected;
      }
      candidatesByDeclaration.set(declaration, candidates);
    }
    if (!candidates.has(parameter)) return undefined;
    const parameterFact = ctx.oracle.typeFactOf(parameter);
    if (parameterFact.kind !== "any" && parameterFact.kind !== "unknown") return undefined;
    const parameterIndex = declaration.parameters.indexOf(parameter);
    if (parameterIndex < 0) return undefined;
    const callSites = inferParamTypeFromCallSites(ctx, declaration.name.text, parameterIndex, sourceFile);
    if (callSites.sawCallSite && callSites.type === null) {
      return { kind: "dynamic", type: irDynamic() };
    }
    const inferred = inferImplicitAnyParamType(ctx, declaration.name.text, parameterIndex, sourceFile, declaration);
    if (inferred?.kind === "f64") return { kind: "f64", type: irVal(inferred) };
    if (inferred?.kind === "i32" && inferred.boolean === true) {
      return { kind: "bool", type: irVal(inferred) };
    }
    if (
      inferred?.kind === "ref" &&
      ctx.nativeStrings &&
      ctx.anyStrTypeIdx >= 0 &&
      inferred.typeIdx === ctx.anyStrTypeIdx
    ) {
      return { kind: "string", type: { kind: "string" } };
    }
    if (inferred?.kind === "ref" || inferred?.kind === "ref_null") {
      const structName = ctx.typeIdxToStructName.get(inferred.typeIdx);
      if (structName === "__vec_f64") {
        return { kind: "object", type: irVec(irVal({ kind: "f64" }), true) };
      }
      if (structName?.startsWith("__vec_") || structName?.startsWith("__arr_")) {
        return { kind: "object", type: irVal(inferred) };
      }
    }
    return undefined;
  };
}

function resolveIrOverrideParamType(
  parameter: ts.ParameterDeclaration,
  mapped: LatticeType | undefined,
  ctx: CodegenContext,
  classShapes: IrClassShapeLookup,
  resolveImplicitParamType: ReturnType<typeof makeIrImplicitParamTypeResolver>,
): IrType {
  const projected = resolveImplicitParamType(parameter);
  // Keep the established numeric parity-withdrawal path (#3551): lattice f64
  // may still form the speculative IR view, and the patch-time ABI guard then
  // withdraws the complete caller cluster if legacy kept the param dynamic.
  // Nonnumeric mapped kinds cannot lower polymorphic equality soundly before
  // that guard (the #3471 string failure), so those retain the direct dynamic
  // ABI in the IR view.
  if (projected && !(projected.kind === "dynamic" && mapped?.kind === "f64")) return projected.type;
  return resolvePositionType(effectiveIrParamTypeNode(parameter), mapped, ctx, classShapes);
}

function planIrOverlay(
  ctx: CodegenContext,
  ast: TypedAST,
  identityContext: IrPlanningIdentityContext,
  options: {
    readonly resolveModuleBindings?: boolean;
    readonly importedFunctions?: irOverlayIdentity.IrIdentityImportedFunctionResolver;
  } = {},
): IrOverlayPlan {
  const identityImportedFunctions = options.importedFunctions;
  const legacyImportedFunctions = irOverlayIdentity.projectIrOverlayImportedResolver(identityImportedFunctions);
  let identityMaps: irOverlayIdentity.IrOverlayIdentityMaps;
  try {
    if (process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW === "1") {
      throw new Error("injected TypeMap failure");
    }
    identityMaps = irOverlayIdentity.buildIrOverlayIdentityMaps(
      ast.sourceFile,
      ast.checker,
      identityContext,
      ctx.dtsEntrypointSeeds,
    );
  } catch (error) {
    throw new IrInvariantError(
      "type-map-failure",
      "resolve",
      `IR TypeMap failed for ${ast.sourceFile.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  // #1169q telemetry — when JS2WASM_LOG_IR_FALLBACKS is set, request the
  // selector to track every top-level FunctionDeclaration that didn't
  // make it into `funcs` along with the rejection reason. Logged to
  // stderr at end of compile. Off by default (zero overhead).
  // #1530 — `trackFallbacks` is also enabled when one or more
  // selector-rejection reasons are in `STRICT_IR_REASONS`. The set
  // starts empty (purely a hook for follow-up PRs); when populated,
  // selector rejections of those reasons promote from a silent skip
  // to a hard error so the IR path becomes the only path for the
  // affected node kinds. Telemetry mode (`JS2WASM_LOG_IR_FALLBACKS=1`)
  // continues to enable the histogram log; the strict set additionally
  // forces collection.
  const logFallbacks = process.env.JS2WASM_LOG_IR_FALLBACKS === "1" || STRICT_IR_REASONS.size > 0;
  const collectFallbacks = ctx.irOutcomes !== undefined || logFallbacks;
  const preparationFailuresByUnitId = new Map<IrUnitId, IrPreparationFailure>();
  // (#2856) Host-extern claiming: mode gate + checker-backed ambient-global
  // resolution. Selection runs BEFORE `collectDeclaredGlobals` /
  // `collectUsedExternImports` populate the ctx registries, so the selector
  // cannot read them — it gets the checker-derived answer instead (which is
  // also shadow-exact: a user binding named `document` resolves to the user
  // declaration, never the lib global). The registries ARE populated by the
  // time from-ast lowers (post-`compileDeclarations`), which is where member
  // resolution happens.
  const irTargetProfile = projectIrBackendTargetProfile(ctx.targetProfile, { fast: ctx.fast });
  const jsHostExterns = irTargetProfile.allowHostImports;
  const standaloneDomCapability = planStandaloneDomCapability(ctx, ast.checker, ast.sourceFile);
  const supportsBackendCapability = (capability: IrBackendTargetCapability): boolean =>
    supportsIrBackendTargetCapability(irTargetProfile, capability);
  const calendarResolvers = planIrCalendarResolvers(
    ast.checker,
    jsHostExterns,
    supportsBackendCapability("host-date-snapshot"),
    standaloneDomCapability,
    ctx.requiresStandaloneClockCapability === true,
  );
  const backendCapabilitySelectionOptions = {
    supportsBackendCapability: (capability: IrBackendTargetCapability): boolean =>
      capability === "host-date-snapshot"
        ? calendarResolvers.supportsDateSnapshots
        : supportsBackendCapability(capability),
  };
  const resolveModuleBinding =
    options.resolveModuleBindings === false
      ? undefined
      : makeIrModuleBindingResolver(
          ast.checker,
          {
            numberStorage: ctx.fast ? "i32" : "f64",
            oracle: ctx.oracle,
            allowHostExterns: jsHostExterns && !ctx.nativeStrings,
            allowBuiltinMapExtern: jsHostExterns && !ctx.nativeStrings,
            // (#4461) The complementary carrier: native strings ⇒ `Map` lives
            // in the WasmGC `$Map` struct, so the binding is representable
            // here even though the extern handle is not.
            allowNativeMapStorage: ctx.nativeStrings,
            resolveCapabilityExternBinding: standaloneDomCapability?.moduleBinding,
            allowBoundedTopLevelAccessorSelectionCandidates: true,
            stableFnctorArrayPrototypeNames: ctx.fnctorEscapeGate?.stableArrayPrototypeNames,
          },
          identityContext,
        );
  const classifyPrimitiveExpression = makeIrPrimitiveExpressionClassifier(ast.checker);
  const classifyDeclaredPrimitiveExpression = makeIrDeclaredPrimitiveExpressionClassifier(ast.checker);
  const isArrayExpression = makeIrArrayExpressionPredicate(ast.checker);
  const isRegExpExpression = makeIrRegExpExpressionPredicate(ast.checker);
  const resolveAmbientClassCall =
    jsHostExterns && options.resolveModuleBindings !== false ? makeIrAmbientClassCallResolver(ast.checker) : undefined;
  const supportsHostPromiseDelay = jsHostExterns && !ctx.fast && !ctx.nativeStrings;
  const supportsStandalonePromiseDelay =
    ctx.standalone &&
    ctx.nativeStrings &&
    !ctx.wasi &&
    !ctx.fast &&
    ctx.targetProfile.semanticProviders === "native-first";
  const resolvePromiseDelay =
    (supportsHostPromiseDelay || supportsStandalonePromiseDelay) && options.resolveModuleBindings !== false
      ? makeIrPromiseDelayResolver(ast.checker)
      : undefined;
  const timerShim = irTimerShim.timerShimResolver(ast.checker, ctx, options.resolveModuleBindings);
  // Selection gets a provisional descriptor population; lowering rebuilds it from exact selected UnitIds.
  const selectionClassShapeSidecar = buildIrClassShapes(ctx, ast.sourceFile, identityContext, {
    kind: "selection-candidate",
  });
  const selectionClassShapes = selectionClassShapeSidecar.legacyProjection;
  const selectionClassShapesById = new Map(
    [...selectionClassShapeSidecar.byClassId].map(([classId, entry]) => [classId, entry.shape] as const),
  );
  const resolveLocalClassExpression = makeIrLocalClassExpressionResolver(
    ast.checker,
    ast.sourceFile,
    selectionClassShapes,
    identityContext,
  );
  // (#3053 U2) Fast host-js-string (`fast && !standalone && !wasi`) has the carrier in
  // the gc `$AnyValue` but strings are host js-string externrefs, so the native
  // honest classifier mis-tags reads and the body is invalid. Gate the dynamic
  // member-read claim off in that ONE config (clean pre-claim rejection, not a
  // claim-then-demote). The carrier keying in `ensureDynMemberGet` matches
  // (`ctx.fast`), so every claimed config emits a valid, carrier-aligned body.
  const dynMemberReadBuildable = !(ctx.fast && !ctx.standalone && !ctx.wasi);
  const resolveImplicitParamType = makeIrImplicitParamTypeResolver(ctx, ast.sourceFile, resolveModuleBinding);
  const implicitParamUsesNumericVecAbi = (parameter: ts.ParameterDeclaration): boolean => {
    const projection = resolveImplicitParamType(parameter);
    if (projection?.kind !== "object") return false;
    if (projection.type.kind === "vec") return asVal(projection.type.elementType)?.kind === "f64";
    const valueType = asVal(projection.type);
    if (valueType?.kind !== "ref" && valueType?.kind !== "ref_null") return false;
    return ctx.typeIdxToStructName.get(valueType.typeIdx) === "__vec_f64";
  };
  const legacyCallerAbiIsProjected = (declaration: ts.FunctionDeclaration): boolean => {
    // (#3518) The certified surface now includes `string` positions, whose
    // carrier both front-ends derive from the SAME `ctx.nativeStrings` /
    // `ctx.anyStrTypeIdx` pair. `functionReturnsDynamicObjectCarrier` is the one
    // legacy return-carrier override that no annotation predicts, so it is
    // handed in as evidence rather than re-derived.
    if (hasFullyAnnotatedScalarAbi(declaration, { returnCarrierIsOverridden: functionReturnsDynamicObjectCarrier })) {
      return true;
    }
    // The exact delay slot is frozen as `(f64, f64) -> externref` in both
    // runtime projections, so a direct-only caller does not force this
    // prepared callee back onto direct ownership.
    if (resolvePromiseDelay?.resolveOwner(declaration)) return true;
    const onlyStatement = declaration.body?.statements.length === 1 ? declaration.body.statements[0] : undefined;
    const returned = onlyStatement && ts.isReturnStatement(onlyStatement) ? onlyStatement.expression : undefined;
    if (
      returned &&
      ts.isCallExpression(returned) &&
      (resolveModuleBinding?.retainedFunctionMethodPlan(returned) !== undefined ||
        resolveModuleBinding?.fnctorArrayMethodPlan(returned) !== undefined)
    ) {
      // #3793 — the exact retained wrapper uses the existing receiver-first
      // externref dispatcher and the implicit-param resolver above projects
      // every wrapper argument from the same direct declaration ABI.
      return true;
    }
    let hasIndexedCarrier = false;
    let hasBooleanProjection = false;
    let allProjectionsAreBoolean = true;
    let hasNonFastScalarProjection = false;
    let allProjectionsAreNonFastStable = true;
    let allPositionsAreExplicitNumbers = true;
    for (const parameter of declaration.parameters) {
      const explicitType = effectiveIrParamTypeNode(parameter);
      if (explicitType) {
        if (explicitType.kind !== ts.SyntaxKind.NumberKeyword) allPositionsAreExplicitNumbers = false;
        continue;
      }
      allPositionsAreExplicitNumbers = false;
      const projection = resolveImplicitParamType(parameter);
      if (!projection) {
        if (ctx.fast) return false;
        // In the non-fast ABI an unresolved implicit parameter remains the
        // generic externref carrier in both front-ends. The IR selector maps
        // the same unknown evidence to `dynamic`, whose non-fast carrier is
        // also externref.
        hasNonFastScalarProjection = true;
        continue;
      }
      if (projection.kind === "object") hasIndexedCarrier = true;
      if (projection.kind === "bool") hasBooleanProjection = true;
      else allProjectionsAreBoolean = false;
      if (projection.kind === "f64" || projection.kind === "dynamic") {
        hasNonFastScalarProjection = true;
      } else {
        allProjectionsAreNonFastStable = false;
      }
    }
    const returnType = effectiveIrReturnTypeNode(declaration);
    const hasExactScalarNumberAbi =
      allPositionsAreExplicitNumbers &&
      returnType?.kind === ts.SyntaxKind.NumberKeyword &&
      detectArrayReduceFusion(ctx, declaration.body).length > 0;
    return (
      hasExactScalarNumberAbi ||
      hasIndexedCarrier ||
      (hasBooleanProjection && allProjectionsAreBoolean) ||
      (!ctx.fast && hasNonFastScalarProjection && allProjectionsAreNonFastStable)
    );
  };
  const identityPlan = irOverlayIdentity.planIrOverlayByIdentity(
    ast.sourceFile,
    identityContext,
    {
      experimentalIR: true,
      trackFallbacks: collectFallbacks,
      jsHostExterns,
      ...(standaloneDomCapability ? { standaloneDomCapability } : {}),
      dynMemberReadBuildable,
      dynamicRuntimeBuildable: !ctx.fast,
      // #2952 slice 5 — for-in currently owns only the non-fast dynamic
      // carrier, which is already externref and can feed the shared
      // enumeration helpers without a representation conversion.
      isDynamicForInReceiver: (receiver) => {
        if (ctx.fast) return false;
        const fact = ctx.oracle.typeFactOf(receiver);
        return fact.kind === "any" || fact.kind === "unknown";
      },
      // #2952 slice 6c — reading the enumerated key in the body needs the
      // head slot (an externref from the #2964 helpers) to BE the string
      // carrier. That holds exactly when `resolveString()` yields externref,
      // i.e. when native strings are off.
      forInHeadValueIsHostString: !ctx.nativeStrings,
      resolveHostGlobal: makeIrHostGlobalResolver(ast.checker),
      ...(calendarResolvers.hostVoidCallback ? { hostVoidCallbacks: calendarResolvers.hostVoidCallback } : {}),
      ...(resolveAmbientClassCall ? { ambientClassCalls: resolveAmbientClassCall } : {}),
      ...(calendarResolvers.hostDateSnapshot ? { hostDateSnapshots: calendarResolvers.hostDateSnapshot } : {}),
      ...(resolvePromiseDelay ? { promiseDelays: resolvePromiseDelay } : {}),
      ...(resolveModuleBinding ? { resolveModuleBinding } : {}),
      classifyPrimitiveExpression,
      classifyDeclaredPrimitiveExpression,
      isArrayExpression,
      isRegExpExpression,
      isHoleyArrayConstructor: (expr) => ctx.holeyArrayConstructorNodes.has(expr),
      isHoleyArrayFilterCall: (expr) => ctx.holeyArrayFilterCallNodes.has(expr),
      supportsHoleyArrayFilter: ctx.standalone,
      resolveImplicitParamType: (parameter) => resolveImplicitParamType(parameter)?.kind,
      implicitParamUsesNumericVecAbi,
      legacyCallerAbiIsProjected,
      projectedClassShapes: selectionClassShapes,
      projectedClassShapesById: selectionClassShapesById,
      nestedClassMemberCallableAvailable: (unitId) =>
        ctx.programAbiClassCallables?.functionForUnit(unitId) !== undefined,
      ...irTimerShim.preparedTimerShimSelectionOption(timerShim),
      resolveLocalClassExpression,
      supportsSymbolicMathHelpers: true,
      supportsLiteralStringReplace: true,
      // (#4462) Host-free capabilities. Both are the SAME predicates the
      // from-ast resolver exposes, so claim and lowering cannot disagree; the
      // selector ORs `supportsNumberToString` with the host-import capability,
      // so this only adds the native-string lanes.
      supportsNumberToString: irNativeNumberToStringAvailable(ctx),
      supportsNumberToFixed: irNativeNumberToFixedAvailable(ctx),
      supportsStandaloneConsoleSink: standaloneConsoleSinkAvailable(ctx),
      supportsStringArrayLiterals: !ctx.fast && (jsHostExterns || ctx.nativeStrings),
      supportsHostIndirectEval: jsHostExterns && !ctx.nativeStrings,
      ...backendCapabilitySelectionOptions,
      ...(jsHostExterns && legacyImportedFunctions ? { importedFunctions: legacyImportedFunctions } : {}),
      // (#1373b C-1) Async claim gate: IR claims an async fn IFF the ONE
      // async engine ($AsyncFrame drive / host-drive) declines it — the
      // legacy sync-pass-through population. Engine-activated functions keep
      // byte-identical routing.
      ...prepareIrAsyncSelectionOptions(ctx, resolvePromiseDelay),
    },
    identityMaps,
  );
  const functionClaimsByUnitId = buildIrExactFunctionClaimIndex(
    ast.sourceFile,
    identityContext,
    identityPlan.functionClaims,
  );
  const recordPreparationFailure = (legacyName: string, failure: IrPreparationFailure): void =>
    recordIrOverlayPreparationFailure({ identityPlan, preparationFailuresByUnitId }, legacyName, failure);
  const selection = identityPlan.selectionProjection.selection;
  const classShapeSidecar = buildIrClassShapes(ctx, ast.sourceFile, identityContext, {
    kind: "selected",
    unitIds: selection.classMemberUnitIds ?? new Set(),
  });
  const classShapes = classShapeSidecar.legacyProjection;
  const classShapesById = new Map(
    [...classShapeSidecar.byClassId].map(([classId, entry]) => [classId, entry.shape] as const),
  );
  // #1530 — when a rejection reason is listed in STRICT_IR_REASONS,
  // promote every fallback with that reason to a hard compile error
  // instead of letting the legacy path silently catch it. The set
  // starts empty; once a bucket hits zero against
  // `scripts/ir-fallback-baseline.json`, that bucket's reason can be
  // added here in a follow-up PR.
  if (STRICT_IR_REASONS.size > 0 && selection.fallbacks) {
    for (const fb of selection.fallbacks) {
      if (STRICT_IR_REASONS.has(fb.reason)) {
        reportErrorNoNode(
          ctx,
          `IR path strict mode: ${fb.name} rejected with reason "${fb.reason}" — this reason is required to be zero (see plan/log/ir-adoption.md).`,
        );
      }
    }
  }
  const promiseDelayByOwner = collectIrPromiseDelayOwners(
    ast.sourceFile,
    new Set(identityPlan.identitySelection.funcs.keys()),
    resolvePromiseDelay,
    identityContext,
  );
  // Build per-function IR type overrides from the propagated TypeMap.
  // For a claimed function, the selector must have resolved each
  // param + return to a concrete primitive via either an explicit
  // TS annotation OR the TypeMap. We mirror that resolution here to
  // build the override map: for each position, prefer the AST
  // annotation (authoritative) and fall back to the TypeMap only
  // when the AST lacks one. If neither yields a concrete primitive,
  // that position is a compiler bug — the selector should not have
  // claimed this function.
  //
  // The override map also feeds the `calleeTypes` in the lowerer so
  // direct calls to IR-path callees see the right signature.
  // Slice 14 (#1228) — `returnType: IrType | null` where `null` means
  // a void-returning function (zero Wasm result types). Plumbs through
  // `compileIrPathFunctions` to `from-ast.ts` so the IR builder can be
  // constructed with `[]` results and the lowerer can accept bare
  // `return;` / fall-through tails.
  const overrideMapByUnitId = new Map<IrUnitId, { params: IrType[]; returnType: IrType | null }>();
  const overrideMap = new Map<string, { params: IrType[]; returnType: IrType | null }>();
  const declByName = identityPlan.declarationByLegacyName;
  for (const { unitId, legacyName: name, declaration, typeEntry: entry } of identityPlan.functionClaims) {
    try {
      // Slice 7a (#1169f) — generator functions return an externref
      // (the JS Generator-like object built by `__create_generator`)
      // regardless of the source-level annotation
      // (`Generator<number>`, `IterableIterator<T>`, etc.). The IR
      // lowerer enforces this; the override map needs to agree so
      // the cross-function `calleeTypes` lookup sees the right
      // signature. Bypass `resolvePositionType` for the return type
      // — `Generator<T>` doesn't resolve as `IrType.object` and
      // would otherwise drop the generator from `safeSelection`.
      const isGenerator = !!declaration.asteriskToken;
      // (#1373b C-1) IR-claimed async fns (sync-pass-through model) register
      // the raw `T` unwrapped from the `Promise<T>` annotation — matching
      // the declaration pre-pass's `unwrapPromiseType` result type, so the
      // IR-lowered signature equals the legacy-registered one (the #1796
      // call-site contract stays intact). The selector only claims asyncs
      // with an explicit `Promise<T>` annotation, so the unwrap is non-null
      // for every claimed async fn.
      const isAsyncFn = !isGenerator && hasAsyncModifier(declaration);
      const asyncUnwrapped = isAsyncFn ? unwrapPromiseTypeNode(declaration.type) : null;
      const effectiveReturnNode = isAsyncFn ? (asyncUnwrapped ?? undefined) : declaration.type;
      // Slice 14 (#1228) — VoidKeyword return: bypass resolvePositionType
      // (it has no representation for void in IrType) and set returnType
      // to null. The lowerer treats null returnType as "no result".
      const isVoidReturn = !isGenerator && effectiveReturnNode?.kind === ts.SyntaxKind.VoidKeyword;
      const returnType: IrType | null = promiseDelayByOwner.has(unitId)
        ? ({ kind: "extern", className: "Promise" } as IrType)
        : isGenerator
          ? ({ kind: "val", val: { kind: "externref" } } as IrType)
          : isVoidReturn
            ? null
            : resolvePositionType(effectiveReturnNode, entry?.returnType, ctx, classShapeSidecar);
      const params: IrType[] = [];
      for (let i = 0; i < declaration.parameters.length; i++) {
        const p = declaration.parameters[i]!;
        params.push(resolveIrOverrideParamType(p, entry?.params[i], ctx, classShapeSidecar, resolveImplicitParamType));
      }
      const override = { params, returnType };
      overrideMapByUnitId.set(unitId, override);
      overrideMap.set(name, override);
      identityPlan.safeFunctionUnitIds.add(unitId);
    } catch (e) {
      // Selector claimed a function whose types can't be resolved —
      // skip the IR path for this one. Fall through to legacy.
      //
      // #1921 — this is a deliberate IR→legacy fallback, not a compile
      // error: the legacy path still produces a working body for `name`.
      // Emit severity "warning" so it stays visible to bridge tests but
      // does NOT fail the build (consistent with the IR-fallback channel
      // at `formatIrPathFallbackDiagnostic` above). Defaulting to "error"
      // would fail every program with a class-typed cross-function return
      // that the IR lowerer can't yet represent (e.g. a `Builder` chain).
      //
      // #2137 — also record this on the structured `irPostClaimErrors`
      // channel (kind "resolve") so consumers (bridge tests, the
      // check:ir-fallbacks gate) can query IR-path fallbacks without
      // string-matching the diagnostics array. The warning line below is
      // retained one sprint for back-compat.
      //
      // (#2138) NOTE: a resolve-time drop is exactly why `safeSelection`
      // — not the raw `selection` — feeds `computeIrFirstSkipSet`: this
      // function keeps its legacy body under IR-first.
      const resolveMsg = e instanceof Error ? e.message : String(e);
      recordPreparationFailure(name, {
        kind: "unsupported",
        code: "type-resolution-unsupported",
        stage: "resolve",
        detail: resolveMsg,
        cause: e,
      });
      (ctx.irPostClaimErrors ??= []).push({
        kind: "resolve",
        func: name,
        message: resolveMsg,
      });
      reportErrorNoNode(ctx, `IR path: could not resolve types for ${name}: ${resolveMsg}`, "warning");
    }
  }
  // Only request IR compilation for functions we successfully built
  // overrides for (the selector may have claimed more, but if we
  // couldn't map types safely we leave them to legacy).
  //
  // #1370 Phase B: thread `classMembers` through to the integration
  // loop. Class methods don't go through `overrideMap` (they're
  // typed via the class shape, not the TypeMap-derived overrides);
  // the integration's class-member walk consults `classShapes`
  // directly. Pass the set unmodified.
  const safeSelection: {
    funcs: Set<string>;
    classMembers?: ReadonlySet<string>;
    classMemberUnitIds?: ReadonlySet<IrUnitId>;
    moduleInit?: import("../ir/select.js").IrModuleInitAssessment;
  } = {
    funcs: irOverlayIdentity.projectIrSafeFunctionNames(identityPlan.safeFunctionUnitIds, identityPlan),
    classMembers: selection.classMembers,
    classMemberUnitIds: selection.classMemberUnitIds,
    // (#3142 Slice 2) Forward the module-init claim. A resolve-time drop of
    // one of the unit's callees is self-limiting: the integration builds
    // `calleeTypes` from safeSelection.funcs, so a call to a dropped callee
    // throws at build time and the unit demotes to the legacy body.
    moduleInit: selection.moduleInit,
  };
  // (#2928) The linked runtime-eval carrier is currently owned by the legacy
  // WasmGC closure/object runtime. Its recursive cross-module types may be
  // registered while module-init writes are compiled, after legacy function
  // signatures but before the IR overlay is installed; mixing the two paths
  // would violate IR/legacy type-index parity. Keep the whole runtime-eval unit
  // on one backend until the typed IR owns this carrier explicitly.
  if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalBoundaryPlan?.callableBoundaryRequired === true) {
    const failure: IrPreparationFailure = {
      kind: "unsupported",
      code: "late-preparation-unsupported",
      stage: "resolve",
      detail: "the linked runtime-eval callable carrier is still owned by the direct frontend",
    };
    for (const name of safeSelection.funcs) recordPreparationFailure(name, failure);
    for (const name of safeSelection.classMembers ?? []) recordPreparationFailure(name, failure);
    if (safeSelection.moduleInit?.reason === null && safeSelection.moduleInit.stmtCount > 0) {
      recordPreparationFailure(MODULE_INIT_UNIT_NAME, failure);
    }
    safeSelection.funcs.clear();
    identityPlan.safeFunctionUnitIds.clear();
    safeSelection.classMembers = new Set();
    safeSelection.classMemberUnitIds = new Set();
    safeSelection.moduleInit = undefined;
  }
  // (#2023) The IR `new C(...)` lowering does not thread the new.target
  // class-id (that machinery lives only on the legacy path). When the
  // program uses `new.target`, route every function through legacy so the
  // outermost-`new` global is set/restored at each construction site. This
  // is a coarse but safe gate — `new.target` is rare, so the perf cost is
  // negligible and it avoids a parallel IR implementation of the threading.
  // (#2138: `ctx.usesNewTarget` is written only by `scanForNewTarget`, which
  // runs BEFORE `collectDeclarations` — so this gate reads the same value at
  // either pipeline position, plan-before or plan-after the body pass.)
  if (ctx.usesNewTarget) {
    for (const name of safeSelection.funcs) {
      recordPreparationFailure(name, {
        kind: "unsupported",
        code: "new-target-threading",
        stage: "resolve",
        detail: "new.target threading is still owned by the direct frontend",
      });
    }
    for (const name of safeSelection.classMembers ?? []) {
      recordPreparationFailure(name, {
        kind: "unsupported",
        code: "new-target-threading",
        stage: "resolve",
        detail: "new.target threading is still owned by the direct frontend",
      });
    }
    if (safeSelection.moduleInit?.reason === null && safeSelection.moduleInit.stmtCount > 0) {
      recordPreparationFailure(MODULE_INIT_UNIT_NAME, {
        kind: "unsupported",
        code: "new-target-threading",
        stage: "resolve",
        detail: "new.target threading is still owned by the direct frontend",
      });
    }
    safeSelection.funcs.clear();
    identityPlan.safeFunctionUnitIds.clear();
    safeSelection.classMembers = new Set();
    safeSelection.classMemberUnitIds = new Set();
    // (#3142 Slice 2) The module-init unit routes through legacy too.
    safeSelection.moduleInit = undefined;
  }
  const promiseDelays = buildIrPromiseDelayLoweringPlans(
    promiseDelayByOwner,
    identityPlan.safeFunctionUnitIds,
    identityContext,
    supportsStandalonePromiseDelay ? "standalone-native" : "host-executor",
  );
  const { importedCalls, topLevelFunctionValues } = planIrImportedCalls({
    ctx,
    identityPlan,
    preparationFailuresByUnitId,
    ...(jsHostExterns && identityImportedFunctions ? { identityImportedFunctions, legacyImportedFunctions } : {}),
    ...(timerShim ? { resolvePreparedTimerShim: timerShim } : {}),
    ...(resolveAmbientClassCall ? { resolveAmbientClassCall } : {}),
    classShapeSidecar,
    safeSelection,
    resolvePositionType: (node, mapped, classShapes) => resolvePositionType(node, mapped, ctx, classShapes),
  });
  const calendarLoweringPlans = collectIrCalendarLoweringPlans({
    ctx,
    sourceFile: ast.sourceFile,
    identityPlan,
    safeSelection,
    resolvers: calendarResolvers,
    standaloneDomReusable: standaloneDomCapability?.requiresInteraction === true,
  });
  return {
    identityPlan,
    functionClaimsByUnitId,
    selection,
    classShapeSidecar,
    classShapes,
    classShapesById,
    overrideMapByUnitId,
    overrideMap,
    safeSelection,
    logFallbacks,
    preparationFailuresByUnitId,
    declByName,
    importedCalls,
    topLevelFunctionValues,
    ...calendarLoweringPlans,
    promiseDelays,
    suspendingAsyncUnitIds: collectPreparedIrAsyncOwners(ctx, identityPlan, safeSelection.funcs),
    ...(options.importedFunctions ? { importedFunctionResolver: options.importedFunctions } : {}),
  };
}

/** Consume one IR overlay attempt through the shared diagnostics/telemetry path. */
function consumeIrOverlayReport(
  ctx: CodegenContext,
  report: IrIntegrationReport,
  plan: IrOverlayPlan,
  preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">,
  sourceFile: ts.SourceFile,
  skippedFunctionUnitIds: ReadonlySet<IrUnitId> = new Set(),
  skippedClassMemberUnitIds: ReadonlySet<IrUnitId> = new Set(),
  skippedModuleInitUnitIds: ReadonlySet<IrUnitId> = new Set(),
): void {
  const { selection, logFallbacks } = plan;
  // #3000 — aggregate genuine emission across every source-file overlay. A
  // selector claim alone is not evidence that an existing function slot was
  // patched successfully.
  ctx.irCompiledFuncs = [...(ctx.irCompiledFuncs ?? []), ...report.compiled];

  for (const err of report.errors) {
    // #1923 — selector-claimed functions that fail build/verify/lower are
    // metered even when their already-emitted legacy bodies remain usable.
    (ctx.irPostClaimErrors ??= []).push({
      kind: err.kind ?? "lower",
      func: err.func,
      message: err.message,
    });
    const diag = formatIrPathFallbackDiagnostic(err, ctx);
    ctx.errors.push({
      message: diag.message,
      line: 0,
      column: 0,
      severity: diag.severity,
    });
  }

  // #2138/#3520 — prove every skipped slot from exact terminal evidence. Raw
  // name arrays (`compiled` / `errors.func`) are diagnostics, not safety proof.
  for (const violation of auditIrSkippedFunctionSlots({
    sourceFile,
    identityPlan: plan.identityPlan,
    preparedSelection,
    skippedFunctionUnitIds,
    report,
  })) {
    reportErrorNoNode(
      ctx,
      `IR-first (#2138): ${violation.failure.detail} [${violation.failure.code}; ${violation.unitId}]`,
    );
  }

  for (const violation of auditIrSkippedClassMemberSlots({
    sourceFile,
    identityPlan: plan.identityPlan,
    preparedSelection,
    skippedClassMemberUnitIds,
    report,
  })) {
    reportErrorNoNode(
      ctx,
      `IR-first (#3522): ${violation.failure.detail} [${violation.failure.code}; ${violation.unitId}]`,
    );
  }

  for (const violation of auditIrSkippedModuleInitSlot({
    sourceFile,
    identityPlan: plan.identityPlan,
    preparedSelection,
    skippedModuleInitUnitIds,
    report,
  })) {
    reportErrorNoNode(
      ctx,
      `IR-first (#3523): ${violation.failure.detail} [${violation.failure.code}; ${violation.unitId}]`,
    );
  }

  recordObservedIrOutcomes(
    ctx,
    sourceFile,
    plan,
    preparedSelection,
    report,
    new Set([...skippedFunctionUnitIds, ...skippedClassMemberUnitIds, ...skippedModuleInitUnitIds]),
  );

  // #1169q — retain the existing selector-fallback log format, now once per
  // source file for a multi-module compilation.
  if (logFallbacks && selection.fallbacks) {
    const total = selection.funcs.size + selection.fallbacks.length;
    const reasonHist: Record<string, number> = {};
    for (const fb of selection.fallbacks) {
      reasonHist[fb.reason] = (reasonHist[fb.reason] ?? 0) + 1;
    }
    const reasonStr = Object.entries(reasonHist)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`)
      .join(",");
    process.stderr.write(
      `[ir-fallback] file=${sourceFile.fileName || "<source>"} total=${total} claimed=${selection.funcs.size} fallback=${selection.fallbacks.length} reasons=${reasonStr}\n`,
    );
    // (#4457) Per-unit attribution. The histogram above names the bucket but
    // not WHICH unit hit WHICH reject arm, so a lane sitting on N
    // `body-shape-rejected` units cannot be grouped into coherent fixes. The
    // `detail` field is populated by select.ts only under
    // JS2WASM_IR_SHAPE_DIAG=1, so this line is silent on the normal path.
    if (process.env.JS2WASM_IR_SHAPE_DIAG === "1") {
      for (const fb of selection.fallbacks) {
        process.stderr.write(
          `[ir-fallback-unit] file=${sourceFile.fileName || "<source>"} name=${fb.name} reason=${fb.reason} arm=${fb.detail ?? "<none>"}\n`,
        );
      }
    }
  }
}

function functionBodyHasUnsupportedImportUse(fn: ts.FunctionDeclaration, plan: IrOverlayPlan): boolean {
  if (!fn.body || !plan.importedFunctionResolver) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && plan.importedFunctionResolver?.isImportBinding(node)) {
      const parent = node.parent;
      const isCertifiedDirectCall =
        ts.isCallExpression(parent) && parent.expression === node && plan.importedCalls.has(parent);
      if (!isCertifiedDirectCall) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

/** Nested functions mint flat synthetic names that M0 cannot collision-prove. */
function functionBodyContainsNestedRuntimeDeclaration(fn: ts.FunctionDeclaration, plan: IrOverlayPlan): boolean {
  if (!fn.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isArrowFunction(node) && plan.hostVoidCallbacks.has(node)) {
      // B2 owns this one synthesized closure. Keep walking its body so a
      // nested function/class still trips the conservative M0 collision gate.
      ts.forEachChild(node.body, visit);
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

function typeFactCouldBeCallable(fact: TypeFact): boolean {
  if (fact.kind === "function") return true;
  if (fact.kind === "union") return fact.parts.some(typeFactCouldBeCallable);
  // This is a safety gate: an incomplete fact must reduce M0 coverage rather
  // than let a legacy caller cross an ABI boundary we have not proven.
  return fact.kind === "any" || fact.kind === "unknown" || fact.kind === "unresolvable";
}

/** Callable parameters/returns still have a legacy↔IR wrapper ABI boundary. */
function functionHasCallableBoundary(ctx: CodegenContext, declaration: ts.FunctionDeclaration): boolean {
  for (const parameter of declaration.parameters) {
    const typeNode = effectiveIrParamTypeNode(parameter);
    // A checker-certified exact FunctionTypeNode uses the same canonical
    // callable ABI in both front-ends. Host A+B1 can therefore retain an
    // imported HOF target instead of demoting its whole cross-file component.
    if (typeNode && ts.isFunctionTypeNode(typeNode) && irClosureSignatureFromFunctionTypeNode(typeNode)) continue;
    if (typeFactCouldBeCallable(ctx.oracle.typeFactOf(parameter))) return true;
  }
  const signature = ctx.oracle.signatureOf(declaration);
  // Unknown callable shape is ABI-sensitive until the canonical callable ABI
  // slice makes legacy/IR wrappers interchangeable.
  return signature === undefined || typeFactCouldBeCallable(signature.returns);
}

/**
 * Bound the M0 multi-module overlay to unambiguous top-level functions.
 *
 * `ctx.funcMap` and IR overrides are still keyed by flat function name. Drop a
 * cross-file collision and every local caller that can reach a dropped name so
 * no IR body can resolve or patch the wrong module's slot. Class members and
 * the shared `__module_init` stay legacy-owned in M0.
 */
type MultiIrGraphSafety = MultiPreparedScalarLeafGraphSafety;

function multiIrTargetHasExactRegistryEntry(
  ctx: CodegenContext,
  targetRef: IrFuncRef,
  identityContext: IrPlanningIdentityContext,
  safety: MultiIrGraphSafety,
): boolean {
  if (targetRef.binding.kind !== "unit") return false;
  const targetUnitId = targetRef.binding.unitId;
  const targetName = targetRef.name;
  const target = identityContext.declarationByUnitId.get(targetUnitId);
  const terminal = identityContext.terminalByUnitId.get(targetUnitId);
  if (
    !target ||
    !ts.isFunctionDeclaration(target) ||
    !target.body ||
    identityContext.unitIdByDeclaration.get(target) !== targetUnitId ||
    identityContext.unitByUnitId.get(targetUnitId) !== terminal ||
    terminal?.observedKind !== "function"
  ) {
    return false;
  }
  if (safety.occupiedFunctionNameCounts.get(targetName) !== 1) return false;
  if (safety.occupiedFunctionKeys.some((key) => key.startsWith(`${targetName}$`))) return false;
  const idx = ctx.funcMap.get(targetName);
  return idx !== undefined && idx >= ctx.numImportFuncs && definedFuncAt(ctx, idx)?.name === targetName;
}

function requireMultiIrOwnerClaim(
  plan: IrOverlayPlan,
  ownerUnitId: IrUnitId,
  ownerName?: string,
): IrExactFunctionClaim {
  const claim = plan.functionClaimsByUnitId.get(ownerUnitId);
  if (!claim || (ownerName !== undefined && claim.legacyName !== ownerName)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `multi-source IR owner ${ownerUnitId}${ownerName === undefined ? "" : ` / ${ownerName}`} has no exact function claim`,
    );
  }
  return claim;
}

function makeMultiIrSafeSelection(
  ctx: CodegenContext,
  plan: IrOverlayPlan,
  sourceFile: ts.SourceFile,
  safety: MultiIrGraphSafety,
): IrSelection {
  const retained = new Set(plan.identityPlan.safeFunctionUnitIds);
  const blocked = new Set<IrUnitId>();
  for (const unitId of plan.identityPlan.identitySelection.funcs.keys()) {
    if (!retained.has(unitId)) blocked.add(unitId);
  }
  const moduleInitUnitId = plan.identityPlan.identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  if (moduleInitUnitId) blocked.add(moduleInitUnitId);
  const conservativeCrossFileCallers = ctx.standalone || ctx.wasi || ctx.strictNoHostImports;

  for (const callPlan of plan.importedCalls.values()) {
    requireMultiIrOwnerClaim(plan, callPlan.ownerUnitId, callPlan.ownerName);
    if (!multiIrTargetHasExactRegistryEntry(ctx, callPlan.target, plan.identityPlan.identityContext, safety)) {
      blocked.add(callPlan.ownerUnitId);
    }
  }
  for (const valuePlan of plan.topLevelFunctionValues.values()) {
    requireMultiIrOwnerClaim(plan, valuePlan.ownerUnitId, valuePlan.ownerName);
    if (!multiIrTargetHasExactRegistryEntry(ctx, valuePlan.target, plan.identityPlan.identityContext, safety)) {
      blocked.add(valuePlan.ownerUnitId);
    }
  }
  for (const unitId of retained) {
    const { legacyName: name, declaration } = requireMultiIrOwnerClaim(plan, unitId);
    const crossFileTarget = safety.crossFileFunctionNames.has(name);
    const hasCallableBoundary = crossFileTarget && functionHasCallableBoundary(ctx, declaration);
    const registeredIdx = ctx.funcMap.get(name);
    const registeredFunction = registeredIdx === undefined ? undefined : definedFuncAt(ctx, registeredIdx);
    if (
      safety.collisions.has(name) ||
      functionBodyHasUnsupportedImportUse(declaration, plan) ||
      functionBodyContainsNestedRuntimeDeclaration(declaration, plan) ||
      (declaration.typeParameters?.length ?? 0) > 0 ||
      safety.importAliasNames.has(name) ||
      safety.occupiedFunctionNameCounts.get(name) !== 1 ||
      registeredFunction?.name !== name ||
      safety.occupiedFunctionKeys.some((key) => key.startsWith(`${name}$`)) ||
      (crossFileTarget && (conservativeCrossFileCallers || hasCallableBoundary))
    ) {
      blocked.add(unitId);
    }
  }

  // The legacy name graph attributed class/module/unowned calls to a blocked
  // pseudo-module owner. Preserve that conservative routing with exact target
  // IDs before closing the retained function component.
  const localCalls = collectLocalCallEdgesByIdentity(sourceFile, plan.identityPlan.identityContext);
  for (const target of localCalls.calleesFromUnownedCallers) blocked.add(target);
  for (const [caller, targets] of localCalls.callees) {
    const terminal = plan.identityPlan.identityContext.terminalByUnitId.get(caller);
    if (terminal?.observedKind === "function" || terminal?.observedKind === "module-init") continue;
    for (const target of targets) blocked.add(target);
  }

  // A collision/dangerous removal re-opens the selector's graph-closure
  // invariant in both directions. Drop its whole selected weak component.
  const closed = closeIrBlockedComponentByIdentity(sourceFile, plan.identityPlan.identityContext, retained, blocked);
  return {
    funcs: irOverlayIdentity.retainIrSafeFunctionUnitIds(plan.identityPlan, closed),
    classMembers: new Set<string>(),
    moduleInit: undefined,
  };
}

function importedMissingArgNeedsUndefined(type: IrType): boolean {
  const val = asVal(type);
  return (
    type.kind === "extern" ||
    type.kind === "callable" ||
    type.kind === "string" ||
    type.kind === "dynamic" ||
    val?.kind === "externref" ||
    val?.kind === "ref_extern"
  );
}

/**
 * Materialize the legacy-owned runtime declarations referenced symbolically by
 * A+B1 before the IR builder runs. Any uncertainty removes the owner's whole
 * local call component, so an admitted site can never become a post-claim
 * symbolic-resolution failure.
 */
function prepareMultiIrImportedLowering(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  selection: IrSelection,
): IrSelection {
  if (plan.importedCalls.size === 0) return selection;
  const retained = new Set(plan.identityPlan.safeFunctionUnitIds);
  const blocked = new Set<IrUnitId>();
  let requestedLateImport = false;

  for (const [call, callPlan] of plan.importedCalls) {
    requireMultiIrOwnerClaim(plan, callPlan.ownerUnitId, callPlan.ownerName);
    if (!retained.has(callPlan.ownerUnitId)) continue;
    if (callPlan.needsArgc) {
      if (!callPlan.argcGlobal || callPlan.argcGlobal.binding.kind !== "runtime") {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `argc-sensitive call plan for ${callPlan.ownerName} has no exact runtime binding`,
        );
      }
      const argcGlobalIdx = ensureArgcGlobal(ctx);
      const argcGlobal = ctx.mod.globals[localGlobalIdx(ctx, argcGlobalIdx)];
      const entrySource = plan.identityPlan.identityContext.inventory.sources.find((source) => source.kind === "entry");
      if (!argcGlobal || !entrySource) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `argc-sensitive call plan for ${callPlan.ownerName} has no exact allocator/source owner`,
        );
      }
      planProgramAbiGlobal(ctx, {
        ref: callPlan.argcGlobal,
        anchor: { kind: "source", sourceId: entrySource.id },
        roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.argc,
        global: argcGlobal,
      });
    }
    for (let i = call.arguments.length; i < callPlan.params.length; i++) {
      if (!importedMissingArgNeedsUndefined(callPlan.params[i]!)) continue;
      if (ensureGetUndefined(ctx) === undefined) blocked.add(callPlan.ownerUnitId);
      else requestedLateImport = true;
    }
  }

  // A new host import shifts every defined funcIdx. Settle that once before
  // looking up callback targets or creating trampolines that capture an index.
  if (requestedLateImport) flushLateImportShifts(ctx, null);

  for (const valuePlan of plan.topLevelFunctionValues.values()) {
    requireMultiIrOwnerClaim(plan, valuePlan.ownerUnitId, valuePlan.ownerName);
    if (!retained.has(valuePlan.ownerUnitId) || blocked.has(valuePlan.ownerUnitId)) continue;
    if (valuePlan.target.binding.kind !== "unit") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `function-value cache target ${valuePlan.target.name} has no exact source-unit binding`,
      );
    }
    const funcIdx = ctx.funcMap.get(valuePlan.target.name);
    if (
      funcIdx === undefined ||
      funcIdx < ctx.numImportFuncs ||
      definedFuncAt(ctx, funcIdx)?.name !== valuePlan.target.name
    ) {
      blocked.add(valuePlan.ownerUnitId);
      continue;
    }
    const singleton = ensureFuncClosureSingleton(ctx, valuePlan.target.name, funcIdx, false);
    const trampoline = singleton ? definedFuncAt(ctx, singleton.trampolineFuncIdx) : undefined;
    const cache = singleton ? ctx.mod.globals[localGlobalIdx(ctx, singleton.cacheGlobalIdx)] : undefined;
    if (!trampoline || !cache || !planProgramAbiFunctionValue(ctx, valuePlan, trampoline, cache)) {
      blocked.add(valuePlan.ownerUnitId);
    }
  }

  if (blocked.size === 0) return selection;
  const closed = closeIrBlockedComponentByIdentity(sourceFile, plan.identityPlan.identityContext, retained, blocked);
  return {
    ...selection,
    funcs: irOverlayIdentity.retainIrSafeFunctionUnitIds(plan.identityPlan, closed),
    classMembers: new Set<string>(),
    moduleInit: undefined,
  };
}

function planMultiIrOverlaySource(
  ctx: CodegenContext,
  multiAst: MultiTypedAST,
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  hostImportedFunctions: irOverlayIdentity.IrIdentityImportedFunctionResolver | undefined,
): IrOverlayPlan {
  const sourceAst: TypedAST = {
    sourceFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  return planIrOverlay(ctx, sourceAst, identityContext, {
    resolveModuleBindings: false,
    ...(hostImportedFunctions ? { importedFunctions: hostImportedFunctions } : {}),
  });
}

function collectMultiIrLateProviderOwnerUnitIds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
): ReadonlySet<IrUnitId> {
  return new Set([
    ...[...plan.importedCalls.values()].map((candidate) => candidate.ownerUnitId),
    ...[...plan.topLevelFunctionValues.values()].map((candidate) => candidate.ownerUnitId),
    ...[...plan.hostVoidCallbacks.values()].map((candidate) => candidate.ownerUnitId),
    ...[...plan.hostDateSnapshots.values()].map((candidate) => candidate.ownerUnitId),
    ...[...plan.hostDateGetters.values()].map((candidate) => candidate.ownerUnitId),
    ...[...plan.promiseDelays.constructions.values()].map((candidate) => candidate.ownerUnitId),
    ...plan.suspendingAsyncUnitIds,
    ...irTimerShim.inspectIrCompilerTimerShimRouting(plan).ownerUnitIds,
    ...collectPreparedTopLevelFunctionValueTargetUnitIds(ctx, sourceFile, plan.identityPlan),
  ]);
}

function multiIrFunctionValueLeafHasForeignLateProvider(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  unitId: IrUnitId,
  functionValueTarget: boolean,
): boolean {
  const valueTargets = collectPreparedTopLevelFunctionValueTargetUnitIds(ctx, sourceFile, plan.identityPlan);
  return (
    (functionValueTarget ? valueTargets.size !== 1 || !valueTargets.has(unitId) : valueTargets.has(unitId)) ||
    collectDirectCallerActivationTargetUnitIds(ctx, sourceFile, plan.identityPlan).has(unitId) ||
    [...plan.importedCalls.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.topLevelFunctionValues.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostVoidCallbacks.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateSnapshots.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateGetters.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.promiseDelays.constructions.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    plan.suspendingAsyncUnitIds.has(unitId) ||
    irTimerShim.inspectIrCompilerTimerShimRouting(plan).ownerUnitIds.has(unitId)
  );
}

function planEarlyMultiIrOverlay(
  ctx: CodegenContext,
  multiAst: MultiTypedAST,
  identityContext: IrPlanningIdentityContext,
  options: CodegenOptions | undefined,
): Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<IrOverlayPlan>> {
  const active =
    !!options?.experimentalIR &&
    !options.disableIrFirst &&
    !explicitlyDisabledEnv(process.env.JS2WASM_IR_FIRST) &&
    ctx.standalone &&
    !ctx.wasi &&
    !ctx.fast &&
    multiAst.sourceFiles.length > 1;
  if (!active) return new Map();
  const scalarStates = planEarlyMultiPreparedScalarLeafRoute({
    active,
    cutoverEnabled: !explicitlyDisabledEnv(process.env.JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER),
    ctx,
    sourceFiles: multiAst.sourceFiles,
    entryFile: multiAst.entryFile,
    safety: () => buildMultiIrGraphSafety(ctx, multiAst.sourceFiles, multiAst.checker),
    planSource: (sourceFile) => planMultiIrOverlaySource(ctx, multiAst, sourceFile, identityContext, undefined),
    safeSelection: (plan, sourceFile, safety) => makeMultiIrSafeSelection(ctx, plan, sourceFile, safety),
    lateProviderOwnerUnitIds: (plan, sourceFile) => collectMultiIrLateProviderOwnerUnitIds(ctx, sourceFile, plan),
    projectLoweringPlans: (plan, selection) => irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, selection),
  });
  const functionValueStates = planEarlyMultiPreparedFunctionValueRoutes({
    active,
    leafCutoverEnabled: !explicitlyDisabledEnv(process.env.JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER),
    fibonacciPairCutoverEnabled: !explicitlyDisabledEnv(process.env.JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER),
    ctx,
    sourceFiles: multiAst.sourceFiles,
    entryFile: multiAst.entryFile,
    safety: () => buildMultiIrGraphSafety(ctx, multiAst.sourceFiles, multiAst.checker),
    planSource: (sourceFile) => planMultiIrOverlaySource(ctx, multiAst, sourceFile, identityContext, undefined),
    safeSelection: (plan, sourceFile, safety) => makeMultiIrSafeSelection(ctx, plan, sourceFile, safety),
    hasForeignLateProvider: (plan, sourceFile, unitId, functionValueTarget) =>
      multiIrFunctionValueLeafHasForeignLateProvider(ctx, sourceFile, plan, unitId, functionValueTarget),
    prepareFunctionValueSupport: (plan, sourceFile, unitId, legacyName) =>
      prepareTopLevelFunctionValueTargetSupport(ctx, sourceFile, plan, new Set([legacyName])).get(unitId),
    projectLoweringPlans: (plan, selection) => irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, selection),
  });
  for (const [sourceFile, state] of functionValueStates) {
    if (scalarStates.has(sourceFile)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `multi-source early routes both claimed ${sourceFile.fileName}`,
      );
    }
    scalarStates.set(sourceFile, state);
  }
  return scalarStates;
}

function compileMultiIrOverlaySource(
  ctx: CodegenContext,
  multiAst: MultiTypedAST,
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  safety: MultiIrGraphSafety,
  hostImportedFunctions: irOverlayIdentity.IrIdentityImportedFunctionResolver | undefined,
  early?: EarlyMultiPreparedScalarLeafState<IrOverlayPlan>,
): void {
  const plan =
    early?.plan ?? planMultiIrOverlaySource(ctx, multiAst, sourceFile, identityContext, hostImportedFunctions);
  let safeSelection = makeMultiIrSafeSelection(ctx, plan, sourceFile, safety);
  safeSelection = prepareMultiIrImportedLowering(ctx, sourceFile, plan, safeSelection);
  safeSelection = synchronizeIrSafeFunctionSelection(plan, safeSelection);
  safeSelection = applyIrFinalContextFunctionUnitIds(
    plan,
    safeSelection,
    prepareHostVoidCallbackLoweringByIdentity(
      ctx,
      sourceFile,
      plan.hostVoidCallbacks,
      plan.identityPlan.safeFunctionUnitIds,
      plan.identityPlan.identityContext,
    ),
  );
  safeSelection = prepareHostDateSnapshotPreflight(ctx, sourceFile, plan, safeSelection);
  safeSelection = synchronizeIrSafeFunctionSelection(plan, safeSelection);
  safeSelection = applyIrFinalContextFunctionUnitIds(
    plan,
    safeSelection,
    preparePromiseDelayLoweringByIdentity(
      ctx,
      sourceFile,
      plan.promiseDelays,
      plan.identityPlan.safeFunctionUnitIds,
      plan.identityPlan.identityContext,
      plan.preparationFailuresByUnitId,
    ),
  );
  const { overrideMap, classShapes } = plan;
  if (early?.route?.routeKind === "fibonacci-pair") {
    assertMultiPreparedFibonacciPairRouteCurrent({ ctx, route: early.route, finalSelection: safeSelection, safety });
  } else if (early?.route?.routeKind === "function-value") {
    assertMultiPreparedFunctionValueLeafRouteCurrent({
      ctx,
      route: early.route,
      finalSelection: safeSelection,
      safety,
    });
  } else if (early?.route) {
    assertMultiPreparedScalarLeafRouteCurrent({ ctx, route: early.route, finalSelection: safeSelection, safety });
  }
  const report = completePreparedIrIntegration({
    ctx,
    sourceFile,
    selection: safeSelection,
    overrideMap,
    classShapes,
    ...(early?.route ? { preparedReport: early.route.preparedReport } : {}),
    ...(early?.route ? { preparedLegacyNames: early.route.preparedFreeFunctions.completedBodies } : {}),
    projectLoweringPlans: (selection) => irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, selection),
  });
  consumeIrOverlayReport(ctx, report, plan, safeSelection, sourceFile, early?.skippedFunctionUnitIds);
}

function recordSourceGlobalEnvironment(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const vars = (ctx.globalObjectVarBindings ??= new Set());
  recordScriptVarBindingNames(vars, sourceFile);
  const lexicals = (ctx.globalLexicalBindings ??= new Set());
  recordScriptGlobalLexicalBindingNames(lexicals, sourceFile);
  const implicit = (ctx.sloppyImplicitGlobals ??= new Set());
  recordSloppyImplicitGlobalNames(implicit, sourceFile, ctx.oracle, ctx.inferModuleStrictArguments ?? true);
  // (#3956) A top-level `this.p = v` creates a global-object property that a
  // bare `p` read resolves, exactly like the implicit `p = v` form above.
  for (const name of collectGlobalObjectPropertyNames(sourceFile, vars)) implicit.add(name);
}

interface IrFirstBodyRouting {
  readonly requestedSkipProjection?: ReturnType<typeof buildIrRequestedFunctionSkipProjection>;
  readonly preparedFreeFunctions?: PreparedIrFreeFunctionBodies;
  readonly preparedClassMembers?: PreparedIrClassMemberBodies;
  readonly preparedModuleInit?: PreparedIrModuleInitBody;
  readonly preparedImplicitConstructorUnitIds?: ReadonlySet<IrUnitId>;
  readonly preparedReport?: IrIntegrationReport;
  readonly preparedSelection?: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly skipBodies?: ReadonlySet<string>;
  readonly preserveBodies?: ReadonlySet<string>;
}

/**
 * R4's intentionally bounded module-init owner: an ordered sequence of
 * initialized top-level lexical declarations. The selector proves a one-to-one
 * Program ABI projection while the semantic plan proves exact source order,
 * binding identity, TDZ intent, and exactly-once invocation parity.
 */
interface PreparedLexicalModuleInitEvidence {
  readonly unitId: IrUnitId;
  readonly globalBindingIds: ReadonlySet<IrBindingId>;
  readonly invocationKind: Extract<IrModuleInitInvocationKind, "wasm-start" | "deferred-export">;
}

function preparedExactLexicalModuleInit(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection: Pick<IrSelection, "moduleInit">,
  planning: IrModuleInitPlanningEvidence | undefined,
  identityContext: IrPlanningIdentityContext,
): PreparedLexicalModuleInitEvidence | undefined {
  const exactInvocationLane =
    (!ctx.nativeStrings &&
      !ctx.standalone &&
      planning?.plan.invocation.target === "host" &&
      planning.plan.invocation.kind === "wasm-start") ||
    (ctx.nativeStrings &&
      ctx.standalone &&
      ctx.targetProfile.semanticProviders === "native-first" &&
      planning?.plan.invocation.target === "standalone" &&
      (planning.plan.invocation.kind === "wasm-start" || planning.plan.invocation.kind === "deferred-export"));
  if (
    ctx.fast ||
    ctx.wasi ||
    ctx.strictNoHostImports ||
    !exactInvocationLane ||
    selection.moduleInit?.reason !== null ||
    selection.moduleInit.stmtCount === 0 ||
    !planning?.plan.executable ||
    planning.plan.gaps.length !== 0 ||
    !planning.parity.aligned ||
    !planning.plan.invocation.exactlyOnce ||
    planning.plan.liveSeeds.length !== 0
  ) {
    return undefined;
  }

  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  const moduleInitUnitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  if (
    planning.plan.sourceId !== sourceId ||
    planning.plan.unitId === null ||
    planning.plan.unitId !== moduleInitUnitId ||
    identityContext.moduleInitUnitIdBySourceId.get(sourceId) !== moduleInitUnitId
  ) {
    return undefined;
  }

  const population = collectModuleInitPopulation(sourceFile);
  if (
    population.length === 0 ||
    selection.moduleInit.stmtCount !== population.length ||
    planning.plan.bindings.length !== population.length ||
    planning.plan.evaluations.length !== population.length ||
    planning.parity.plannedEntryCount !== population.length ||
    planning.parity.legacyEntryCount !== population.length
  ) {
    return undefined;
  }

  const sourceExecutableDeclarations = new Set<ts.Declaration>(
    sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration | ts.ClassDeclaration =>
        (ts.isFunctionDeclaration(statement) && !!statement.body) || ts.isClassDeclaration(statement),
    ),
  );
  const globalBindingIds = new Set<IrBindingId>();
  for (let ordinal = 0; ordinal < population.length; ordinal++) {
    const statement = population[ordinal];
    const binding = planning.plan.bindings[ordinal];
    const evaluation = planning.plan.evaluations[ordinal];
    if (!statement || !binding || !evaluation || !ts.isVariableStatement(statement)) return undefined;
    const declarations = statement.declarationList.declarations;
    const declaration = declarations[0];
    const declarationKind =
      statement.declarationList.flags & ts.NodeFlags.Const
        ? "const"
        : statement.declarationList.flags & ts.NodeFlags.Let
          ? "let"
          : undefined;
    if (
      !declarationKind ||
      declarations.length !== 1 ||
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      binding.declarationOrdinal !== ordinal ||
      binding.names.length !== 1 ||
      binding.names[0] !== declaration.name.text ||
      binding.declarationKind !== declarationKind ||
      binding.mutable !== (declarationKind === "let") ||
      binding.initialization !== "tdz" ||
      binding.globalBindingId === null ||
      binding.tdzBindingId === null ||
      binding.start !== declaration.getStart(sourceFile) ||
      binding.end !== declaration.end ||
      evaluation.kind !== "variable-initializer" ||
      evaluation.sourceOrdinal !== ordinal ||
      evaluation.statementOrdinal !== sourceFile.statements.indexOf(statement) ||
      evaluation.nestedOrdinal !== 0 ||
      evaluation.start !== statement.getStart(sourceFile) ||
      evaluation.end !== statement.end ||
      evaluation.classId !== null ||
      evaluation.bindingIds.length !== 1 ||
      evaluation.bindingIds[0] !== binding.globalBindingId
    ) {
      return undefined;
    }
    globalBindingIds.add(binding.globalBindingId);

    let reachesSourceFunction = false;
    const visitInitializer = (node: ts.Node): void => {
      if (reachesSourceFunction) return;
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        reachesSourceFunction = true;
        return;
      }
      if (ts.isIdentifier(node)) {
        if (ctx.oracle.declarationsOf(node).some((declaration) => sourceExecutableDeclarations.has(declaration))) {
          reachesSourceFunction = true;
          return;
        }
      }
      ts.forEachChild(node, visitInitializer);
    };
    visitInitializer(declaration.initializer);
    if (reachesSourceFunction) return undefined;
  }
  const invocationKind = planning.plan.invocation.kind;
  if (invocationKind !== "wasm-start" && invocationKind !== "deferred-export") return undefined;
  return { unitId: planning.plan.unitId, globalBindingIds, invocationKind };
}

function preparedLexicalComponentPreflightFailure(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  preliminaryR2Names: ReadonlySet<string>,
  moduleInit: PreparedLexicalModuleInitEvidence,
): string | undefined {
  // Host-executor Promise delay still owns two lifted source units and four
  // host imports on its separate preparation route. The standalone-native
  // projection has no derived source units: its single pre-observed provider
  // can safely participate in this aggregate lexical transaction.
  const hasSeparatelyPreparedPromiseDelay = [...plan.promiseDelays.constructions.values()].some(
    ({ runtimeProjection }) => runtimeProjection !== "standalone-native",
  );
  if (plan.importedCalls.size > 0 || hasSeparatelyPreparedPromiseDelay) {
    return "the exact lexical component still depends on a separately prepared import or Promise-delay family";
  }
  if (!hasExactCurrentEnvFunctionImportManifest(ctx)) {
    return "the final env function-import manifest contains an occupied compatibility slot";
  }
  const retainedFunctionUnitIds = new Set(
    [...preliminaryR2Names].map((legacyName) =>
      irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName),
    ),
  );
  const hasStandaloneDomDispatcher =
    ctx.requiresStandaloneDomInteractionCapability === true &&
    ctx.standalone &&
    !ctx.wasi &&
    ctx.nativeStrings &&
    ctx.targetProfile.environment === "none";
  const hasExactStandaloneDomDispatcher =
    hasStandaloneDomDispatcher &&
    reserveStandaloneDomCallbackDispatch(ctx, plan.hostVoidCallbacks, retainedFunctionUnitIds) &&
    hasReservedStandaloneDomCallbackDispatch(ctx, plan.hostVoidCallbacks, retainedFunctionUnitIds);
  if (
    plan.hostVoidCallbacks.size > 0 &&
    !hasExactStandaloneDomDispatcher &&
    !hasExactHostVoidCallbackMakerImport(ctx)
  ) {
    return "the exact host callback maker ABI is unavailable in the final module context";
  }
  const supportsHostDateSnapshots =
    supportsIrBackendTargetCapability(
      projectIrBackendTargetProfile(ctx.targetProfile, { fast: ctx.fast }),
      "host-date-snapshot",
    ) || ctx.requiresStandaloneClockCapability === true;
  if (
    !canPrepareHostDateSnapshotLoweringByIdentity(
      ctx,
      sourceFile,
      plan.hostDateImportsByOwnerUnitId,
      retainedFunctionUnitIds,
      moduleInit.unitId,
      plan.identityPlan.identityContext,
      { supportsHostDateSnapshots },
    )
  ) {
    return "the exact host Date provider ABI is unavailable in the final module context";
  }
  return undefined;
}

function rejectPreparedLexicalComponentBeforeMutation(
  plan: IrOverlayPlan,
  preliminaryR2Names: ReadonlySet<string>,
  moduleInit: PreparedLexicalModuleInitEvidence,
  detail: string,
): void {
  const failure: IrPreparationFailure = {
    kind: "unsupported",
    code: "late-preparation-unsupported",
    stage: "resolve",
    detail,
  };
  for (const legacyName of preliminaryR2Names) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName);
    if (!plan.preparationFailuresByUnitId.has(unitId)) plan.preparationFailuresByUnitId.set(unitId, failure);
    plan.safeSelection.funcs.delete(legacyName);
    irOverlayIdentity.dropIrSafeFunctionByLegacyName(plan.identityPlan, legacyName);
  }
  if (!plan.preparationFailuresByUnitId.has(moduleInit.unitId)) {
    plan.preparationFailuresByUnitId.set(moduleInit.unitId, failure);
  }
  plan.safeSelection.moduleInit = undefined;
}

/**
 * A class member admitted by the selector may still leave the prepared owner
 * fixed point when one of its exact local callees is not preparable. Class
 * bodies cannot use the old post-direct overlay as a retry path: doing so
 * compiles the legacy body first and then rebuilds the rejected member against
 * a target population that deliberately excludes its callee. Withdraw the
 * exact structural member before final-context integration and retain one
 * typed reason for the terminal ledger.
 */
function withdrawClassMembersOutsidePreparedOwnerClosure(
  plan: IrOverlayPlan,
  consideredUnitIds: ReadonlySet<IrUnitId>,
  retainedUnitIds: ReadonlySet<IrUnitId>,
): void {
  const rejectedUnitIds = new Set([...consideredUnitIds].filter((unitId) => !retainedUnitIds.has(unitId)));
  if (rejectedUnitIds.size === 0) return;

  const retainedSelectionUnitIds = new Set(
    [...(plan.safeSelection.classMemberUnitIds ?? [])].filter((unitId) => !rejectedUnitIds.has(unitId)),
  );
  const retainedLegacyNames = new Set<string>();
  for (const unitId of retainedSelectionUnitIds) {
    const claim = plan.identityPlan.identitySelection.classMembers?.get(unitId);
    if (!claim) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `retained prepared class member ${unitId} has no exact structural claim`,
      );
    }
    retainedLegacyNames.add(claim.legacyMatchName);
  }
  for (const unitId of rejectedUnitIds) {
    if (!plan.preparationFailuresByUnitId.has(unitId)) {
      plan.preparationFailuresByUnitId.set(unitId, {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: "the class member's exact local call graph crosses the final prepared owner population",
      });
    }
  }
  plan.safeSelection.classMemberUnitIds = retainedSelectionUnitIds;
  plan.safeSelection.classMembers = retainedLegacyNames;
}

/**
 * The post-direct overlay must honor the same caller-activation boundary as
 * early preparation. Merely withholding a target from R2 would still allow
 * its already-emitted direct body to be replaced by the late IR patch.
 */
function withdrawDirectCallerActivationTargets(plan: IrOverlayPlan, targetUnitIds: ReadonlySet<IrUnitId>): void {
  for (const unitId of targetUnitIds) {
    const claim = plan.functionClaimsByUnitId.get(unitId);
    // The target scan covers every exact top-level declaration, while the IR
    // claim index intentionally contains only selector-admitted owners. A
    // different early gate may already have removed a claimed owner too.
    if (!claim || !plan.identityPlan.safeFunctionUnitIds.has(unitId)) continue;
    if (!plan.preparationFailuresByUnitId.has(unitId)) {
      plan.preparationFailuresByUnitId.set(unitId, {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: "the source observes a current function's legacy caller activation",
      });
    }
    plan.safeSelection.funcs.delete(claim.legacyName);
    irOverlayIdentity.dropIrSafeFunctionByLegacyName(plan.identityPlan, claim.legacyName);
  }
}

function planIrFirstBodyRouting(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPlan,
  moduleInitPlanning: IrModuleInitPlanningEvidence | undefined,
): IrFirstBodyRouting {
  const directCallerActivationTargets = collectDirectCallerActivationTargetUnitIds(ctx, sourceFile, plan.identityPlan);
  withdrawDirectCallerActivationTargets(plan, directCallerActivationTargets);
  const preliminarySelection = plan.safeSelection;
  const inheritedSkipInput = {
    sourceFile,
    identityContext: plan.identityPlan.identityContext,
    safeFunctionUnitIds: plan.identityPlan.safeFunctionUnitIds,
    claimsByUnitId: plan.functionClaimsByUnitId,
    overridesByUnitId: plan.overrideMapByUnitId,
    potentiallyBlockedOwnerUnitIds: new Set([
      ...[...plan.hostVoidCallbacks.values()].map((callback) => callback.ownerUnitId),
      ...plan.hostDateImportsByOwnerUnitId.keys(),
      ...[...plan.promiseDelays.constructions.values()].map((delay) => delay.ownerUnitId),
      ...plan.suspendingAsyncUnitIds,
    ]),
    generatorsSkippable: !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports),
    fast: ctx.fast,
  };
  const timerRouting = irTimerShim.inspectIrCompilerTimerShimRouting(plan);
  const hasLateFeaturePreparation = timerRouting.hasOtherLateFeaturePreparation;
  const preliminaryModuleInit = preparedExactLexicalModuleInit(
    ctx,
    sourceFile,
    preliminarySelection,
    moduleInitPlanning,
    plan.identityPlan.identityContext,
  );
  const selectedClassIds = selectPreparedClassMemberUnitIds(ctx, preliminarySelection, plan.identityPlan);
  // Preserve the established late-feature gate for ordinary members and
  // constructors. Only exact selected accessor UnitIds are an
  // independently sealed component that may prepare beside host/import/date/
  // promise work in the surrounding Test262 harness.
  const classIds = new Set(
    [...selectedClassIds].filter((unitId) => {
      if (!hasLateFeaturePreparation) return true;
      const terminal = plan.identityPlan.identityContext.terminalByUnitId.get(unitId);
      return (
        terminal !== undefined &&
        (terminal.kind === "class-instance-getter" ||
          terminal.kind === "class-instance-setter" ||
          terminal.kind === "class-static-getter" ||
          terminal.kind === "class-static-setter")
      );
    }),
  );
  const freeNames = timerRouting.owners(preliminaryModuleInit, preliminarySelection.funcs, classIds);
  const preliminaryOwnerPopulation = freeNames
    ? selectR2PreparedOwnerComponents({
        ctx,
        sourceFile,
        selectedLegacyNames: freeNames,
        baselineLegacyNames: new Set(),
        classMemberUnitIds: classIds,
        identityPlan: plan.identityPlan,
        claimsByUnitId: plan.functionClaimsByUnitId,
        overridesByUnitId: plan.overrideMapByUnitId,
        hostVoidCallbacks: plan.hostVoidCallbacks,
        timerShimUnitIds: timerRouting.ownerUnitIds,
        // (#4508) A module-binding reader may only stay a prepared candidate
        // when the module-init that owns its storage joins the same sealed
        // transaction.
        preparedStorageTerminalUnitIds: new Set(preliminaryModuleInit ? [preliminaryModuleInit.unitId] : []),
      })
    : {
        freeFunctionNames: new Set<string>(),
        classMemberUnitIds: classIds,
      };
  const preliminaryR2Names = preliminaryOwnerPopulation.freeFunctionNames;
  const preliminaryClassMemberUnitIds = preliminaryOwnerPopulation.classMemberUnitIds;
  withdrawClassMembersOutsidePreparedOwnerClosure(plan, classIds, preliminaryClassMemberUnitIds);
  // A class or module owner does not make an unrelated free-function component
  // direct-owned. Dependency-complete free functions, ordinary members,
  // accessors, and eligible source constructor `_init` bodies enter one sealed
  // preparation transaction. Constructor `_new` wrappers remain AST-free
  // support. An exact prepared lexical initializer may join that transaction;
  // every other module-init shape remains direct.
  // selectR2PreparedOwnerComponents closes candidates over exact local call
  // edges, so any callable edge that crosses into those owners removes the
  // complete affected free/class component before preparation.
  const hasPromiseDelayComponent = plan.promiseDelays.constructions.size > 0;
  const hasSuspendingAsyncComponent = plan.suspendingAsyncUnitIds.size > 0;
  const usePreparedRouting =
    preliminaryR2Names.size > 0 ||
    preliminaryModuleInit !== undefined ||
    preliminaryClassMemberUnitIds.size > 0 ||
    hasPromiseDelayComponent ||
    hasSuspendingAsyncComponent;
  let finalizedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit"> | undefined;

  if (usePreparedRouting) {
    if (preliminaryModuleInit !== undefined && preliminaryR2Names.size > 0) {
      const preflightFailure = preparedLexicalComponentPreflightFailure(
        ctx,
        sourceFile,
        plan,
        preliminaryR2Names,
        preliminaryModuleInit,
      );
      if (preflightFailure !== undefined) {
        rejectPreparedLexicalComponentBeforeMutation(plan, preliminaryR2Names, preliminaryModuleInit, preflightFailure);
        const requestedSkipUnitIds = computePreparedInheritedIrFirstSkipUnitIds(inheritedSkipInput);
        const requestedSkipProjection = buildIrRequestedFunctionSkipProjection(
          requestedSkipUnitIds,
          plan.functionClaimsByUnitId,
        );
        return {
          requestedSkipProjection,
          preparedSelection: plan.safeSelection,
          skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
        };
      }
    }
    // TDZ globals are part of the frozen Program ABI and may be read while
    // the IR program is prepared. The exact Promise-delay route also settles
    // its late runtime imports here, before any direct body can bake funcIdxs.
    prepareModuleTdzGlobals(ctx, sourceFile);
    let preparedSelection = finalizePreparedIrSelection(ctx, sourceFile, plan);
    finalizedSelection = preparedSelection;
    if (timerRouting.withdrewNonTimerOwner(preliminaryR2Names, preparedSelection.funcs)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "R2 final-context preparation changed a preflight-certified free-function component",
      );
    }
    const promiseDelayNames = selectR3PreparedPromiseDelayFunctions({
      ctx,
      sourceFile,
      selectedLegacyNames: preparedSelection.funcs,
      identityPlan: plan.identityPlan,
      claimsByUnitId: plan.functionClaimsByUnitId,
      overridesByUnitId: plan.overrideMapByUnitId,
      promiseDelays: plan.promiseDelays,
    });
    const preparedPopulation = finalizeR3PreparedOwnerPopulation({
      ctx,
      sourceFile,
      plan,
      selection: preparedSelection,
      preliminaryClassMemberUnitIds,
      preliminaryR2Names,
      promiseDelayNames,
      projectLoweringPlans: (selection) => irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, selection),
    });
    preparedSelection = preparedPopulation.selection;
    finalizedSelection = preparedSelection;
    const {
      classMemberNames: finalClassMemberNames,
      classMemberUnitIds: finalClassMemberUnitIds,
      freeFunctionNames: preparedFreeFunctionNames,
    } = preparedPopulation;
    const finalModuleInit =
      preliminaryModuleInit === undefined
        ? undefined
        : preparedExactLexicalModuleInit(
            ctx,
            sourceFile,
            preparedSelection,
            moduleInitPlanning,
            plan.identityPlan.identityContext,
          );
    const prepareModuleInit = finalModuleInit !== undefined;
    if (preparedFreeFunctionNames.size === 0 && finalClassMemberNames.size === 0 && !prepareModuleInit) {
      // Final-context Promise preparation may reject an occupied/mismatched
      // runtime ABI. Keep that owner on the established direct route.
    } else {
      if (prepareModuleInit) preallocateModuleInitCallable(ctx, sourceFile);
      const postWasmStartTdzSafeBindingsByOwnerUnitId =
        prepareModuleInit && finalModuleInit.invocationKind === "wasm-start"
          ? new Map(
              [...preparedFreeFunctionNames].map(
                (legacyName) =>
                  [
                    irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName),
                    finalModuleInit.globalBindingIds,
                  ] as const,
              ),
            )
          : undefined;
      const projectLoweringPlans = (selection: IrSelection) =>
        irOverlayIdentity.projectIrIntegrationLoweringPlans(
          {
            ...plan,
            ...(postWasmStartTdzSafeBindingsByOwnerUnitId ? { postWasmStartTdzSafeBindingsByOwnerUnitId } : {}),
          },
          selection,
        );
      prepareTopLevelFunctionValueTargetSupport(ctx, sourceFile, plan, preparedFreeFunctionNames);
      const preparedBodies = prepareIrBodies({
        ctx,
        sourceFile,
        selection: {
          funcs: preparedFreeFunctionNames,
          classMembers: finalClassMemberNames,
          classMemberUnitIds: finalClassMemberUnitIds,
          moduleInit: prepareModuleInit ? preparedSelection.moduleInit : undefined,
        },
        identityPlan: plan.identityPlan,
        functionClaimsByUnitId: plan.functionClaimsByUnitId,
        overrideMap: plan.overrideMap,
        classShapes: plan.classShapes,
        classShapesById: plan.classShapesById,
        projectLoweringPlans,
      });
      const preparedFreeFunctions = preparedBodies.freeFunctions;
      const preparedClassMembers = preparedBodies.classMembers;
      const preparedModuleInit = preparedBodies.moduleInit;
      const preparedImplicitConstructorUnitIds = preparedBodies.implicitConstructorUnitIds;
      const preparedReport = preparedBodies.report;
      const requestedSkipUnitIds = computePreparedInheritedIrFirstSkipUnitIds(inheritedSkipInput);
      for (const entry of preparedFreeFunctions.requestedSkipProjection.entries) {
        requestedSkipUnitIds.add(entry.unitId);
      }
      const requestedSkipProjection = buildIrRequestedFunctionSkipProjection(
        requestedSkipUnitIds,
        plan.functionClaimsByUnitId,
      );
      return {
        requestedSkipProjection,
        preparedFreeFunctions,
        ...(preparedClassMembers ? { preparedClassMembers } : {}),
        ...(preparedModuleInit ? { preparedModuleInit } : {}),
        ...(preparedImplicitConstructorUnitIds.size > 0 ? { preparedImplicitConstructorUnitIds } : {}),
        preparedReport,
        preparedSelection,
        skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
        preserveBodies: preparedFreeFunctions.preserveBodies,
      };
    }
  }

  // Free-function components outside the bounded R2 population retain the
  // established post-direct overlay order and its compile-once allowlist.
  // This keeps fast numeric, structured ABI, cross-policy call components,
  // and late support discovery byte-compatible until their state moves into
  // preparation.
  const requestedSkipUnitIds = computePreparedInheritedIrFirstSkipUnitIds(inheritedSkipInput);
  const requestedSkipProjection = buildIrRequestedFunctionSkipProjection(
    requestedSkipUnitIds,
    plan.functionClaimsByUnitId,
  );
  return {
    requestedSkipProjection,
    skipBodies: new Set(requestedSkipProjection.entries.map(({ legacyName }) => legacyName)),
    ...(finalizedSelection ? { preparedSelection: finalizedSelection } : {}),
  };
}

function finalizeLeafStructTypes(ctx: CodegenContext): void {
  const callableRootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const keepOpenTypeIdxs = callableRootTypeIdx === undefined ? undefined : new Set([callableRootTypeIdx]);
  const finalizedTypeIndices = markLeafStructsFinal(ctx.mod, ctx.wasi, keepOpenTypeIdxs);
  ctx.programAbiSession?.recordLeafTypeFinalization(finalizedTypeIndices);
}

function compileIrRoutedDeclarations(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly preparedClassMembers?: PreparedIrClassMemberBodies;
  readonly preparedImplicitConstructorUnitIds?: ReadonlySet<IrUnitId>;
  readonly preparedModuleInit?: PreparedIrModuleInitBody;
  readonly irSkipBodies?: ReadonlySet<string>;
  readonly irPreserveBodies?: ReadonlySet<string>;
}): {
  readonly actuallySkipped?: string[];
  readonly classMemberUnitIds: readonly IrUnitId[];
  readonly implicitConstructorUnitIds: readonly IrUnitId[];
  readonly moduleInitNames: readonly string[];
} {
  const classMemberNames: string[] = [];
  const classMemberUnitIds: IrUnitId[] = [];
  const implicitConstructorUnitIds: IrUnitId[] = [];
  const moduleInitNames: string[] = [];
  const classBodyRouting =
    input.preparedClassMembers || (input.preparedImplicitConstructorUnitIds?.size ?? 0) > 0
      ? {
          skipBodies: input.preparedClassMembers?.skipBodies ?? new Set<string>(),
          preserveSkippedBodies: input.preparedClassMembers?.preserveBodies ?? new Set<string>(),
          skippedNames: classMemberNames,
          skipBodyUnitIds: input.preparedClassMembers?.skipBodyUnitIds ?? new Set<IrUnitId>(),
          preserveSkippedBodyUnitIds: input.preparedClassMembers?.preserveBodyUnitIds ?? new Set<IrUnitId>(),
          skippedUnitIds: classMemberUnitIds,
          skipImplicitConstructorUnitIds: input.preparedImplicitConstructorUnitIds ?? new Set<IrUnitId>(),
          skippedImplicitConstructorUnitIds: implicitConstructorUnitIds,
        }
      : undefined;
  const moduleInitBodyRouting = input.preparedModuleInit
    ? {
        skipBody: input.preparedModuleInit.skipBodies.has(MODULE_INIT_UNIT_NAME),
        preserveSkippedBody: input.preparedModuleInit.preserveBodies.has(MODULE_INIT_UNIT_NAME),
        skippedNames: moduleInitNames,
      }
    : undefined;
  const previousClassBodyRouting = input.ctx.irClassBodyRouting;
  try {
    input.ctx.irClassBodyRouting = classBodyRouting;
    return {
      actuallySkipped: compileDeclarations(
        input.ctx,
        input.sourceFile,
        input.irSkipBodies,
        input.irPreserveBodies,
        classBodyRouting,
        "full",
        moduleInitBodyRouting,
      ),
      classMemberUnitIds,
      implicitConstructorUnitIds,
      moduleInitNames,
    };
  } finally {
    input.ctx.irClassBodyRouting = previousClassBodyRouting;
  }
}

/** Compile a typed AST into a WasmModule IR */
function resolveAndRecordShapeStamping(ctx: CodegenContext): void {
  const affected = resolveSameShapeFieldNameCollisions(ctx);
  ctx.programAbiSession?.recordShapeStamping(affected);
}

function resolveAndRecordShapeBranding(ctx: CodegenContext): void {
  const affected = brandCollidingShapeTypes(ctx.mod, ctx.noBrandShapeTypes);
  ctx.programAbiSession?.recordShapeBranding(affected);
}

/**
 * (#4121 slice 2) Stratified level 3 of the numeric-carrier analysis: feed the
 * declaration-resolved return carriers back into the local slot fixpoint.
 *
 * Levels 1 and 2 cannot be merged — `inferBindingAwareNumericReturnTypes` READS
 * the level-1 local verdict, so its own result is evidence only a later pass
 * can consume. `bindingAwareNumericCallEvidence` answers `undefined` whenever
 * that evidence is already in the name-keyed `numericFunctions` set, so a
 * program the refinement cannot change never pays for a second pass and emits
 * byte-identical output.
 *
 * The widening oracle is reinstalled on a real refinement because its memo, and
 * the usage-inference caches behind it, were built against the superseded
 * verdict. Both happen before any function body compiles.
 */
function applyCallReturnRefinement(
  ctx: CodegenContext,
  host: NumericPropertyAnalysisHost | undefined,
  sourceFiles: readonly ts.SourceFile[],
  priorNumericFunctions: ReadonlySet<string> | undefined,
): void {
  if (host === undefined) return;
  const evidence = bindingAwareNumericCallEvidence(ctx, priorNumericFunctions);
  if (!refineNumericLocalsWithCallReturns(ctx, host, sourceFiles, evidence)) return;
  ctx.usageInference.setWidenedCarrierOracle(widenedCarrierOracleFor(ctx));
}

export interface GeneratedCodegenModule extends CodegenResult {
  irPostClaimErrors?: { kind: string; func: string; message: string }[];
  irCompiledFuncs?: readonly string[];
  programAbi?: PublishedProgramAbi;
}

export interface GeneratedModule extends GeneratedCodegenModule {
  irFirstSkipped?: readonly string[];
  moduleInitPlanning?: IrModuleInitPlanningEvidence;
}

export function generateModule(
  ast: TypedAST,
  options?: CodegenOptions,
  inventoryOptions: BuildIrUnitInventoryOptions = {},
): GeneratedModule {
  const mod = createEmptyModule();
  const irPlanningIdentityContext =
    options?.experimentalIR || options?.trackIrOutcomes
      ? buildIrPlanningIdentityContext(
          buildIrUnitInventory([ast.sourceFile], { ...inventoryOptions, entrySource: ast.sourceFile }),
        )
      : undefined;
  const programAbiSession = irPlanningIdentityContext
    ? new ProgramAbiSession(irPlanningIdentityContext.inventory, mod)
    : undefined;
  const ctx = createCodegenContext(mod, ast.checker, options, programAbiSession, irPlanningIdentityContext);
  ctx.irBodyRouteAuditSession?.registerGenerator("single", "generateModule");
  const standaloneCalendar = planSingleSourceStandaloneCalendar(ctx, ast.checker, ast.sourceFile, inventoryOptions);
  ctx.runtimeEvalBoundaryPlan = buildIrRuntimeEvalBoundaryPlan([ast.sourceFile], ctx.oracle);
  if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalBoundaryPlan.callableBoundaryRequired) {
    ctx.runtimeEvalCallableBoundaryEnabled = true;
  }
  const sourceFileInternal = ast.sourceFile as ts.SourceFile & { externalModuleIndicator?: ts.Node };
  ctx.sourceIsModule = sourceFileInternal.externalModuleIndicator !== undefined;
  recordSourceGlobalEnvironment(ctx, ast.sourceFile);
  // (#2138) Populated only under JS2WASM_IR_FIRST=1 — the top-level functions
  // whose legacy body emission was skipped (IR owns the slot). Declared out
  // here so the return statement below (outside the try) can surface it.
  let irFirstSkipped: readonly string[] | undefined;
  let moduleInitPlanning: IrModuleInitPlanningEvidence | undefined;
  // (#1983) Pre-scan top-level user `function` declaration names BEFORE any
  // class member registers a funcMap key, so `classMemberFuncKey` can detect a
  // `${className}_${member}` ↔ user-function collision (e.g. `class A { m() {} }`
  // + `function A_m() {}`) and relocate the class member's key. Must run here —
  // ahead of class collection/compile — because the producers query this set.
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body && !hasDeclareModifier(stmt)) {
      ctx.topLevelFunctionNames.add(stmt.name.text);
    }
  }
  // (#2179) Pre-scan for `delete <member>` so `any`-receiver property reads can
  // be routed through the tombstone-aware `__extern_get` host helper instead of
  // the inline struct.get fast-path (which reads the live field and ignores the
  // runtime delete tombstone). Delete-free modules keep byte-identical output.
  // (#4187) ONE walk answers both: the #2179 boolean above and the receiver
  // names the standalone hasOwnProperty const-fold gate needs (it only diverges
  // from runtime state for a receiver that is both defineProperty-widened and
  // deleted from). Only standalone reads the names, and collecting them forfeits
  // the boolean's short-circuit — worth +3,847 on the #3437 harness budget — so
  // host mode asks for the boolean alone and keeps main's exact traversal.
  // (#4223) Demand gate for the primitive-wrapper `.constructor` carriers. Set
  // BEFORE anything can call `ensureObjectRuntime` (which is where the mint
  // hangs), and only for standalone — the gc/host lane keeps its genuine
  // `Object_get_constructor` read.
  ctx.wrapperCtorCarrierDemanded = ctx.standalone === true && moduleReadsConstructorProp(ast.sourceFile);
  // (#4232) Narrower gate for the ordinary-object arm alone — see
  // `moduleMentionsObjectIdentifier` for why it cannot ride the flag above.
  ctx.plainCtorCarrierDemanded = ctx.wrapperCtorCarrierDemanded && moduleMentionsObjectIdentifier(ast.sourceFile);
  const memberDeletes = scanModuleMemberDeletes(ast.sourceFile, ctx.standalone === true);
  ctx.moduleUsesDelete = memberDeletes.any;
  ctx.memberDeleteReceiverNames = memberDeletes.receiverNames;
  // (#2660 S1) Whole-program escape / dynamic-use classification of `new F()`
  // fnctor instances. INERT: the result is stored for the future S3
  // reconstruction lowering but is NOT yet consumed, so emitted Wasm is
  // byte-identical. Side-effect free; safe to run unconditionally (no fnctor
  // `new` sites ⇒ empty result ⇒ no-op).
  // (#4235) The array + explicit `"single"` path tag. `generateMultiModule`
  // makes the identical call with the whole graph and `"multi"`; keeping the
  // two call shapes the same is what makes the parity testable.
  ctx.fnctorEscapeGate = analyzeFnctorEscapeGate(ast.checker, [ast.sourceFile], ctx.standalone, "single");
  // (#3673) Names the source itself defines as function-valued members, so the
  // guarded native-string method lowering can tell a genuine `String.prototype`
  // call apart from a same-named USER method on an object receiver. Cheap
  // single walk; an empty result restores the previous lowering exactly.
  ctx.userMethodNames = collectUserMethodNames(ast.sourceFile);
  // (#3683 S4a) Whole-program numeric-property verdict, consumed by
  // `deriveFnctorFields` to give a fnctor field a PHYSICAL f64 slot. MUST run
  // before `reserveFnctorStructTypes` below — that is what derives the struct
  // shapes. Standalone-only: the promotion's ToNumber-coercing write is a
  // deliberate narrowing that the host lane (arbitrary JS callers) does not take.
  // #2847's boolean verdict is recomputed here rather than read from
  // `ctx.booleanPropertyNames` (assigned much later) so the exclusion is exact
  // without reordering an established pass.
  // (#4121 slice 2) Kept so the stratified second pass below can re-run the
  // SAME analysis with one extra fact rather than a re-derived approximation.
  let numericAnalysisHost: NumericPropertyAnalysisHost | undefined;
  let priorNumericFunctions: ReadonlySet<string> | undefined;
  if (ctx.standalone) {
    numericAnalysisHost = {
      oracle: ctx.oracle,
      fnctorReceivers: new Set(ctx.fnctorEscapeGate.receiverStruct.keys()),
      excludeNames: analyzeBooleanPropertyNames(ctx, [ast.sourceFile]),
    };
    applyNumericPropertyAnalysis(ctx, numericAnalysisHost, [ast.sourceFile]);
    priorNumericFunctions = ctx.numericFunctionNames;
  }
  // (#4121) Admission keys on the representation codegen is about to emit. Must
  // follow `applyNumericPropertyAnalysis` (the widening predicate consults its
  // verdict) and precede any function body — `setWidenedCarrierOracle` clears
  // the memo caches so no pre-oracle verdict can be pinned. Installed in both
  // lanes: the widening itself is not standalone-only.
  ctx.usageInference.setWidenedCarrierOracle(widenedCarrierOracleFor(ctx));
  // (#3057) Pre-scan for a dynamic `new <ctorVar>(buffer)` construct so the
  // runtime-kind element byte codec on the generic index path (`ta[i]` / `ta[i]=v`
  // for an `any` receiver) is enabled in helper functions compiled BEFORE the
  // construct (the `$__ta_dyn_view` type registers lazily). Host-free lane only;
  // byte-inert when the pattern is absent.
  if (ctx.standalone || ctx.wasi) {
    ctx.moduleUsesDynTaView = sourceHasDynamicTaConstruct(ast.checker, ast.sourceFile);
  }
  try {
    // (#4238 slice 1) Imported-memory topology: a PEER wasm module owns and
    // exports the linear memory and this module imports it at memory index 0,
    // so the `wasm:memory` accessors address the peer's heap. Registered FIRST
    // (before any func import) to mirror `src/codegen/wasi.ts`'s node:fs link
    // path; a memory import does not perturb the func index space. Absent for
    // every compile that does not pass the option.
    if (ctx.importMemory) {
      addImport(ctx, ctx.importMemory.module, "memory", {
        kind: "memory",
        min: ctx.importMemory.min ?? 1,
      });
    }
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, ast.sourceFile);
      // #1886 — pre-pass: classify which `Uint8Array` buffers are pure I/O
      // (never escape the GC heap) so they can be backed by linear memory with
      // zero-copy fd_read/fd_write. Side-effect free; codegen consumers are
      // additive (empty result ⇒ emitted module identical to today).
      // #2631 — pass the node:fs readSync/writeSync binding names from the
      // ORIGINAL source (import preprocessing has already stripped the `node:fs`
      // import from `ast.sourceFile`, so the analysis can't rediscover them).
      // `ctx.wasiNodeFsFuncs` records the local names of node:fs imports; the
      // byte-IO sink recognition only fires for these, so it's byte-neutral for
      // every program that doesn't import them.
      const nodeFsSyncNames = new Set<string>();
      for (const name of ctx.wasiNodeFsFuncs) {
        if (name === "readSync" || name === "writeSync") nodeFsSyncNames.add(name);
      }
      ctx.linearUint8 = analyzeLinearUint8(ast.checker, ast.sourceFile, nodeFsSyncNames);
      // #1886 Slice B: reserve the `__lin_u8_alloc` bump-allocator's
      // `(i32)->(i32)` func TYPE eagerly, here — BEFORE any WasmGC struct/array
      // type or native-string helper is registered. This keeps the shared
      // `ctx.mod.types` prefix stable: the allocator type lands at a low, fixed
      // index, so later string-helper struct/array type indices (which their
      // bodies bake absolutely, e.g. `__str_flatten`'s `(ref null $type)`) are
      // not shifted. The allocator FUNCTION itself is emitted later, in the
      // post-import-registration helper block, so its DEFINED-function index is
      // assigned after every late `env.*` import (e.g. `env.__extern_get` for
      // `buf[i]` externref element access) is already counted — keeping the
      // baked `call $__lin_u8_alloc` index correct. Splitting type (early) from
      // function (late) is what resolves the dual constraint that defeated both
      // the all-early and all-late single-shot emission points.
      // Reserve the allocator's func type whenever the #1886 analysis found a
      // safe binding. Slice C can back locals that are threaded through helper
      // params, so `localOnlyBindings` is too narrow here.
      if (ctx.linearUint8.safeBindings.size > 0) {
        reserveLinearU8AllocType(ctx);
      }
    }
    // (#2357/#47) Reserve the standalone TypedArray `$__subview_<elem>` struct
    // types up-front, here — at the SAME deterministic point in every codegen
    // pass — so the subview type index is identical across the hoist pass (which
    // sizes a `subarray`-result binding's local via
    // `inferLetConstInitializerWasmType`) and the body/emit pass (which emits the
    // matching `struct.new`). On-demand subview registration lands at
    // pass-dependent indices, de-syncing the two; eager registration *inside*
    // `getOrRegisterVecType` instead shifts the vec resolution itself (a plain
    // `new Uint8Array()` then resolves to the subview). Reserving the subviews
    // here — after the vec-independent linear-u8 reservation, before any function
    // is compiled — gives a stable, isolated slot. `getOrRegisterSubviewType`
    // pulls in only the backing array type (deduped per elem kind), so vec
    // registration order is untouched. Standalone/WASI only; additive.
    if (ctx.standalone || ctx.wasi) {
      reserveTypedArraySubviewTypes(ctx);
      // (#2901 fix) The integer-view PLAIN vec structs are deliberately NOT
      // reserved here. An up-front, unconditional reservation prepended them to
      // every standalone module's type table, renumbering the #2835 i8-packed
      // array type → ~2.6k `array.get: ... packed type i8` failures in the
      // merge_group (type-index-shift hazard). They are now registered LATE +
      // ONCE, append-only, inside `typedArrayViewBrandCandidates` (only when a
      // reflective TypedArray accessor getter is actually emitted) — so non-TA
      // modules stay byte-identical and nothing already registered is renumbered.
    }

    // (#2026 #53) Reserve `$ObjVecArr` up-front when the source declares a class,
    // so the dynamic-`new` runtime-argv path (`new K(...someVar)`) has a stable
    // type index. Class-gated + additive (one self-contained array type, no
    // helpers/imports) → no index shift for class-free programs. Both targets:
    // the dynamic-new fallback fires in host AND standalone.
    if (sourceContainsClass(ast.sourceFile)) {
      reserveObjVecArrType(ctx);
    }

    // (#2773 S1 KEYSTONE) Reserve every reconstructed-fnctor `$__fnctor_<Name>`
    // struct type up-front, here — at the SAME deterministic point in every
    // codegen pass — so the type index is identical across the hoist pass (which
    // bakes a typed-receiver `ref.test $__fnctor_<Name>` / sizes a hoisted local)
    // and the emit pass (which emits the matching `struct.new`). On-demand
    // registration at the `new F()` site lands at a pass-dependent index,
    // de-syncing the two. Gated on a non-empty approved set ⇒ byte-identical no-op
    // for fnctor-free modules. Both targets (the fnctor struct path is
    // target-independent). MUST run after the gate is built (above, line ~1081)
    // and after the subview / ObjVecArr reservations so the type-table prefix is
    // already stable.
    collectDynamicObjectReturnCarrierTypes(ctx, ast.checker, ast.sourceFile);
    reserveFnctorStructTypes(ctx);

    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Note: console imports handled by unified collector (skipped in WASI mode via registerWasiImports)
    // First pass: collect declare namespaces (registers imports before local funcs)
    collectExternDeclarations(ctx, ast.sourceFile);

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      checkWasiDomUsage(ctx, ast.sourceFile);
      rejectTimersUnderWasi(ctx, ast.sourceFile);
    }

    // Scan lib files for DOM extern classes + globals (only if user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    if (sourceUsesLibGlobals(ast.sourceFile)) {
      // #2520 — the lib-file referenced-names gate only applies under
      // --target wasi/standalone, where the ambient global-function flood
      // (~60 register-then-dropped host imports) is the actual problem and the
      // dropped imports are DCE'd. Under the default JS-host (gc) target the
      // gate is a no-op for warnings but reorders the import/type table, which
      // exposed a latent index-shift in the late-import path (#1787 −6
      // regression: Array/TypedArray .join, TypedArray HasProperty, Array
      // reduce). Passing `undefined` here keeps the gc lane byte-identical to
      // pre-#2520 behaviour while preserving the wasi/standalone flood fix.
      const libRefs =
        ctx.wasi || ctx.standalone ? collectReferencedGlobalNames([ast.sourceFile], ctx.checker) : undefined;
      // (#4218) The lib-file walk resolves every declared type SYNTACTICALLY
      // through a one-shot declaration index — lib files are fully annotated,
      // so the ~254k per-compile checker queries this loop used to issue are
      // unnecessary. Same traversal order ⇒ identical import/type tables.
      const libSfs = ast.program.getSourceFiles().filter((sf) => {
        const baseName = sf.fileName.split("/").pop() ?? sf.fileName;
        return baseName.startsWith("lib.") && baseName.endsWith(".d.ts");
      });
      // JS2WASM_LIB_SCAN=checker forces the legacy checker-driven walk — the
      // A/B escape hatch for parity triage (#4218).
      const libIndex = process.env.JS2WASM_LIB_SCAN === "checker" ? undefined : buildLibDeclIndex(libSfs);
      for (const sf of libSfs) {
        collectExternDeclarations(ctx, sf, libRefs, libIndex);
        collectDeclaredGlobals(ctx, sf, ast.sourceFile, libIndex);
      }
    }

    // Register built-in collection types as extern classes if not already collected from lib files
    registerBuiltinExternClasses(ctx);

    // #1044 — Register Node builtin modules as externref host imports
    if (options?.nodeBuiltins && options.nodeBuiltins.length > 0) {
      registerNodeBuiltinImports(ctx, options.nodeBuiltins);
    }

    // #1540 — Register JSX runtime imports (jsx/jsxs/Fragment) so codegen
    // call/identifier resolution can route them to the right host imports.
    if (options?.jsxRuntime) {
      registerJsxRuntimeImports(ctx, options.jsxRuntime);
    }

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    collectObjectLiteralAssignedPropertyNames(ctx, ast.sourceFile);
    collectEmptyObjectWidening(ctx, ast.checker, ast.sourceFile);
    // (#2837) Detect NON-empty object literals later written out-of-shape (incl.
    // nested depth-2 descriptors) → route them to the externref $Object builder.
    collectGrowableObjectLiterals(ctx, ast.checker, ast.sourceFile);

    // Register only the extern class imports actually used in source code
    collectUsedExternImports(ctx, ast.sourceFile);

    // #1187 — pre-register imports needed by the testRuntime string-coercion
    // helpers BEFORE `collectAllSourceImports` runs. The unified collector's
    // finalize step registers native-string runtime helpers (via
    // `ensureNativeStringHelpers`) as DEFINED functions at the current
    // `numImportFuncs` boundary; if we add testRuntime imports AFTER that, the
    // already-emitted helper bodies hold stale `call funcIdx` values that
    // collide with the newly-inserted import slots (e.g. `__str_copy_tree`
    // gets shadowed by `String_fromCharCode`). Pre-registering here avoids
    // any late-import shift.
    if (ctx.testRuntime && ctx.nativeStrings) {
      // wasm:js-string.length, charCodeAt, concat, substring, equals
      addStringImports(ctx);
      // env.String_fromCharCode((f64) -> externref) — used by __test_str_to_externref
      if (!ctx.funcMap.has("String_fromCharCode")) {
        const fccTypeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx: fccTypeIdx });
      }
    }

    // Single-pass collection of all source imports (#592):
    // console, primitives, string literals, string methods, Math, parseInt/parseFloat,
    // String.fromCharCode, Promise, JSON, callbacks, functional array methods,
    // union types, generators, iterators, for-in/in-expr/Object.keys string literals,
    // wrapper constructors, unknown constructor imports.
    collectAllSourceImports(ctx, ast.sourceFile);

    // #1047 — register __register_prototype host import before any local function
    // is created so `emitLazyProtoGet` can look it up from funcMap without
    // triggering late-import index shifts mid-expression compilation.
    //
    // #1472 Phase A — these two imports exist solely so the JS-host Proxy
    // wrapper can present a spec-correct own-key set for class prototypes /
    // class objects. There is no Proxy (and no JS host) in any no-JS-host
    // target, so we skip registering them. `emitLazyProtoGet` /
    // `emitLazyClassObjectGet` gate their `call` emission on the import being
    // present in funcMap, so skipping registration cleanly drops the host
    // notification while the struct-backed prototype/class globals still work
    // natively.
    //
    // (#2026 PR-1b) The guard must cover BOTH no-JS-host targets (`wasi` AND
    // `standalone`), not just `standalone`. Under `--target wasi` the import was
    // still registered, so `emitLazyClassObjectGet` took its
    // `__register_class_object` CSV-notification branch and emitted a
    // `global.get` of the static-methods-CSV string global — which under
    // nativeStrings is not a real module global, baking a `-1` global index and
    // crashing binary emit ("global index out of range — -1") the moment a class
    // flowed as a value (`use(A)`, `new K()` dynamic-new). `standalone` already
    // skipped this and worked; `wasi` now matches.
    if (sourceContainsClass(ast.sourceFile) && !(ctx.standalone || ctx.wasi)) {
      const regProtoTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_prototype", { kind: "func", typeIdx: regProtoTypeIdx });
      // (#1395) Same rationale for the class-object registry — must be
      // registered up-front so `emitLazyClassObjectGet` finds it in funcMap.
      const regClassTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_class_object", { kind: "func", typeIdx: regClassTypeIdx });
      // (#4371) A name-only class-object registration can make reflection
      // report a static method, but it cannot invoke that method after the
      // class value crosses an `any`/host boundary. Register the real compiled
      // closure on the singleton as well. This import is host-only for the same
      // reason as __register_class_object; standalone/wasi keep their zero-host
      // class representation and direct in-Wasm calls.
      const regStaticMethodTypeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      addImport(ctx, "env", "__register_class_static_method", {
        kind: "func",
        typeIdx: regStaticMethodTypeIdx,
      });
    }

    // #1677 — reconcile native-string helper func indices before emitting more
    // defined helpers that look them up. Imports registered after the helpers
    // (e.g. the __register_prototype / __register_class_object pair above)
    // shift the helpers' true indices but not their baked-in sibling-call
    // targets nor the `nativeStrHelpers` / funcMap entries the deferred WASI
    // write helpers read. Incremental + no-op on the default GC path.
    reconcileNativeStrFinalizeShift(ctx);

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered (bypasses bug
    // where direct addImport calls do not shift defined-function indices).
    emitToUint32Helper(ctx);

    // (#1483) Emit deferred WASI helper functions for the same reason —
    // `__wasi_write_string` / `__wasi_date_now` etc. reference imports via
    // funcMap, and addImport callers earlier in this pipeline (lib-globals
    // scan adding `eval` / `parseInt`) do not shift defined-func entries.
    emitDeferredWasiHelpers(ctx);

    // (#3469) Mint the standalone host-free `console.log`/`print` sink
    // (`__stdout_acc` global + `__stdout_append` helper) in the same
    // post-import-registration / pre-body window as the WASI helpers, so the
    // `__stdout_append` funcidx is final for every `console.*` call site that
    // bakes it (no mid-body index-shift hazard). No-op unless the source uses
    // `console.*` in standalone mode (`ctx.usesStandaloneConsoleSink`). Readout
    // exports (`__stdout_prepare`/`__stdout_char`) are emitted at finalize.
    if (ctx.usesStandaloneConsoleSink) {
      ensureStandaloneStdoutSink(ctx);
    }
    emitStandaloneDomStringBoundary(ctx);

    // #1886 Slice B — emit the `__lin_u8_alloc` bump-allocator FUNCTION here,
    // in the same post-import-registration window as emitToUint32Helper /
    // emitDeferredWasiHelpers and for the same reason: all the eager import
    // collectors (collectUsedExternImports adds `env.__extern_get`;
    // collectAllSourceImports; the __register_prototype pair) have run, so
    // `numImportFuncs` is stable and the allocator's defined-func index — which
    // every `call $__lin_u8_alloc` resolves against — is final. Its func TYPE
    // was already reserved early (see reserveLinearU8AllocType) so the GC /
    // native-string type-table prefix is unperturbed. Any import added DURING
    // the compilation phase that follows goes through the proper late-import
    // shift path, which moves both `funcMap` and the baked `call` indices.
    if (ctx.wasi && ctx.linearUint8 && ctx.linearUint8.safeBindings.size > 0) {
      ensureLinearU8AllocHelper(ctx);
    }

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1623 — pre-emit the WASI/standalone error constructors BEFORE any user
    // function compiles. The destructuring null-throw path
    // (`buildDestructureNullThrow`) lazily calls `emitWasiErrorConstructor`
    // mid-prologue while a user function's own array slot is reserved-but-not-
    // yet-pushed; the constructor then takes that reserved slot and the user
    // function clobbers it on its own push, leaving a dangling funcMap index
    // (observed as `throw expected externref, found call of type f64` and
    // `Invalid global index`). Emitting the constructor here gives it a stable
    // slot ahead of user-function compilation. The emitter is idempotent, so
    // this is a no-op when no binding patterns exist.
    if ((ctx.wasi || ctx.standalone) && sourceContainsBindingPattern(ast.sourceFile)) {
      emitWasiErrorConstructor(ctx, "TypeError", 1);
    }

    // #1121: Pre-compute return-type inference for recursive numeric kernels
    // (e.g. unannotated `function fib(n) { ... }`). This runs BEFORE
    // collectDeclarations so the inferred f64 return shows up directly in
    // the function's signature instead of being patched after the fact.
    ctx.numericReturnTypes = inferNumericReturnTypes(ctx, ast.sourceFile);
    ctx.bindingAwareNumericReturnTypes = inferBindingAwareNumericReturnTypes(ctx, [ast.sourceFile]);
    applyCallReturnRefinement(ctx, numericAnalysisHost, [ast.sourceFile], priorNumericFunctions);
    ctx.booleanPropertyNames = analyzeBooleanPropertyNames(ctx, [ast.sourceFile]);

    // #1677 — final reconcile of native-string helper indices before any USER
    // function is registered. Any imports added by the deferred-helper
    // emitters above are folded in here; afterward the compilation-phase
    // late-import path (ensureLateImport → flushLateImportShifts, which now
    // also shifts `nativeStrHelpers`) keeps them correct. Incremental no-op
    // when nothing drifted.
    reconcileNativeStrFinalizeShift(ctx);

    // Second pass: collect all function declarations and interfaces
    // #1719 S1 — set the ITER_OVERRIDDEN brand if the program may monkeypatch
    // Array.prototype's @@iterator/values. When clear (the common case) every
    // array-destructuring site stays byte-identical; when set, the S2 slice
    // routes a branded array RHS through the host GetIterator lane (§7.4.2).
    // Must run BEFORE collectDeclarations: the module-init statement filter
    // (#1719 CPR write-arm) consults the brand to KEEP the
    // `Array.prototype[@@iterator] = fn` override statement in __module_init.
    if (sourceOverridesArrayIterator(ast.sourceFile)) {
      ctx.arrayIteratorMaybeOverridden = true;
    }

    // (#2023) Detect any `new.target` use up front so class collection assigns
    // class-ids and `new`/comparison sites emit the threading global. Off by
    // default — programs without `new.target` are byte-identical.
    scanForNewTarget(ctx, ast.sourceFile);

    // (#802) Detect proto-mutation receivers up front so class collection can
    // append the conditional standalone-only `$__proto__` field to marked
    // hierarchy roots. Off by default — programs without proto mutation are
    // byte-identical.
    scanForDynamicProto(ctx, ast.sourceFile);

    // (#2001 S1) Detect any array-literal elision up front so externref-element
    // vec reads / joins emit the `$Hole → undefined` read-boundary guard.
    // Off by default — programs without holes are byte-identical.
    scanForArrayHoles(ctx, ast.sourceFile);

    if (
      options?.experimentalIR &&
      ctx.standalone &&
      ctx.nativeStrings &&
      !ctx.wasi &&
      !ctx.fast &&
      ctx.targetProfile.semanticProviders === "native-first"
    ) {
      registerIrAsyncPromiseDelayResolver(ctx, makeIrPromiseDelayResolver(ast.checker));
    }
    collectDeclarations(ctx, ast.sourceFile);
    // #3522 R3: exact fields that reference a later local class are collected
    // provisionally as externref. Finalize their already-observed storage slot
    // in place before class-shape planning snapshots the Program ABI layout.
    finalizeForwardClassFieldLayouts(ctx, ast.sourceFile);
    // #3522 R3: callable slots with exact references to a later local class
    // must receive their final struct ABI before prepared IR planning decides
    // which direct bodies will never run. The direct body compiler retains its
    // idempotent re-resolution as a temporary hybrid assertion.
    finalizeForwardClassCallableAbis(ctx, ast.sourceFile);
    // #2847: declaration collection has now materialized the initial struct
    // field table. Brand proven boolean i32 slots before compiling bodies so
    // direct/dynamic reads preserve JS boolean identity at their use sites.
    // The finalize-time pass below remains necessary for late-grown fields.
    recoverBooleanStructFieldBrands(ctx);

    // Shape inference: detect array-like variables and override their types
    applyShapeInference(ctx, ast.checker, ast.sourceFile);

    // (#1636-S1) Eagerly register the `__current_this` module global so that
    // `ThisKeyword` resolution in free-function-closure bodies (compiled in
    // the next phase) can emit `global.get __current_this`. The companion
    // `__call_fn_method_N` exports that install / restore this global are
    // emitted in post-processing.
    ensureCurrentThisGlobal(ctx);

    // (#2931) Back reassigned function-declaration names (`fn = …`) with a
    // mutable live-binding module global so later reads observe the write.
    // No-op unless a function declaration is reassigned.
    registerReassignedFunctionGlobals(ctx, [ast.sourceFile], ctx.runtimeEvalBoundaryPlan!);

    // (#4182) Back module-scope Annex B B.3.3.2 block-nested function names
    // with live-binding globals. No-op unless the (sloppy, script-mode) source
    // has a top-level block/`if`/`switch`-nested `function` declaration.
    registerAnnexBGlobalLiveBindings(ctx, [ast.sourceFile]);

    // (#3523 R4) Build the semantic top-level plan independently from the
    // direct front-end's three mutable queues. The plan remains an observer for
    // generic module shapes, while the exact prepared lexical initializer below
    // consumes its gap/order/parity evidence before skipping the direct body.
    if (irPlanningIdentityContext) {
      const plan = buildIrModuleInitPlan({
        sourceFile: ast.sourceFile,
        checker: ast.checker,
        identityContext: irPlanningIdentityContext,
        target: ctx.wasi ? "wasi" : ctx.standalone ? "standalone" : "host",
        deferTopLevelInit: ctx.deferTopLevelInit,
      });
      moduleInitPlanning = Object.freeze({
        plan,
        parity: reconcileIrModuleInitPlan(plan, ast.sourceFile, {
          liveFunctionNames: ctx.liveFuncBindingGlobals ?? [],
          staticEntries: ctx.staticInitExprs,
          moduleStatements: ctx.moduleInitStatements,
        }),
      });
    }

    // (#2138/#3521) IR-first compile-once inversion.
    // (#3143) Default ON. R2 prepares, optimizes, lowers, and installs every
    // retained top-level free-function IR body BEFORE the direct body emitter
    // starts. Only exact terminal owners reported as successfully patched are
    // skipped by `compileDeclarations`; unsupported owners direct-compile
    // exactly once. The old primitive-body allowlist and shipping
    // `unreachable` placeholder are no longer ownership mechanisms for this
    // population.
    //
    // Dependency-complete free functions, constructors, methods, accessors,
    // and the bounded exact Map module initializer now join one prepared route,
    // including inherited layouts. Nested classes and every other module-init
    // shape retain the post-direct overlay until their R3/R4 owners land. One
    // report reaches telemetry/auditing, so every terminal row is reconciled
    // once.
    // Selector-REJECTED functions are never claimed and still compile through
    // the direct path unchanged.
    // Escape hatch (one release, #3143): `JS2WASM_IR_FIRST=0` restores the
    // old overlay order (legacy compiles everything, IR overwrites after).
    // (#2973) `disableIrFirst` opts a compile out of the IR-first inversion
    // regardless of the ambient env flag — semantics-critical sub-compiles
    // (eval / new Function host shims) set it so a post-claim IR-first hard
    // error is not swallowed by the shim's fallback catch into a silent
    // `undefined`. The ordinary IR overlay (`experimentalIR`) still runs.
    const irFirst =
      !!options?.experimentalIR && !options?.disableIrFirst && !explicitlyDisabledEnv(process.env.JS2WASM_IR_FIRST);
    let irPlan: IrOverlayPlan | null = null;
    let requestedSkipProjection: ReturnType<typeof buildIrRequestedFunctionSkipProjection> | undefined;
    let preparedFreeFunctions: PreparedIrFreeFunctionBodies | undefined;
    let preparedClassMembers: PreparedIrClassMemberBodies | undefined;
    let preparedModuleInit: PreparedIrModuleInitBody | undefined;
    let preparedImplicitConstructorUnitIds: ReadonlySet<IrUnitId> | undefined;
    let preparedReport: IrIntegrationReport | undefined;
    let preparedSelection:
      | Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">
      | undefined;
    let irSkippedFunctionUnitIds: ReadonlySet<IrUnitId> = new Set();
    let irSkippedClassMemberUnitIds: ReadonlySet<IrUnitId> = new Set();
    let irSkippedModuleInitUnitIds: ReadonlySet<IrUnitId> = new Set();
    let irSkipBodies: ReadonlySet<string> | undefined;
    let irPreserveBodies: ReadonlySet<string> | undefined;
    if (irFirst) {
      irPlan = planIrOverlay(ctx, ast, irPlanningIdentityContext!);
      const routing = planIrFirstBodyRouting(ctx, ast.sourceFile, irPlan, moduleInitPlanning);
      requestedSkipProjection = routing.requestedSkipProjection;
      preparedFreeFunctions = routing.preparedFreeFunctions;
      preparedClassMembers = routing.preparedClassMembers;
      preparedModuleInit = routing.preparedModuleInit;
      preparedImplicitConstructorUnitIds = routing.preparedImplicitConstructorUnitIds;
      preparedReport = routing.preparedReport;
      preparedSelection = routing.preparedSelection;
      irSkipBodies = routing.skipBodies;
      irPreserveBodies = routing.preserveBodies;
    }
    // Third pass: compile function bodies
    const {
      actuallySkipped,
      classMemberUnitIds: actuallySkippedClassMemberUnitIds,
      implicitConstructorUnitIds: actuallySkippedImplicitConstructorUnitIds,
      moduleInitNames: actuallySkippedModuleInit,
    } = compileIrRoutedDeclarations({
      ctx: standaloneCalendar.reserveDirectCallbacks(irPlanningIdentityContext, !irFirst),
      sourceFile: ast.sourceFile,
      preparedClassMembers,
      preparedImplicitConstructorUnitIds,
      preparedModuleInit,
      irSkipBodies,
      irPreserveBodies,
    });
    if (irFirst) {
      const skipProjection = requestedSkipProjection;
      if (!skipProjection) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          "IR-first declaration compilation has no exact requested-skip projection",
        );
      }
      const correlated = correlateIrSkippedFunctionNames(skipProjection, actuallySkipped ?? []);
      irFirstSkipped = correlated.legacyNames;
      irSkippedFunctionUnitIds = correlated.unitIds;
      if (preparedClassMembers) {
        irSkippedClassMemberUnitIds = correlateIrSkippedBodyUnitIds(
          preparedClassMembers.skipBodyUnitIds,
          actuallySkippedClassMemberUnitIds,
          "class member",
        );
      }
      if (preparedImplicitConstructorUnitIds && preparedImplicitConstructorUnitIds.size > 0) {
        correlateIrSkippedBodyUnitIds(
          preparedImplicitConstructorUnitIds,
          actuallySkippedImplicitConstructorUnitIds,
          "implicit constructor support",
        );
      }
      if (preparedModuleInit) {
        const correlatedModuleInit = correlateIrSkippedBodyNames(
          preparedModuleInit.requestedSkipProjection,
          actuallySkippedModuleInit,
          "module initializer",
        );
        irSkippedModuleInitUnitIds = correlatedModuleInit.unitIds;
      }
    }

    // (#1602) Rebuild object-method-as-closure trampoline bodies against the
    // method's now-final signature (param types/order may have been re-resolved
    // during body compilation above).
    finalizeMethodTrampolines(ctx);

    // Experimental IR path: for functions selected by `planIrCompilation`,
    // rebuild their bodies via the middle-end IR (AST → IR → Wasm). Runs
    // AFTER `compileDeclarations` so the symbolic-ref resolver sees final
    // funcIdx / globalIdx / typeIdx assignments — this is what makes
    // `shiftLateImportIndices` a no-op for IR-path bodies.
    //
    // Phase 2: the TypeMap is computed from `buildTypeMap`, which runs
    // context-insensitive interprocedural propagation across the source
    // file's call graph. That's what lets a recursive `fib` whose param
    // is untyped in source compile as `(f64) -> f64` when a typed caller
    // (e.g. `run(n: number)`) flows `number` into it. The selector then
    // uses the TypeMap to decide which functions to claim, and closes
    // the claim set under call-graph edges so the IR path never emits a
    // cross-signature `call` against a legacy-compiled callee.
    if (options?.experimentalIR) {
      // (#2138) Under IR-first the plan was computed BEFORE
      // `compileDeclarations` (see above); otherwise compute it here — the
      // exact position the inline planning block occupied pre-#2138, so the
      // flag-off pipeline is order-identical. `planIrOverlay` holds the
      // planning code verbatim (typeMap → selection → STRICT_IR_REASONS →
      // classShapes → overrideMap → safeSelection → new.target gate).
      const plan = irPlan ?? planIrOverlay(ctx, ast, irPlanningIdentityContext!);
      const { classShapes, overrideMap } = plan;
      const safeSelection = preparedSelection ?? finalizePreparedIrSelection(ctx, ast.sourceFile, plan);
      const report = completePreparedIrIntegration({
        ctx,
        sourceFile: ast.sourceFile,
        selection: safeSelection,
        overrideMap,
        classShapes,
        ...(preparedReport ? { preparedReport } : {}),
        ...(preparedFreeFunctions ? { preparedLegacyNames: preparedFreeFunctions.completedBodies } : {}),
        ...(preparedClassMembers ? { preparedClassMemberLegacyNames: preparedClassMembers.completedBodies } : {}),
        ...(preparedClassMembers ? { preparedClassMemberUnitIds: preparedClassMembers.completedBodyUnitIds } : {}),
        ...(preparedModuleInit ? { preparedModuleInitLegacyNames: preparedModuleInit.completedBodies } : {}),
        projectLoweringPlans: (selection) => irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, selection),
      });
      consumeIrOverlayReport(
        ctx,
        report,
        plan,
        safeSelection,
        ast.sourceFile,
        irSkippedFunctionUnitIds,
        irSkippedClassMemberUnitIds,
        irSkippedModuleInitUnitIds,
      );
    }

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    // Dynamic field additions during expression compilation can add fields to struct types
    // after the constructor's struct.new was already emitted (#516).
    fixupStructNewArgCounts(ctx);

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    fixupStructNewResultCoercion(ctx);

    // Build per-shape default property flags table for all user-visible structs
    buildShapePropFlagsTable(ctx);

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    collectDeclaredFuncRefs(ctx);

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation — only include actually-used extern classes
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;
    // (#1700/#4399) Surface per-export boundary classifications so wrapExports
    // can marshal typed arrays and native strings across the JS↔Wasm edge.
    if (ctx.exportSignatures.size > 0) {
      const obj: Record<string, import("../ir/types.js").ExportSignature> = {};
      for (const [k, v] of ctx.exportSignatures) obj[k] = v;
      mod.exportSignatures = obj;
    }

    // (#2928) Register the cross-module AOT-callable carrier only after legacy
    // and IR bodies have settled their type slots. Prepending it during the
    // syntax scan shifts the legacy type indices underneath IR-first's parity
    // check for otherwise ordinary numeric AOT functions.
    if (ctx.runtimeEvalCallableBoundaryEnabled) {
      ensureRuntimeEvalAotCallableCarrierTypes(ctx);
    }

    // (#2847) Recover boolean brands after every late field has been discovered,
    // but before the host getter signatures/boxing paths are finalized.
    recoverBooleanStructFieldBrands(ctx);

    // (#2009) Resolve same-structural-shape field-name collisions BEFORE the
    // getter/setter/name-export emitters read the struct layout. Runs after ALL
    // function bodies are final (legacy + IR), so its struct.new patch covers
    // every construction site uniformly and backend-agnostically. Only structs
    // that genuinely collide are touched; everything else is byte-identical.
    resolveAndRecordShapeStamping(ctx);

    // (#2831) Reserve the per-target-vec host-externref → wasm-vec materializers
    // BEFORE the setter/dispatch emitters bake their value coercions. This pass
    // OWNS its import shifts (reserve-then-fill); the three setter emitters then
    // only `call` the materializer (no funcIdx churn). Must precede
    // emitStructFieldSetters + fillMemberSetDispatch + fillMemberGetDispatch.
    reserveVecFieldMaterializers(ctx);

    // (#3927) Mint one `__cold_ensure_<Struct>` per hot/cold-split fnctor, in
    // the same reserve-before-fill window and for the same reason: the write
    // dispatcher's fill only `call`s it, so the fill stays funcMap-read-only.
    reserveColdTailAllocators(ctx);
    reserveFnctorResidAllocators(ctx); // (#3927) per-type layouts — same reserve-before-fill discipline

    // Emit exported struct field getter helpers for the runtime.
    // These allow JS host imports to read WasmGC struct fields that are
    // otherwise opaque to JS (V8 returns undefined for direct property access).
    emitStructFieldGetters(ctx);
    emitStructFieldBooleanMarkers(ctx);
    emitStructFieldPresenceGetters(ctx);
    emitStructFieldSetters(ctx);

    // Emit __vec_get / __vec_len exports for runtime iterator fallback on WasmGC arrays
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports so the runtime can implement
    // DataView.prototype.{get,set}{Uint,Int,Float}* on i32_byte vec structs (#1056)
    emitDataViewByteExports(ctx);

    // (#3058) __rab_resize / __ab_max_len exports so the host runtime can
    // implement ArrayBuffer.prototype.resize + maxByteLength/resizable on
    // $__resizable_ab vec structs (no-op unless a resizable buffer exists).
    emitResizableAbExports(ctx);

    // (#1503) __vec_set_byte for crypto.getRandomValues to write into Uint8Array vecs.
    emitVecSetByteExport(ctx);

    // (#1700) __new_vec_f64 — JS-callable allocator for f64-element vecs so
    // wrapExports can copy Uint8Array (and other TypedArray) inputs across
    // the JS↔Wasm boundary. Gated on an exported user fn accepting a vec.
    emitNewVecF64Export(ctx);

    // Emit __test_str_from_externref / __test_str_to_externref exports for
    // dual-run testing in nativeStrings mode (#1187). No-op unless
    // ctx.testRuntime && ctx.nativeStrings.
    emitTestRuntimeStringHelpers(ctx);

    // Emit __call_@@iterator export for runtime Symbol.iterator dispatch on WasmGC structs
    emitIteratorMethodExport(ctx);

    // (#2038 / #3100, reserve-then-fill #1719) Rebuild the native `__iterator`
    // body with the LATE ladder arms now that every carrier type is known: the
    // (#3100) vec-FAMILY normalization arms ($ObjVec + `__vec_<elemKind>` —
    // dynamic iterables, previously an `illegal cast` trap) and, when the
    // closed-struct dispatchers just emitted above exist, the (#2038) USER
    // `{next()}` arm. Full docs on `fillNativeIteratorLateArms`. No-op unless
    // the standalone native iterator runtime was registered.
    if (
      ctx.nativeIteratorUserArmPending &&
      !ctx.funcMap.has("__is_truthy") &&
      ((ctx.funcMap.has("__call_@@iterator") &&
        ctx.funcMap.has("__call_next") &&
        ctx.funcMap.has("__sget_value") &&
        ctx.funcMap.has("__sget_done")) ||
        // (#3119) The plain-`$Object` OBJ arm needs `__is_truthy` too (the
        // `@@iterator`/`res` truthiness gates + the ToBoolean on `done`).
        (ctx.funcMap.has("__extern_get") && ctx.funcMap.has("__box_symbol") && ctx.objectRuntimeTypes !== undefined))
    ) {
      // The USER `done` flag needs `__is_truthy` (ToBoolean on the boxed bool).
      // `emitStructFieldGetters` usually registers it via `addUnionImports` when a
      // `{value,done}` bucket boxes, but force it here for the rare bucket shape
      // that does not, so the fill never silently degrades to vec-only.
      // Native in standalone/WASI (appends funcs, no funcIdx shift).
      addUnionImports(ctx);
    }
    fillNativeIteratorLateArms(ctx);

    // (#2903) Rebuild the Iterator-helper steppers (iter-hof-native.ts) with
    // per-producer driven-generator arms + the positive-admission classifier.
    // Read-only per #1719; no-op unless a helper call site reserved them.
    fillIterHofSteppers(ctx);

    // (#2903 R3) Prepend the `$LazyIterHelper` recognition arm to the
    // GetIterator ladder (`__iterator`/`_next`/`_return`) so `Array.from(...)`,
    // spread, and `for…of` drive a lazy map/filter/take/drop wrapper natively.
    // MUST run AFTER `fillNativeIteratorLateArms` (which rebuilds those bodies).
    // No-op unless a lazy wrapper was constructed.
    fillLazyIterLadderArms(ctx);

    // (#2922) Rebuild `__combinator_to_vec`'s user-iterable arm with the same
    // closed-struct dispatchers (identical five-dispatcher condition, so the
    // combinator drain and the native iterator carrier can never disagree).
    // No-op unless a dynamic Promise.all/race argument site registered it.
    fillCombinatorToVec(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

    // (#2962) Emit __exn_render_prepare / __exn_render_char so the test262
    // harness can render a natively-thrown GC payload ("TypeError: boom")
    // with zero host imports. No-op unless (standalone || wasi) &&
    // nativeStrings && the `$exc` tag was registered (i.e. the module can
    // actually throw).
    emitExceptionRenderExports(ctx);

    // (#3469) Emit __stdout_prepare / __stdout_char so the runner can read the
    // standalone host-free `console.log`/`print` output (the test262 async
    // completion marker) with zero host imports. No-op unless the standalone
    // stdout sink was minted (ctx.stdoutAccGlobalIdx >= 0).
    emitStdoutSinkExports(ctx);

    // Emit __call_fn_0 export for calling zero-arg closures from JS (#851)
    emitClosureCallExport(ctx);

    // Emit __call_fn_1 export for calling one-arg closures from JS (#1090)
    emitClosureCallExport1(ctx);

    // Emit __call_fn_2 export for calling two-arg closures from JS (#1382)
    // Required for Array.from(iter, mapFn) where mapFn is a Wasm closure —
    // host `Array.from` invokes mapFn with `(value, index)`, so the JS-side
    // wrapper needs a 2-arg dispatcher to route into the closure.
    emitClosureCallExport2(ctx);

    // Emit __call_fn_3 / __call_fn_4 exports (#1382 Phase 2). Required for
    // `Array.prototype.{forEach,map,filter,every,some,find,...}.call(obj, cb)`
    // dispatched through the host `__proto_method_call` — the host invokes
    // the callback with `(value, index, array)` (arity 3) or, for reduce,
    // `(acc, value, index, array)` (arity 4).
    emitClosureCallExport3(ctx);
    emitClosureCallExport4(ctx);
    emitDateHostBridge(ctx);

    // #1636-S1 — emit __call_fn_method_N exports (N=0..2) for calling Wasm
    // closures from JS with a host-supplied `this`-value. Same dispatch
    // shape as __call_fn_N but takes a leading `thisVal: externref` that
    // is stored in the `__current_this` module global across the inner
    // `call_ref` so that `ThisKeyword` references in a free-function
    // closure body observe the host's receiver. Used by `JSON.stringify`'s
    // live walk to thread the holder identity through `toJSON` and the
    // replacer function per §25.5.2.2 steps 2.b / 3.
    emitClosureMethodCallExportN(ctx, 0);
    emitClosureMethodCallExportN(ctx, 1);
    emitClosureMethodCallExportN(ctx, 2);
    // (#1888 Slice 1) Arities 3 and 4 for the standalone open-any method
    // dispatch bridge `__apply_closure` (spec D7: `o.m(a,b,c[,d])`). Each call
    // is a no-op when no closure of that arity exists, so GC/host modules without
    // arity-3/4 closures stay byte-identical. Dynamic method calls above arity 4
    // are refused-loud in `__apply_closure`.
    emitClosureMethodCallExportN(ctx, 3);
    emitClosureMethodCallExportN(ctx, 4);
    // (#1712) Arity 5 for the fnctor prototype bridge: acorn-style prototype
    // methods (e.g. `Parser.prototype.parseFunction(node, statement,
    // allowExpressionBody, isAsync, forInit)`) are dispatched from the host
    // with a receiver via `wasmClosureBridge` → `__call_fn_method_5`. No-op
    // when no arity-5 closure exists.
    emitClosureMethodCallExportN(ctx, 5);

    // (#2687) Arities 6..8 for HIGHER-arity prototype methods. acorn's
    // `parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow,
    // optionalChained, forInit)` is arity 7 and `parsePropertyValue` is arity 8;
    // a `this.parseSubscript(...)` host method-call wraps the closure and
    // dispatches it through `__call_fn_method_<N>` (runtime.ts wasmClosureBridge /
    // wasmClosureDynamicBridge). With the highest emitted dispatcher capped at 5,
    // an arity-7 closure was OMITTED from `__call_fn_method_5` (its filter is
    // `paramTypes.length <= arity`), so the dynamic method-call returned null and
    // the body never ran — parseSubscript returned null up the parse chain, leaving
    // `ExpressionStatement.expression` null (#2687) and breaking the acorn dogfood.
    // Emit one dispatcher per arity up to the module's actual max closure arity,
    // capped at 8 — the dynamic bridge's scan range
    // (`_wrapWasmClosureUnknownArity` iterates `a = 8..0`). Each call no-ops when
    // no closure of arity ≤ N exists, so modules whose methods top out at ≤5 are
    // byte-identical. Mirrors the #2664 fix direction (a method's declared arity
    // EXCEEDING the dispatcher arity — the symmetric case of fewer-args-than-params).
    {
      let maxClosureArity = 5;
      for (const info of ctx.closureInfoByTypeIdx.values()) {
        if (info.paramTypes.length > maxClosureArity) maxClosureArity = info.paramTypes.length;
      }
      maxClosureArity = maxHostFnctorMethodArity(ctx, maxClosureArity);
      // (#3981) A standalone `new <function value>(a, b, …)` driver calls
      // `__call_fn_method_<argc>`; without this the dispatcher for an
      // above-5-arity construct would never be emitted and the driver would
      // fill to its null fallback.
      maxClosureArity = Math.max(maxClosureArity, maxReservedNativeConstructArity(ctx));
      const cap = Math.min(maxClosureArity, 8);
      for (let n = 6; n <= cap; n++) emitClosureMethodCallExportN(ctx, n);
    }

    // Emit the declared-arity classifier before filling `__apply_closure`.
    // The native bridge uses it to select a dispatcher wide enough for calls
    // that omit optional trailing arguments, padding those missing formals with
    // the canonical undefined carrier just like the host wrapper does.
    emitClosureArityExport(ctx);

    // (#3668) The host fnctor method call sites reserve stable private drivers
    // before these public closure dispatchers exist. Fill them now over the
    // complete closure-shape and declared-arity tables, keeping recursive
    // parser descent in Wasm after the live host method lookup returns.
    fillHostFnctorMethodDrivers(ctx);

    // (#3981) Fill the reserved standalone `__native_construct_<N>` drivers now
    // that `__call_fn_method_<N>` is registered. No-op when no site reserved
    // one (every JS-host module, and any standalone module with no
    // `new <function value>` site).
    fillNativeConstructDrivers(ctx);

    fillConstructBoundDriver(ctx); // (#4196) §10.4.1.2 [[Construct]] through $__bound_fn
    fillRuntimeEvalConstructDriver(ctx); // (#4438) §10.2.2 [[Construct]] through an eval-lane callable

    // (#1719 CPR read-drive) Fill the reserved `__drive_proto_iterator` driver
    // body now that `__call_fn_method_0` is registered. No-op when no read-drive
    // site reserved a driver (brand clear / no Array.prototype @@iterator override).
    fillProtoIteratorDriver(ctx);

    // (#1888 S5b accessor live get/set) Fill the reserved
    // `__call_accessor_get` / `__call_accessor_set` driver bodies now that
    // `__call_fn_method_0` / `__call_fn_method_1` are registered. Same
    // reserve/fill funcIdx-authority pattern as the proto-iterator driver:
    // the `__extern_get` / `__extern_set` accessor arms baked a `call
    // <reserved funcIdx>` at object-runtime-emit time; here we give those
    // placeholders a real body (wrapping the closure-method dispatcher) so a
    // stored getter/setter closure runs with the original receiver as `this`.
    // No-op when no accessor arm reserved a driver (no standalone object runtime).
    fillAccessorDrivers(ctx);

    // (#3231) Fill the reserved `__disposablestack_dispose` driver now that
    // `__call_fn_0`/`__call_fn_1` are registered — runs each stored disposer LIFO.
    // No-op when no `.dispose()` site reserved the driver.
    fillDisposableStackDisposeDriver(ctx);

    // (#1888 Slice 1) Fill the reserved `__apply_closure` bridge body now that
    // `__call_fn_method_0..4` are registered. No-op when no standalone open-any
    // method-dispatch site reserved the bridge (`ctx.applyClosureReserved`).
    fillApplyClosure(ctx);

    // (#2660 M3) FIRST — `fillClosurePropHelpers` reads the same edge table.
    fillClosurePrototypeEdge(ctx);

    // (#3468) Fill after all closure types and object-runtime deps are known.
    fillClosurePropHelpers(ctx);

    // (#3537) Fill the array-expando side-table helpers (same deps: the
    // object-runtime funcIdxs are all in funcMap by finalize).
    fillVecPropHelpers(ctx);

    // (#3140) Fill the reserved `__bind_dyn` dynamic-bind helper now that every
    // closure root is registered (the callable gate needs the COMPLETE
    // classifier list). No-op when no standalone `.bind`-on-any site reserved it.
    fillBindDynHelper(ctx);

    // (#1100) Fill the reserved standalone Proxy trap-invoke drivers
    // (`__proxy_call_{get,set,has}`) now that `__call_fn_method_2/3/4` are
    // registered. Each driver wraps the matching closure-method dispatcher so a
    // user trap closure runs with the handler bound as `this`. No-op when no
    // standalone `new Proxy` site reserved the runtime (`ctx.proxyDispatchReserved`).
    fillProxyDispatch(ctx);

    // (#2151) Fill the reserved `__call_m_<name>` closed-struct method
    // dispatchers now that every object-literal struct + its `<Struct>_<name>`
    // method funcs are registered. Read-only over funcMap (all deps registered
    // at reserve time), so no funcIdx churn. No-op when no any-receiver call site
    // reserved a dispatcher (standalone/wasi only).
    fillClosedMethodDispatch(ctx);

    // (#3683 S3) Fill the reserved `__dc_<F>_<m>_<n>` direct-call trampolines
    // now that every typed twin exists. Runs AFTER the closed-method fill
    // because a trampoline whose twin did not materialize degrades to that
    // dispatcher. Read-only over funcMap.
    fillDirectCallTrampolines(ctx);

    // (#3125) Fill the reserved `__promise_has_callable_then` predicate — the
    // native-Promise resolve path's §27.2.1.3.2 Get("then")+IsCallable test —
    // from the SAME struct/closure collectors as the `__call_m_then_vararg`
    // dispatcher the thenable job invokes. Read-only over funcMap. No-op unless
    // the async scheduler's thenable substrate reserved it (standalone/wasi).
    fillPromiseThenableHelpers(ctx);

    // (#3172) Fill the reserved `__setrec_field_{size,has,keys}` GetSetRecord
    // readers — one ref.test arm per closed struct carrying the field, bottom
    // arm = $Object `__extern_get`. Read-only over funcMap. No-op unless a
    // set-algebra any-dispatch site reserved them (standalone/nativeStrings).
    fillSetRecFieldGetters(ctx);

    // (#2664) Fill the reserved `__set_member_<name>` member-WRITE dispatchers now
    // that EVERY struct type (incl. late-registered fnctor structs like acorn's
    // `$__fnctor_Parser`) is known — so each `any`-receiver `obj.<name> = v` write
    // enumerates the COMPLETE struct-candidate set regardless of which function
    // compiled first. Read-only over funcMap (all deps registered at reserve
    // time). No-op when no write site reserved a dispatcher. Fixes the
    // compile-order candidate freeze that lost finishToken's `this.type =` write
    // to the sidecar (8th acorn dogfood wall).
    fillMemberSetDispatch(ctx);

    // (#2674) Fill the reserved `__get_member_<name>` member-READ dispatchers —
    // the symmetric read-side counterpart of the write dispatch above. Each read
    // site's frozen multi-struct alternates fallback was replaced by a call to
    // this dispatcher, filled HERE with the COMPLETE struct-candidate set (incl.
    // late-registered fnctor structs) so a reader compiled before a struct type
    // registered still resolves the real instance's slot. Fixes the read-side
    // compile-order freeze that left parser field reads (`base.end`,
    // `this.lastTokEnd`) resolving to `__extern_get` → `undefined` (acorn 9th wall).
    fillMemberGetDispatch(ctx);

    // (#3673) Fill the TYPED `__get_member_<name>__f64` twins — numeric-slot
    // hits collapse to a bare `struct.get` arm; misses fall back to the
    // generic dispatcher body filled just above.
    fillTypedMemberGetF64Dispatch(ctx);
    fillTypedMemberSetF64Dispatch(ctx); // (#4157 A) the WRITE-side f64 twins

    // (#4157) Inline-cache the READ SITES against the arms just filled. Placed
    // HERE so the copied arm and the copy share one type/funcIdx regime — every
    // later remap treats both identically. DEFAULT ON since the tuned-set flip.
    inlineMemberGetCallSites(ctx);
    inlineIsTruthyCallSites(ctx); // (#4157) ToBoolean call-site fast path, default ON
    fuseBoxBooleanSinks(ctx); // (#4157) unboxed boolean fusion — AFTER the truthy IC, default OFF
    fillFusedToNumber(ctx); // (#4157) fused __to_number — no-op unless reserved

    // Closed compiler structs are not `$Object` hash maps. Fill the native
    // Object.hasOwn / hasOwnProperty predicates from the complete shape table.
    fillErrorPropHelpers(ctx); // (#4098) fill reserved Error bag ABI before its MOP consumers finalize
    fillInstanceTombstones(ctx); // (#4098 G1 s1) BEFORE the ladders below: they bake its call
    fillInstanceProps(ctx); // (#4194) instance expando carrier + bag get/set + tombstone resurrect
    fillClosedStructHasOwnArms(ctx);
    // (#4248) A builtin `.prototype` is a `$NativeProto`, not a `$Object`, so
    // its OWN members are invisible to the table walk. AFTER the closed-struct
    // prologue so the two arms compose in receiver-shape order.
    unshiftNativeProtoHasOwnArms(ctx);
    // (#4248) §15.5.4/§15.6.4/§15.7.4 — the three wrapper prototypes ARE
    // wrapper objects, so ToPrimitive must answer their [[PrimitiveValue]].
    unshiftNativeProtoToPrimitiveArm(ctx);
    fillClosedStructOwnPropertyNamesArms(ctx);
    fillClosedStructEnumerationArms(ctx); // (#3920) Object.keys / for…in
    fillClosedStructExternGetArms(ctx);
    // (#4194/#4232 reconciliation) Declared-field WRITE-through on `__extern_set`
    // is #4232's fill (closed-struct-extern-set.ts — presence bits, cold tail,
    // tombstone revival, single-engine coercion). The expando-bag half — writes
    // with no physical slot, bag visibility, enumeration merge — is
    // fillInstanceProps (instance-props.ts). Misses fall through from the
    // declared ladder to the bag miss-arm, so the two compose without overlap.
    fillClosedStructExternSetArms(ctx);
    fillFnctorPrototypeDispatchArms(ctx);
    // (#2875 w4-F) LAST __extern_set prologue: a runtime-keyed write to a
    // getter-only RegExp member is a sloppy no-op, not a bag entry.
    unshiftRegExpAccessorSetGuard(ctx);
    // (#2875 w4-F) `delete <Builtin>.prototype.<m>` rewrites the member CSV.
    unshiftNativeProtoDeleteArm(ctx);

    // (#3673 round 9b) LAST __extern_get body fill: prepend the per-key
    // prototype-lookup cache hit arm ahead of the ladder arms unshifted above.
    // (#4223) BEFORE the cache arm (which must stay last): answer
    // `<wrapper>.constructor` from the builtin ctor carrier.
    unshiftExternGetWrapperCtorArm(ctx);
    // (#4248) §21.1.5 — an inherited builtin-proto METHOD read off a wrapper
    // instance (or off the prototype through a binding) must yield the same
    // singleton the static `<Builtin>.prototype.<m>` read does.
    unshiftExternGetProtoMethodArm(ctx);
    unshiftExternGetProtoCacheArm(ctx);

    // (#4157) Inline `__extern_get`'s cache-hit arm at static-name call sites.
    // MUST run HERE: `unshiftExternGetProtoCacheArm` above is the last pass that
    // prepends to `__extern_get`, and the extractor accepts the body only while
    // that arm is still the PREFIX — which is also the property the arm's own
    // soundness rests on. Later fills (`fillDynamicForinVecArms`, the
    // `ta-dyn-mop` arm) unshift in front of it, so running after them makes the
    // extraction fail and the pass decline wholesale. DEFAULT ON since the flip.
    inlineExternGetCallSites(ctx);
    inlineFlatStrCallSites(ctx); // (#4157) flatten/equals site fast paths — rationale in flat-str-ic.ts

    // (#4157) Inline the member-WRITE dispatchers' first arm at the call
    // sites. Runs while the arm it copies and the copy share one type/funcIdx
    // regime — after every `__set_member_*` body fill, before any index
    // remap. DEFAULT OFF.
    inlineMemberSetCallSites(ctx);
    // (#4157) Devirtualize the filled `__call_m_<name>_<arity>` dispatchers:
    // copy each one's outermost guard + hit arm to its plain `call` sites,
    // with the unmodified dispatcher call as the miss arm. MUST run after
    // every `__call_m_*` body fill (the pass reads the final fill shape) and
    // BEFORE dead elimination / the census installs. DEFAULT OFF.
    inlineCallDispatchSites(ctx);

    // (#1904) Fill the standalone native Array.isArray predicate after all
    // module-local array carriers have been registered.
    fillExternIsArray(ctx);

    // (#2190) Fill `__extern_get_idx`'s typed-`__vec_<elemKind>` indexing arms
    // now that every array-literal carrier type is known — sibling of #2189's
    // `.length` fix, so `(arr as any)[i]` through the externref boundary reads
    // the element instead of null/0. Standalone only (no-op otherwise).
    fillExternGetIdxVecArms(ctx);

    // (#3190) Write-side sibling of the fill above: splice `$__vec_base` STORE
    // arms into `__extern_set` so `(arr as any)[i] = v` on an any-typed array
    // lands the in-bounds element instead of silently no-op'ing. Standalone
    // only (no-op otherwise).
    fillExternSetVecArms(ctx);

    // (#3169) Splice CLOSED-STRUCT array-like arms into the standalone
    // dynamic-reader trio (`__extern_length`/`__extern_get_idx`/
    // `__extern_has_idx`) now that the struct-type table is complete — a plain
    // `{0:x, 1:y, length:n}` literal (a closed nominal struct, NOT `$Object`)
    // becomes readable by the generic `Array.prototype.<HOF>.call(obj, cb)`
    // loop. Standalone only (no-op otherwise).
    fillExternArrayLikeStructArms(ctx);

    // (#3183) Splice `$__vec_base` arms into the standalone dynamic-path for-in /
    // string-key helpers (`__object_keys_forin` / `__extern_has` / `__extern_get`)
    // now that `number_toString` / `__str_to_number` / `__extern_get_idx` exist —
    // an ANY-typed runtime array (which lowers to a `__vec_<k>` struct, not a
    // `$Object`) now enumerates its index keys for-in and answers string-key
    // reads (`arr[k]`, `arr["length"]`) instead of empty / undefined. Standalone
    // only (no-op otherwise).
    fillDynamicForinVecArms(ctx);

    // Dynamic-path ArraySetLength-lite + vec-"length" own-ness: splice the
    // `$__vec_base` `"length"` WRITE arm into `__extern_set` and the
    // own-property arm into `__hasOwnProperty`/`__object_hasOwn`, so
    // propertyHelper's `isWritable(array, "length")` write/read/revert cycle
    // round-trips host-free (see vec-length-set.ts). Runs after the vec fills
    // above and BEFORE `fillTaDynViewMopArms` (dyn-view arms keep the front
    // slot). Standalone only (no-op otherwise).
    fillVecLengthDynamicArms(ctx);

    // (#3251 S1) Array-descriptor overlay: fill the reserved
    // `__vec_dp_value` / `__vec_dp_accessor` / `__vec_gopd` bodies (companion
    // `$Object` per vec receiver, delegating ValidateAndApply/merge/gOPD to
    // the `$Object` natives + vec value write-back) and splice the overlay
    // read prologues into `__extern_get_idx` / `__extern_get`. Runs AFTER the
    // vec fills above (needs every carrier + `__obj_index_of_key`) and BEFORE
    // `fillTaDynViewMopArms` below so the TypedArray dyn-view arm keeps the
    // front slot (TA receivers must exit before the overlay consult). Standalone only.
    fillObjVecReflectionHelpers(ctx);

    // (#3177) `$__ta_dyn_view` §10.4.5 MOP arms — AFTER every vec fill above
    // (each fill prepends at body[0]; last fill wins the front slot, and the
    // dyn-view arm must beat the generic `$__vec_base` arms it subtypes).
    fillTaDynViewMopArms(ctx);
    fillDataViewConstructProtoArm(ctx);
    fillReflectIsConstructor(ctx);

    // (#2896) Fill the reserved builtin-fn metadata natives
    // (`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
    // `__builtinfn_push_ownnames`) now that every builtin closure meta type
    // (builtin-fn-meta.ts) is registered — the reflective
    // `Object.getOwnPropertyDescriptor(fn, "name")` / `fn[key]` /
    // `hasOwnProperty` / `getOwnPropertyNames` reads over a builtin function
    // value resolve its spec `name`/`length` at runtime, host-free. No-op when
    // no builtin closure was materialized (standalone only).
    // (#4436) The GENERIC user-closure `length` arm must be spliced FIRST: both
    // fills splice at body index 0, so the builtin arms below land in front of
    // it. That ordering is required — a #2896 meta struct is itself a
    // funcref-wrapper-root descendant, and the builtin arms always `return`
    // (including the deleted case), so this generic arm can never shadow a
    // builtin's own metadata with a raw `$arity`.
    fillFunctionInstanceProps(ctx);
    fillBuiltinFnMeta(ctx);

    // `$__ta_ctor` name/length arm for the same meta consult — a TypedArray
    // constructor VALUE's `TA.name` / `TA.length` resolves host-free (the
    // test262 TypedArray harness's `TA.name.slice(0, -5)` trapped on the null
    // miss). Disjoint receiver guard, so order relative to fillBuiltinFnMeta
    // is immaterial; no-op unless a `$__ta_ctor` type is registered.
    fillTaCtorGetMetaArm(ctx);

    // (#3130) Splice the `$Error_struct` arm into `__extern_get` so dynamic
    // reads of `err.message`/`err.name`/`err.stack`/`err.constructor` resolve
    // on native Error objects instead of missing to `undefined` (see the fill's
    // doc in registry/error-types.ts). No-op unless the module constructs
    // native errors (standalone/wasi only) — byte-identical otherwise.
    fillExternGetErrorProps(ctx);
    emitNativeErrorBoundaryBridge(ctx);

    // (#4160) Prototype-index store: fill the reserved `__protoidx_*` helper
    // bodies and splice the `$NativeProto` write/direct-read arms into
    // `__extern_set` / `__defineProperty_value` / `__defineProperty_accessor`
    // / `__extern_get_idx` / `__extern_has_idx`. Runs AFTER every fill above
    // that locates its splice point by the helpers' preamble shape
    // (`fillExternGetIdxVecArms` / `fillExternArrayLikeStructArms`) — this
    // fill PREPENDS at body[0], which would break those shape probes if it ran
    // first. The prepended `$NativeProto` arm is receiver-disjoint from every
    // vec / TA-view arm, so taking the front slot is semantically inert.
    // No-op unless `ctx.standalone && ctx.protoIndexDirty` reserved the store.
    fillProtoIndexStore(ctx);

    // (#4222 ES5 residual) The bounded sparse Array IR provider uses the
    // normal HasProperty chokepoint, augmented with a nominal carrier arm.
    // This runs after every other dynamic-reader fill so no generic arm gains
    // `$Hole` semantics.
    fillHoleyArrayHasIdxArm(ctx);

    // (#802 Slices B+C) Mint the struct-proto natives and prepend the
    // marked-root dispatch arms into `__object_setPrototypeOf` /
    // `__getPrototypeOf` / `__extern_get`, so `Object.setPrototypeOf(
    // classInstance, proto)` records the link in the conditional appended
    // `$__proto__` field and inherited dynamic reads walk it. Mints DEFINED
    // funcs only (no import shifts). No-op unless standalone AND the
    // scanForDynamicProto prescan marked a class hierarchy — byte-identical
    // otherwise.
    fillDynamicProtoHelpers(ctx);

    // A separately compiled runtime-eval provider can invoke caller-owned AOT
    // functions through the canonical carrier and must also read their own
    // properties (for example assert.throws). Install this after every other
    // __extern_get fill so the carrier delegates directly to its owner module.
    fillRuntimeEvalCallablePropertyGetArm(ctx);

    // (#2358 #10) Fill the reserved `__array_to_primitive_string` body now that
    // `__extern_length`/`__extern_get_idx` (filled just above) and the native
    // string helpers exist. `__to_primitive`'s array-reduce arm baked a `call`
    // to this reserved funcIdx at emit time; here it gets the real
    // Array.prototype.toString (`join(",")`) loop so `Number([1])` / `1 + [2]` /
    // `"1,2" == [1,2]` reduce a runtime `$Vec` host-free. No-op when no standalone
    // `__to_primitive` reserved it (`ctx.arrayToPrimitiveReserved`).
    fillArrayToPrimitive(ctx);

    // #1504: emit __is_closure(externref) -> i32 so the JS-side wrapExports
    // can discriminate a closure struct return from a vec/struct return
    // (necessary because __vec_len returns 0 for both empty arrays and
    // non-vec structs — JS cannot tell them apart without this probe).
    emitIsClosureExport(ctx);

    // #2742: classify accessor-returned rest closures before the JS runtime
    // exposes them through a dispatcher that cannot materialize their rest vec.
    emitClosureHasRestExport(ctx);

    // #2794: emit __is_data_struct(externref) -> i32 — POSITIVE data-vs-closure
    // discriminator so `_wrapForHost` only bridges genuine closures and never
    // masks a data struct (AST Node / class instance / object literal) as callable.
    emitIsDataStructExport(ctx);

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (closures registered after the typeof helpers were
    // synthesised mid-compile). Edits the helper bodies in place — no funcIdx churn.
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch (#866)
    emitToPrimitiveMethodExports(ctx);

    // (#2638) Fill the reserved `__class_to_primitive` driver now that the
    // per-struct `__call_valueOf`/`__call_toString` dispatchers exist (emitted
    // just above). `__to_primitive`'s standalone class arm baked a `call` to the
    // reserved funcIdx at emit time; here it gets the real §7.1.1.1
    // valueOf/toString dispatch so `(new C() as any) - 8` / `Number(new C() as any)`
    // reduce via the class's methods host-free. No-op when no standalone
    // `__to_primitive` reserved it (`ctx.classToPrimitiveReserved`).
    fillClassToPrimitive(ctx);

    // #1326c Phase 1C-A — export __drain_microtasks BEFORE WASI _start so the
    // _start wrapper (which appends a drain call) can find its funcIdx.
    // Idempotent + no-op when the queue was never registered.
    exportDrainMicrotasksIfRegistered(ctx);
    exportPromiseBoundaryIfRegistered(ctx);

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    // (#2580 M0) Emit the dynamic-read primitives (__dyn_has/__dyn_get) iff a
    // call site flagged the module needs them (M1+). Gated on ctx.usesDynRead,
    // which M0 never sets, so this is a no-op in M0 → byte-identical. Runs before
    // dead-elim/freeze so the helper funcIdx values are stable.
    ensureDynReadHelpers(ctx);
    // (#3053 U0) Emit the unified dynamic-reader carrier primitive
    // (__dyn_member_get + __carrier_recv_to_extern) iff a call site flagged the
    // module needs it (U1+). Gated on ctx.usesDynMemberGet, which U0 never sets,
    // so this is a no-op in U0 → byte-identical. Runs beside ensureDynReadHelpers
    // (before dead-elim/freeze) so the helper funcIdx values are stable.
    ensureDynMemberGet(ctx);

    // (#2800) Allocate + wire the `__in_module_init` flag global now that every
    // import global has settled (final absolute index), patching the recorded
    // delete-aware read `global.get` placeholders and wrapping `__module_init`.
    // Runs before dead-elim (which never prunes/remaps live globals) and the
    // index freeze. No-op unless a gc/host delete-aware read recorded the flag.
    finalizeInModuleInitFlag(ctx);

    // (#4150/#4157) Finalize ambient-global and constant-box caches after every
    // import global settles. Each pass documents its exact placement contract.
    finalizeModuleValueCaches(ctx);

    // (#2853) Nominal shape branding: structurally-colliding `__anon_*` /
    // `__fnctor_*` shape types get a trailing brand-ref field so the engine's
    // iso-recursive canonicalization cannot merge distinct key-sets into one
    // runtime type (which made `ref.test`-keyed property dispatch read fields
    // by OFFSET instead of by KEY). Runs after all instruction emission and
    // BEFORE dead-type elimination so the brand-chain refs get remapped.
    resolveAndRecordShapeBranding(ctx);

    finalizeLeafStructTypes(ctx);

    emitDataStructHostBridgeManifest(ctx);
    standaloneCalendar.publishDomStringBoundary();

    // (#4035) Apply the host-bridge export policy BEFORE dead elimination, so
    // the functions/types those exports pin are actually reclaimed. No-op when
    // the bridge is published (js-host default).
    finalizeStandaloneTimerCallbackExports(ctx);

    // (#4257) Re-declare `ref.func` targets that the mid-finalize scan above
    // could not see: every `__extern_get`/dispatcher body FILL runs after it.
    // Additive + before dead-elim (which remaps declaredFuncRefs).
    collectDeclaredFuncRefs(ctx, { additive: true });

    // Dead import and type elimination pass
    eliminateDeadLayoutAndPlanProgramAbi(ctx); // #1899 authoritative remap, then #3520 retained ABI

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // (#3921) Allocation census — no-op unless JS2WASM_ALLOC_CENSUS=1. Placed
    // here because dead-type elimination has already remapped every `typeIdx`,
    // so the index on each `struct.new` is the one the reader will see.
    installAllocCensus(ctx);
    installExecCensus(ctx);
    // (#4157) IR-level inliner for USER code — runs by DEFAULT since the
    // tuned-set flip; a no-op only at JS2WASM_IR_INLINE=0. This exact slot is
    // load-bearing; the four preconditions are spelled out under "Placement
    // contract" in `ir-inline.ts`. Do not move it without reading them.
    inlineUserFunctions(ctx);

    // ES5 Function `caller`: after dead-import elimination has finalized
    // function indices, thread each source caller's strictness into source
    // direct/call_ref invocations. The callee snapshot was emitted at entry.
    finalizeFunctionPoisonPillCalls(ctx);

    // #1984 — freeze the index spaces. Every legitimate late import mutation
    // (addUnionImports / addStringImports / reconcileNativeStrFinalizeShift,
    // across gc/wasi/standalone) has run by this point; the remaining passes
    // (stackBalance, fixupExternConvertAny, emit) do NOT add imports. Any
    // addImport/ensureLateImport after here is a producer bug and throws at
    // its own call site (see imports.ts / late-imports.ts).
    finalizeVecHostBridgeExports(ctx);
    ctx.indexSpaceFrozen = true;
    ctx.programAbiSession?.publish(mod);

    // (#4157 park 6) Cross-hierarchy operand repair — must run BEFORE the two
    // position-guessing repairs inside stackBalance. See its own header.
    repairCrossHierarchyOperands(mod);
    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);
    // #1918 — drain fixup telemetry: per-compile debug log + optional strict mode.
    drainStackBalanceTelemetry(ctx, ast.sourceFile.fileName);

    // Late fixup: repair extern.convert_any applied to non-anyref values.
    // Must run after all other passes since they can introduce invalid coercions.
    fixupExternConvertAny(ctx);
  } catch (e) {
    recordWholeSourceFailure(ctx, ast.sourceFile, classifyIrFailure(e, "build"), irPlanningIdentityContext);
    reportErrorNoNode(ctx, `Codegen error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (#2094) Emit-time backstop for the addImport gate: scan the finished
  // import section for host imports that leaked into a standalone/strict
  // binary and report each as a structured compile error.
  assertNoLeakedHostImports(ctx, mod);

  return {
    module: mod,
    errors: ctx.errors,
    fallbackCounts: ctx.fallbackCounts,
    irPostClaimErrors: ctx.irPostClaimErrors,
    irCompiledFuncs: ctx.irCompiledFuncs,
    irFirstSkipped,
    irOutcomes: ctx.irOutcomes,
    irBodyRouteAudit: snapshotLegacyBodyAudit(ctx),
    programAbi: ctx.programAbiSession?.publication,
    moduleInitPlanning,
  };
}

/**
 * (#2094) Post-link import-section scan — emit-time backstop for the `addImport`
 * gate. A host import that survived dead-import elimination bypassed the per-call
 * gate (stale funcMap index / direct `mod.imports.push`) and would fail
 * instantiation in a hostless runtime (#2073/#2075); this turns that into a clean
 * `success: false` CE.
 *
 * Severity by target: wasi / explicit `--no-host-imports` (`strictNoHostImports`)
 * → **error** (fails the build). Plain `--target standalone` → **warning**
 * (#2961 phase 1): every leak gets a source-located advisory but the binary is
 * emitted UNCHANGED (the addImport gate stays strict-only, nothing dropped), so
 * the `host_free_pass` floor cannot move. #2961 ratchets standalone to a hard
 * error once the allowlist stabilizes; `JS2WASM_STANDALONE_LEAK_SCAN=0` disables
 * the standalone scan for A/B. No-op for host/WasmGC builds.
 */
function assertNoLeakedHostImports(ctx: CodegenContext, mod: WasmModule): void {
  const severity: "error" | "warning" | null = ctx.strictNoHostImports
    ? "error"
    : ctx.standalone && process.env.JS2WASM_STANDALONE_LEAK_SCAN !== "0"
      ? "warning"
      : null;
  if (severity === null) return;
  // #2783 — `--link`'d namespaces survive as link-time imports, not leaks.
  const hasCertifiedStandaloneTimerProvider = (module: string, name: string): boolean => {
    if (
      !ctx.requiresStandaloneTimerCallbackDispatch ||
      ctx.targetProfile.environment !== "none" ||
      module !== "env" ||
      name !== "__timer_set_timeout"
    ) {
      return false;
    }
    return mod.imports.some(
      (entry, index) =>
        entry.module === module &&
        entry.name === name &&
        isValidatedPlatformCapabilityImport(mod, index, "timers", "embedder", "none"),
    );
  };
  const hasCertifiedStandaloneDomProvider = (module: string, name: string): boolean => {
    if (
      !ctx.requiresStandaloneDomCapability ||
      ctx.targetProfile.environment !== "none" ||
      module !== "env" ||
      !isDomCapabilityImportName(name)
    ) {
      return false;
    }
    return mod.imports.some(
      (entry, index) =>
        entry.module === module &&
        entry.name === name &&
        isValidatedPlatformCapabilityImport(mod, index, "dom", "embedder", "none"),
    );
  };
  const hasCertifiedStandaloneDomInteractionProvider = (module: string, name: string): boolean => {
    if (
      !ctx.requiresStandaloneDomInteractionCapability ||
      ctx.targetProfile.environment !== "none" ||
      module !== "env" ||
      !isDomInteractionImportName(name)
    ) {
      return false;
    }
    return mod.imports.some(
      (entry, index) =>
        entry.module === module &&
        entry.name === name &&
        isValidatedPlatformCapabilityImport(mod, index, "dom-interaction", "embedder", "none"),
    );
  };
  const hasCertifiedStandaloneClockProvider = (module: string, name: string): boolean => {
    if (module !== "env" || name !== "__date_now") {
      return false;
    }
    return hasCertifiedStandaloneClockCapabilityProvider(
      mod,
      ctx.requiresStandaloneClockCapability === true,
      ctx.targetProfile.environment,
    );
  };
  const leaks = scanForLeakedHostImports(mod.imports, ctx.linkedNamespaces).filter(
    ({ module, name }) =>
      !hasCertifiedStandaloneTimerProvider(module, name) &&
      !hasCertifiedStandaloneDomProvider(module, name) &&
      !hasCertifiedStandaloneDomInteractionProvider(module, name) &&
      !hasCertifiedStandaloneClockProvider(module, name),
  );
  for (const leak of leaks) {
    reportErrorNoNode(ctx, buildLeakedHostImportError(leak, severity), severity);
  }
}

function finalizeStandaloneTimerCallbackExports(ctx: CodegenContext): void {
  publishStandaloneTimerCallbackDispatch(ctx);
  stripHostBridgeExports(ctx);
}

/**
 * #1918 — Drain stack-balance fixup telemetry after a `stackBalance(mod)` run.
 *
 * Every fixup the pass applied is a masked emitter bug. Previously the count
 * was returned and discarded. Now we:
 *   - Under `JS2WASM_LOG_STACK_BALANCE=1`, log a one-line per-kind histogram to
 *     stderr (per-compile debug visibility — AC #1).
 *   - Under `JS2WASM_STRICT_BALANCE`, push each fixup as a located
 *     severity-"warning" (=1) or severity-"error" (=error) onto `ctx.errors`
 *     (AC #3 — the lossy const-default arm is warning-visible). Strict errors
 *     fail the WasmGC compile through the existing `severity === "error"` gate.
 *
 * MUST be called immediately after `stackBalance(mod)` — the collector is
 * module-scoped and reset on the next `stackBalance` call.
 */
function drainStackBalanceTelemetry(ctx: CodegenContext, fileLabel: string): void {
  const events = getFixupEvents();
  if (process.env.JS2WASM_LOG_STACK_BALANCE === "1") {
    const counts = summarizeFixups(events);
    const hist = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(",");
    process.stderr.write(`[stack-balance] file=${fileLabel || "<source>"} fixups=${events.length} ${hist}\n`);
  }
  for (const diag of strictBalanceDiagnostics(events)) {
    ctx.errors.push({ message: diag.message, line: diag.line, column: diag.column, severity: diag.severity });
  }
}

/**
 * (#1789) Ensure `__module_init` runs before any exported function in WASI
 * mode. Two steps, both idempotent:
 *   1. Add a fresh `__init_done` i32 global (0) and prepend a self-guard to
 *      `__module_init`: `if (__init_done) return; __init_done = 1; …`.
 *   2. Prepend `call __module_init` to every exported function's body except
 *      `__module_init` itself (and `_start`, which is created later by
 *      addWasiStartExport and already calls `__module_init`).
 * Runs once — guarded by `ctx.moduleInitGuardApplied`.
 */
/**
 * (#2800) Finalize the `__in_module_init` flag, if any delete-aware `any`-receiver
 * read recorded one. The flag reads 1 while `__module_init` runs, 0 otherwise;
 * the read site (`tryEmitDeleteAwareDynamicGet`) branches on it — gc/host runs
 * `__module_init` via the Wasm `start` section INSIDE `WebAssembly.instantiate`,
 * before the host wires struct getters (`__setExports`), so the host
 * `__extern_get`'s `__sget_<field>` struct-read fallback returns undefined for
 * every field at init. The flag steers the read to the host-free
 * `__get_member_<name>` dispatcher during init and back to the tombstone-aware
 * host read at runtime.
 *
 * Allocates the i32 flag global HERE — after every import global has settled —
 * so its absolute index is final, then patches each recorded read's placeholder
 * `global.get` index to it (sidestepping the live-baked-index hazard where a
 * later string-constant import shifts the module-global range through closure
 * bodies the per-add fixup can miss) and wraps `__module_init` with set-1 /
 * set-0 around its body. MUST run AFTER the last import-global addition and BEFORE
 * the index-space freeze. No-op when no read recorded the flag (delete-free /
 * standalone / WASI modules stay byte-identical). gc/host has no module-init
 * idempotency guard (the Wasm `start` section runs the body exactly once), so the
 * simple prologue/epilogue wrap is sufficient; WASI/standalone never reach here
 * (the read site only records the flag when `!ctx.wasi`).
 */
function finalizeInModuleInitFlag(ctx: CodegenContext): void {
  const reads = ctx.inModuleInitFlagReads;
  if (!reads || reads.length === 0) return;

  // Allocate the flag global now that the import-global range is final, and
  // patch every recorded read's PLACEHOLDER index to the final slot. This MUST
  // happen even when there is no `__module_init` (a module whose only
  // delete-aware reads live inside ordinary functions, never at top level) —
  // otherwise the placeholder index 0 survives and points at the first import
  // global (an externref string constant), tripping `if[0] expected i32`
  // validation. With no init the flag simply stays 0, so every gated read takes
  // the runtime (host `__extern_get`) arm — exactly the pre-#2800 behaviour.
  const flagIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__in_module_init",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.inModuleInitGlobalIdx = flagIdx;
  for (const r of reads) (r as { index: number }).index = flagIdx;

  // Wrap the exact compiler-created initializer (when present): flag = 1 for
  // the body, 0 on completion. Preserve the legacy multi-source first-pass
  // choice until R5 replaces cumulative initializer emission.
  const initFn = ctx.programAbiModuleInitCallables?.firstFunction();
  if (!initFn) return;
  initFn.body = [
    { op: "i32.const", value: 1 },
    { op: "global.set", index: flagIdx },
    ...initFn.body,
    { op: "i32.const", value: 0 },
    { op: "global.set", index: flagIdx },
  ];
}

function applyModuleInitGuard(ctx: CodegenContext): void {
  if (ctx.moduleInitGuardApplied) return;

  // Resolve the exact compiler-created initializer. Preserve the legacy
  // multi-source first-pass choice until R5 owns graph aggregation.
  const initFn = ctx.programAbiModuleInitCallables?.firstFunction();
  const initFuncIdx = ctx.programAbiModuleInitCallables?.firstHandle();
  if (!initFn || initFuncIdx === undefined) return; // no module init — nothing to guard

  // 1. __init_done global + self-guard prologue on __module_init.
  const doneGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__init_done",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  initFn.body = [
    { op: "global.get", index: doneGlobalIdx },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "i32.const", value: 1 },
    { op: "global.set", index: doneGlobalIdx },
    ...initFn.body,
  ];

  // 2. Prepend `call __module_init` to every exported function (except
  //    __module_init itself). Idempotency makes repeated entry calls safe.
  for (const fn of ctx.mod.functions) {
    if (!fn.exported) continue;
    if (fn === initFn) continue;
    fn.body = [{ op: "call", funcIdx: initFuncIdx }, ...fn.body];
  }

  ctx.moduleInitGuardApplied = true;
}

/** Add a _start export for WASI — wraps a user `main()` (running module init
 *  first via the #1789 guard) or, when there is no callable `main`, the bare
 *  `__module_init` (#1122).
 *  When the async microtask queue was registered (#1326c Phase 1C-A), append a
 *  call to `__drain_microtasks` after the entry function so any scheduled
 *  microtasks fire before WASI process exit. */
function addWasiStartExport(ctx: CodegenContext): void {
  // (#1789) Make module init run before ANY exported function, not just
  // `_start`. The test262 standalone harness calls exports (e.g. `test()`)
  // directly without invoking `_start`, so a module-level `const`/`let`
  // object initializer would never run and a read of that binding would trip
  // its TDZ guard global → trap before init. We make `__module_init`
  // idempotent (self-guarded by a fresh `__init_done` i32 global) and prepend
  // `call __module_init` to every exported user function. The first entry
  // called — `_start` or a direct export — runs init exactly once; later calls
  // no-op. Observable top-level side effects (console.log/stdout) therefore
  // still fire on whichever entry runs first (for WASI hosts that's `_start`,
  // preserving existing stdout behaviour) and never run twice.
  //
  // This MUST run BEFORE we pick the `_start` target below: the guard prepends
  // `call __module_init` to every exported function (including a user `main`),
  // which is exactly what lets `_start → main` run module init before main's
  // body without splicing the init body into `main` (see the #1411/#1978 note
  // on target selection).
  if (ctx.wasi) {
    applyModuleInitGuard(ctx);
  }

  // (#2968) Pre-emit the uncaught-exception printer helper BEFORE any funcidx is
  // read below, so any late import it (transitively) registers shifts the index
  // space first and every index we compute afterwards is already post-shift.
  // Gated on a throwing (`exnTagIdx >= 0`), native-strings WASI module that has
  // the fd_write + proc_exit imports the printer needs (registerWasiImports set
  // both when the source contains a `throw`). A no-op otherwise, so the `_start`
  // body stays byte-identical for every non-throwing module.
  if (ctx.wasi && ctx.exnTagIdx >= 0 && ctx.nativeStrings && ctx.wasiFdWriteIdx >= 0 && ctx.wasiProcExitIdx >= 0) {
    ensureWasiStartExnPrinter(ctx);
  }

  // (#2958) Pre-emit the unhandled-rejection reporter (a no-op unless the native
  // $Promise carrier registered its tracking substrate AND fd_write/proc_exit
  // exist). Emitting it here — before any funcidx below is computed — keeps the
  // index space stable, mirroring the exn-printer discipline above. `_start`
  // calls it at the tail (after the drain/run-loop), so a still-unhandled
  // rejection is reported to stderr and the program exits nonzero.
  const unhandledReporterIdx = ctx.wasi ? ensureUnhandledRejectionReporter(ctx) : -1;

  // Choose the WASI program entry that `_start` wraps.
  //
  // #1411 regression: #1978 correctly stopped splicing the module-init body
  // INTO a user `main` (init must run once at module load, not on every
  // `main()` call), moving init to a standalone `__module_init`. But that left
  // this function preferring `__module_init` unconditionally, so for a program
  // WITH a user `main` (e.g. the Native Messaging host) `_start` wrapped ONLY
  // `__module_init` — top-level globals were initialised but the user `main()`
  // never ran, so the program produced no stdout under wasmtime.
  //
  // Fix: prefer an EXPORTED, no-arg, no-result `main` as the entry. Because
  // applyModuleInitGuard (above) has already prepended `call __module_init` to
  // every exported function, wrapping `main` runs module init exactly once (the
  // idempotent guard) and THEN main's body — restoring the pre-#1978 behaviour
  // WITHOUT re-introducing the splice. Only when there is no callable exported
  // `main` do we fall back to wrapping `__module_init` directly: that covers
  // pure top-level / init-only programs, and the `main()`-calls-itself
  // convention where a NON-exported `main` is already invoked from top-level
  // code captured in `__module_init`.
  let targetIdx: number | undefined;

  const mainIdx = ctx.funcMap.get("main");
  if (mainIdx !== undefined) {
    const func = definedFuncAt(ctx, mainIdx);
    if (func) {
      const funcType = ctx.mod.types[func.typeIdx];
      // Only an EXPORTED, no-arg, no-result `main` is a valid `_start` entry.
      // A non-exported `main` (the `main()`-calls-itself convention) is reached
      // through the top-level call already captured in `__module_init`, so it
      // must NOT be the target — and, being non-exported, it does NOT carry the
      // guard's `call __module_init` prefix, so wrapping it would skip module
      // init entirely.
      if (
        func.exported &&
        funcType &&
        funcType.kind === "func" &&
        funcType.params.length === 0 &&
        funcType.results.length === 0
      ) {
        targetIdx = mainIdx;
      }
    }
  }

  // No callable exported `main` → wrap `__module_init`, which carries all
  // top-level code (including any top-level call to a non-exported `main`).
  if (targetIdx === undefined) {
    targetIdx = ctx.programAbiModuleInitCallables?.firstHandle();
  }

  if (targetIdx !== undefined) {
    // Create _start wrapper that calls the target function
    const startTypeIdx = addFuncType(ctx, [], [], "$wasi_start_type");
    const startFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    const body: Instr[] = [{ op: "call", funcIdx: targetIdx }];

    // #2632 Phase 1 — drive the event-loop reactor after the entry function
    // returns. When the timer heap was registered, `__run_event_loop`
    // SUPERSEDES the one-shot drain: it drains microtasks AND fires timers in a
    // loop until no pending handles remain (and it calls `__drain_microtasks`
    // itself, so we must NOT also emit the bare drain). When no timer heap was
    // registered, fall back to the #1326c one-shot drain — byte-identical to
    // the prior behaviour for every program that uses no timers.
    const runLoopFuncIdx = getRunLoopFuncIdxForWasiStart(ctx);
    if (runLoopFuncIdx !== null) {
      body.push({ op: "call", funcIdx: runLoopFuncIdx });
    } else {
      const drainFuncIdx = getDrainFuncIdxForWasiStart(ctx);
      if (drainFuncIdx !== null) {
        body.push({ op: "call", funcIdx: drainFuncIdx });
      }
    }

    // (#2958) After the microtask/event-loop drain has fully quiesced, surface
    // any promise that rejected without ever getting a handler (Node parity:
    // report to stderr + exit nonzero). No-op function body when nothing was
    // tracked; only emitted at all when the reporter exists.
    if (unhandledReporterIdx >= 0) {
      body.push({ op: "call", funcIdx: unhandledReporterIdx });
    }

    // (#2968) If the uncaught-exception printer was emitted (throwing WASI
    // module), wrap the entry call + reactor drain in `try` / `catch $exc`.
    // A `return` inside the entry exits the `try` without entering the catch, so
    // only a real uncaught throw reaches the handler; there it renders the
    // payload to stderr via `__error_to_string`/fd_write and `proc_exit(1)`s so
    // the exception surfaces (instead of the pre-fix silent exit 0). No wrap when
    // the printer is absent → non-throwing modules stay byte-identical.
    const exnPrinterIdx = ctx.funcMap.get("__wasi_start_print_exn");
    const startBody: Instr[] =
      exnPrinterIdx !== undefined && ctx.wasiProcExitIdx >= 0
        ? [
            buildTargetTaggedTry(ctx, { kind: "empty" }, body, [
              {
                tagIdx: ctx.exnTagIdx,
                body: [
                  // The catch pushes the thrown externref payload; render + write it.
                  { op: "call", funcIdx: exnPrinterIdx },
                  // An uncaught exception is a failure — exit nonzero.
                  { op: "i32.const", value: 1 },
                  { op: "call", funcIdx: ctx.wasiProcExitIdx },
                  { op: "unreachable" },
                ],
              },
            ]),
          ]
        : body;

    ctx.mod.functions.push({
      name: "_start",
      typeIdx: startTypeIdx,
      locals: [],
      body: startBody,
      exported: true,
    });

    ctx.mod.exports.push({
      name: "_start",
      desc: { kind: "func", index: startFuncIdx },
    });
  }
}

/**
 * Emit exported method dispatch functions for the iterator protocol:
 * - __call_@@iterator(externref) -> externref — calls [Symbol.iterator]() on structs
 * - __call_next(externref) -> externref — calls .next() on iterator structs
 *
 * These allow the runtime to invoke WasmGC struct methods that are opaque to JS.
 */
function supportsHostClassBridgeParam(type: ValType): boolean {
  return type.kind === "externref" || type.kind === "ref_extern";
}

function emitIteratorMethodExport(ctx: CodegenContext): void {
  // The iterator protocol and the host-side dynamic class-member bridge share
  // the same `(externref) -> externref` dispatcher shape.  Keep the old
  // iterator demand gate, but also enter when a dynamic host call can target a
  // compiled class method (ordinary classes, not only fnctor subclasses).
  const needsIterator = ctx.funcMap.has("__iterator") || ctx.funcMap.has("__iterator_next");
  const needsDynamicClassMembers =
    !ctx.standalone && !ctx.wasi && ctx.hostDynamicClassMethodNames.size > 0 && ctx.classSet.size > 0;
  if (!needsIterator && !needsDynamicClassMembers) return;

  const mod = ctx.mod;
  // Rest-parameter class methods need a host bridge adapter: the Wasm ABI
  // stores `...args` as a typed GC vector while a dynamic JS call supplies an
  // ordinary argument list. Collect the affected method names up front so the
  // finalize-created vararg bridge can pack that list before dispatch.
  const restMethodKeys = new Set<string>();
  for (const [structName] of ctx.structFields) {
    for (const key of ctx.hostDynamicClassMethodNames) {
      const fullName = `${structName}_${key}`;
      if (ctx.classMethodSet.has(fullName) && ctx.funcRestParams.has(fullName)) restMethodKeys.add(key);
    }
  }
  if (restMethodKeys.size > 0) {
    ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
    // Use the ordinary property reader for the host argument list.  The
    // finalized GC host ABI canonicalizes `__extern_get_idx`'s numeric key to
    // an externref in some modules, while `__extern_get` has the stable
    // `(externref, externref) -> externref` boundary we need here.
    ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, null);
  }
  // A host dynamic call supplies externrefs.  A class bridge may therefore
  // only target methods whose formal arguments are already externref-shaped;
  // non-rest unsupported signatures deliberately remain on the existing
  // fallback path until they have a real adapter.
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_method_type");

  // Helper to emit a method dispatch export
  const emitMethodDispatch = (
    methodSuffix: string,
    exportName: string,
    classMember = false,
    classArity: number | undefined = undefined,
  ) => {
    const entries: {
      structName: string;
      typeIdx: number;
      funcIdx: number;
      resultType: ValType | undefined;
      extraParams: ValType[];
      restInfo?: RestParamInfo;
    }[] = [];

    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (isSyntheticStructName(structName)) continue;

      const methodFullName = `${structName}_${methodSuffix}`;
      // Class members use the collision-safe key and must be instance methods;
      // iterator protocol entries retain their historical flat funcMap key.
      if (classMember && !ctx.classMethodSet.has(methodFullName)) {
        continue;
      }
      const funcIdx = classMember
        ? ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName, "instance"))
        : ctx.funcMap.get(methodFullName);
      if (funcIdx === undefined) continue;

      const funcDef = definedFuncAt(ctx, funcIdx);
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      const resultType: ValType | undefined =
        funcType && funcType.kind === "func" && funcType.results.length > 0 ? funcType.results[0]! : undefined;
      // params[0] is the receiver. Iterator dispatchers are still invoked with
      // only that receiver, while host class bridges get one entry point per
      // declared arity and forward their externref arguments.
      if (!funcType || funcType.kind !== "func") continue;
      if (classMember) {
        if (funcType.params.length < 1) continue;
        const restInfo = ctx.funcRestParams.get(methodFullName);
        if (classArity === -1) {
          if (!restInfo) continue;
        } else {
          if (restInfo) continue;
          if (classArity !== undefined && funcType.params.length - 1 !== classArity) continue;
          if (funcType.params.slice(1).some((param) => !supportsHostClassBridgeParam(param))) continue;
        }
        // Class-method rest metadata uses the Wasm parameter index, including
        // the receiver at slot 0. The rest vector therefore lives at
        // `restIndex`; fixed user parameters occupy slots 1..restIndex-1.
        // Slicing through `1 + restIndex` treated the vector itself as a fixed
        // argument, which made the vararg bridge pass three values to a
        // `(receiver, vector)` method and produced invalid Wasm.
        const extraParams = restInfo ? funcType.params.slice(1, restInfo.restIndex) : funcType.params.slice(1);
        entries.push({ structName, typeIdx, funcIdx, resultType, extraParams, restInfo });
        continue;
      }
      const extraParams: ValType[] = funcType.params.slice(1);

      entries.push({ structName, typeIdx, funcIdx, resultType, extraParams });
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const bridgeTypeIdx =
      classMember && classArity === -1
        ? addFuncType(
            ctx,
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
            `$class_call_${methodSuffix}_vararg_type`,
          )
        : classMember && classArity !== undefined
          ? addFuncType(
              ctx,
              Array.from({ length: classArity + 1 }, () => ({ kind: "externref" as const })),
              [{ kind: "externref" }],
              `$class_call_${methodSuffix}_${classArity}_type`,
            )
          : dispatchTypeIdx;
    const receiverAnyLocal =
      classMember && classArity === -1 ? 2 : classMember && classArity !== undefined ? classArity + 1 : 1;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" });
    body.push({ op: "local.set", index: receiverAnyLocal });

    let current: Instr[] = [{ op: "ref.null.extern" }];

    // (#3024) Pad a missing trailing method argument. The dispatcher calls
    // `<struct>_next`/`<struct>_return` with only the receiver, so any declared
    // formal (`next(value)`) needs a default. Iterator `.next()`/`.return()`
    // invoked with no value → the value is `undefined`; for an externref (untyped
    // JS) param emit the real host `undefined` when already imported (else
    // `ref.null.extern`, byte-identical standalone). Numeric/ref params get the
    // type's zero/f64-sentinel — matching the normal missing-arg convention.
    const undefinedIdx = ctx.funcMap.get("__get_undefined");
    const padMissingArg = (pt: ValType): Instr[] => {
      switch (pt.kind) {
        case "f64":
          return [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }];
        case "f32":
          return [{ op: "f32.const", value: 0 }];
        case "i32":
        case "i8":
        case "i16":
          return [{ op: "i32.const", value: 0 }];
        case "i64":
          return [{ op: "i64.const", value: 0n }];
        case "ref":
          return [{ op: "ref.null", typeIdx: (pt as { typeIdx: number }).typeIdx }, { op: "ref.as_non_null" }];
        case "ref_null":
          return [{ op: "ref.null", typeIdx: (pt as { typeIdx: number }).typeIdx }];
        default:
          return undefinedIdx !== undefined ? [{ op: "call", funcIdx: undefinedIdx }] : [{ op: "ref.null.extern" }];
      }
    };

    const appendResultBoxing = (instrs: Instr[], resultType: ValType | undefined): void => {
      if (resultType === undefined) {
        const undefinedResultIdx = ctx.funcMap.get("__get_undefined");
        instrs.push(
          ...(undefinedResultIdx !== undefined
            ? ([{ op: "call", funcIdx: undefinedResultIdx }] satisfies Instr[])
            : ([{ op: "ref.null.extern" }] satisfies Instr[])),
        );
      } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        instrs.push({ op: "extern.convert_any" });
      } else if (resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
      } else if (resultType.kind === "i32") {
        instrs.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
      } else if (resultType.kind === "i64") {
        instrs.push({ op: "f64.convert_i64_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
      } else if (resultType.kind === "f32") {
        instrs.push({ op: "f64.promote_f32" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
      }
    };

    const appendHostIndex = (instrs: Instr[], value: Instr[]): void => {
      instrs.push(...value);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
    };

    for (const entry of entries) {
      // Keep the vararg bridge's receiver off the operand stack while the
      // host argument array is inspected and packed. Those helper calls have
      // their own stack contracts; carrying a concrete class ref across them
      // lets a later arm consume it as an argument and leaves the target call
      // with only the vector. Reload and cast the receiver immediately before
      // the target call below. Fixed-arity arms retain the older compact shape.
      const testAndCall: Instr[] =
        classMember && classArity === -1
          ? []
          : [
              { op: "local.get", index: receiverAnyLocal },
              { op: "ref.cast", typeIdx: entry.typeIdx },
            ];
      if (classMember && classArity === -1 && entry.restInfo) {
        const restInfo = entry.restInfo;
        const lengthIdx = ctx.funcMap.get("__extern_length");
        const getIdxIdx = ctx.funcMap.get("__extern_get");
        const newSizedIdx = ensureVecNewSized(ctx, restInfo.vecTypeIdx);
        const elemSetIdx = ensureVecElemSet(ctx, restInfo.vecTypeIdx);
        if (lengthIdx === undefined || getIdxIdx === undefined || newSizedIdx === null || elemSetIdx === null) {
          continue;
        }
        // Bridge locals: 3=len, 4=rest-count, 5=count-i32, 6=vec(anyref),
        // 7=loop index. The host runtime passes the ordinary JS argument
        // array as parameter 1.
        testAndCall.push(
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: lengthIdx },
          { op: "local.set", index: 3 },
          { op: "local.get", index: 3 },
          { op: "f64.const", value: entry.extraParams.length },
          { op: "f64.sub" },
          { op: "f64.const", value: 0 },
          { op: "f64.max" },
          { op: "local.tee", index: 4 },
          { op: "i32.trunc_sat_f64_s" },
          { op: "local.set", index: 5 },
          { op: "local.get", index: 4 },
          { op: "call", funcIdx: newSizedIdx },
          { op: "local.set", index: 6 },
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 7 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: 6 },
                  { op: "ref.cast", typeIdx: restInfo.vecTypeIdx },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 1 },
                  ...(() => {
                    const indexInstrs: Instr[] = [
                      { op: "local.get", index: 7 },
                      { op: "f64.convert_i32_s" },
                      { op: "f64.const", value: entry.extraParams.length },
                      { op: "f64.add" },
                    ];
                    appendHostIndex(indexInstrs, []);
                    return indexInstrs;
                  })(),
                  { op: "call", funcIdx: getIdxIdx },
                  { op: "call", funcIdx: elemSetIdx },
                  { op: "local.get", index: 7 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 7 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        );
        // Fixed parameters before the rest slot (rare for this bridge) are
        // read from the same host argument array. Marked's `use(...args)` has
        // restIndex 0, so this path is the hot/normal case.
        const fixedInstrs: Instr[] = [];
        const boxIdx = ctx.funcMap.get("__box_number");
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        for (let arg = 0; arg < entry.extraParams.length; arg++) {
          const expected = entry.extraParams[arg]!;
          const coercion = callArgCoercionInstrs({ kind: "externref" }, expected, boxIdx ?? null, unboxIdx ?? null);
          fixedInstrs.push(
            { op: "local.get", index: 1 },
            ...(() => {
              const indexInstrs: Instr[] = [{ op: "f64.const", value: arg }];
              appendHostIndex(indexInstrs, []);
              return indexInstrs;
            })(),
            { op: "call", funcIdx: getIdxIdx },
            ...coercion,
          );
        }
        // The legacy shape starts with the receiver cast, so fixed arguments
        // were inserted at offset 2. Vararg bridges now build their arguments
        // before loading/casting the receiver; prepend those fixed arguments
        // instead of splitting the length result from its local.set.
        testAndCall.splice(classMember && classArity === -1 ? 0 : 2, 0, ...fixedInstrs);
        // Reload both operands immediately before the target call. In
        // particular, do not carry the receiver through the host helper calls
        // above: the target ABI is `(receiver, rest-vector)`, not just the
        // vector produced by the packing loop.
        testAndCall.push(
          { op: "local.get", index: receiverAnyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "local.get", index: 6 },
          { op: "ref.cast", typeIdx: restInfo.vecTypeIdx },
        );
      } else if (classMember && classArity !== undefined) {
        const boxIdx = ctx.funcMap.get("__box_number");
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        for (let arg = 0; arg < entry.extraParams.length; arg++) {
          const expected = entry.extraParams[arg]!;
          const coercion = callArgCoercionInstrs({ kind: "externref" }, expected, boxIdx ?? null, unboxIdx ?? null);
          const unsupportedNumeric =
            (expected.kind === "f64" ||
              expected.kind === "f32" ||
              expected.kind === "i32" ||
              expected.kind === "i64") &&
            coercion.length === 0;
          if (unsupportedNumeric) {
            // A numeric dynamic bridge needs __unbox_number. Do not let an
            // unavailable helper make the whole module invalid; this arm is
            // unreachable for the affected signature and the host fallback
            // remains the semantic path.
            testAndCall.push({ op: "i32.const", value: 0 });
          } else {
            testAndCall.push({ op: "local.get", index: arg + 1 }, ...coercion);
          }
        }
      } else {
        testAndCall.push(...entry.extraParams.flatMap(padMissingArg));
      }
      testAndCall.push({ op: "call", funcIdx: entry.funcIdx });

      if (classMember && classArity === -1 && entry.restInfo) {
        appendResultBoxing(testAndCall, entry.resultType);
      } else if (entry.resultType === undefined) {
        const undefinedIdx = ctx.funcMap.get("__get_undefined");
        testAndCall.push(
          ...(undefinedIdx !== undefined
            ? ([{ op: "call", funcIdx: undefinedIdx }] satisfies Instr[])
            : ([{ op: "ref.null.extern" }] satisfies Instr[])),
        );
      } else if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
        testAndCall.push({ op: "extern.convert_any" });
      } else if (entry.resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx });
        }
      } else if (entry.resultType.kind === "i32") {
        testAndCall.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx });
        }
      } else if (entry.resultType.kind === "i64") {
        testAndCall.push({ op: "f64.convert_i64_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
      } else if (entry.resultType.kind === "f32") {
        testAndCall.push({ op: "f64.promote_f32" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
      }
      // externref: no conversion needed

      current = [
        { op: "local.get", index: receiverAnyLocal },
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: testAndCall,
          else: current,
        },
      ];
    }

    body.push(...current);

    const bridgeLocals =
      classMember && classArity === -1
        ? [
            { name: "__any", type: { kind: "anyref" } as const },
            { name: "__len", type: { kind: "f64" } as const },
            { name: "__count", type: { kind: "f64" } as const },
            { name: "__count_i32", type: { kind: "i32" } as const },
            { name: "__vec", type: { kind: "anyref" } as const },
            { name: "__i", type: { kind: "i32" } as const },
          ]
        : [{ name: "__any", type: { kind: "anyref" } as const }];
    mod.functions.push({
      name: exportName,
      typeIdx: bridgeTypeIdx,
      locals: bridgeLocals,
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2038) Register in funcMap so the native iterator carrier's USER arm can
    // resolve `__call_@@iterator` / `__call_next` at finalize-fill time
    // (`fillNativeIteratorLateArms`). Harmless for the host/GC path — no other
    // code looks these up by funcMap key.
    ctx.funcMap.set(exportName, funcIdx);
  };

  if (needsIterator) {
    emitMethodDispatch("@@iterator", "__call_@@iterator");
    emitMethodDispatch("next", "__call_next");
    emitMethodDispatch("return", "__call_return"); // (#3100 S5) IteratorClose §7.4.9 USER-arm dispatcher
  }

  // (#3123) Host-side class-member resolution surface for fnctor-subclass
  // instances (`class C extends F`, F a top-level plain function — the test262
  // Iterator-shim shape). The runtime's `_resolveClassMemberOnInstance` reads
  // `inst.next` / `inst.return` through these:
  //   __member_kind_<key>(recv) -> i32 : 0 none / 1 method / 2 getter
  //   __call_get_<key>(recv) -> externref : runs the compiled getter
  // (the plain-method CALL goes through the existing __call_<key> dispatchers
  // above). Gated on the module actually containing a fnctor subclass so every
  // other module's emitted bytes are IDENTICAL.
  if (!ctx.standalone && !ctx.wasi && (moduleHasFnctorSubclass(ctx) || needsDynamicClassMembers)) {
    // The iterator protocol keys plus every instance method / accessor name
    // of the module's fnctor-subclass classes (a widened binding dispatches
    // ALL its member calls dynamically — see fnctorWidenedLocals).
    const keys = new Set<string>(["next", "return"]);
    for (const className of ctx.classParentMap.keys()) {
      if (!needsDynamicClassMembers && fnctorAncestorOfClass(ctx, className) === undefined) continue;
      for (const m of ctx.classMethodNames.get(className) ?? []) keys.add(m);
      const accPrefix = `${className}_`;
      for (const acc of ctx.classAccessorSet) {
        if (acc.startsWith(accPrefix)) keys.add(acc.slice(accPrefix.length));
      }
    }
    if (needsDynamicClassMembers) {
      for (const key of ctx.hostDynamicClassMethodNames) keys.add(key);
    }
    const classMethodArities = new Map<string, Set<number>>();
    const classMethodRestKeys = new Set<string>();
    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined || isSyntheticStructName(structName)) continue;
      for (const key of keys) {
        const fullName = `${structName}_${key}`;
        if (process.env.DEBUG_MARKED_CODEGEN === "1" && key === "parseInline") {
          console.error(
            "[marked-class-bridge-scan]",
            structName,
            fullName,
            ctx.classMethodSet.has(fullName),
            ctx.staticMethodSet.has(fullName),
            ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance")),
            ctx.funcMap.get(fullName),
          );
        }
        if (!ctx.classMethodSet.has(fullName)) continue;
        const methodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance"));
        const method = methodIdx === undefined ? undefined : definedFuncAt(ctx, methodIdx);
        const methodType = method === undefined ? undefined : mod.types[method.typeIdx];
        if (!methodType || methodType.kind !== "func" || methodType.params.length < 1) continue;
        if (ctx.funcRestParams.has(fullName)) {
          classMethodRestKeys.add(key);
          continue;
        }
        if (!ctx.hostDynamicClassMethodNames.has(key) && methodType.params.length !== 1) continue;
        if (methodType.params.slice(1).some((param) => !supportsHostClassBridgeParam(param))) continue;
        let arities = classMethodArities.get(key);
        if (!arities) classMethodArities.set(key, (arities = new Set()));
        arities.add(methodType.params.length - 1);
      }
    }
    // Emit the class call bridges before the kind discriminators.  Keep the
    // zero-argument bridge in the class-specific namespace as well: the
    // ToPrimitive finalizer owns `__call_toString`/`__call_valueOf`, and using
    // those names here would create duplicate exports when a dynamically
    // called class has either method.  The host resolver prefers this
    // class-specific name and falls back to the historical iterator export.
    for (const key of [...keys].sort()) {
      for (const arity of [...(classMethodArities.get(key) ?? [])].sort((a, b) => a - b)) {
        const exportName = `__class_call_${key}_${arity}`;
        if (!ctx.funcMap.has(exportName)) emitMethodDispatch(key, exportName, true, arity);
      }
    }
    for (const key of [...classMethodRestKeys].sort()) {
      const exportName = `__class_call_${key}_vararg`;
      if (!ctx.funcMap.has(exportName)) emitMethodDispatch(key, exportName, true, -1);
    }
    // Host-backed user subclasses use a real JS object as their receiver, so
    // the historical ref.test dispatch above can never identify them. Publish
    // a class-qualified direct bridge for each own method; the runtime selects
    // it from the user-class tag before consulting the struct/fnctor surface.
    for (const className of [...ctx.classExternrefBackedSet].sort()) {
      for (const key of [...keys].sort()) {
        emitExternrefClassMethodDispatch(ctx, className, key);
      }
    }
    emitClassMemberKindExports(ctx, dispatchTypeIdx, [...keys].sort());
  }
}

/**
 * Emit a direct `(externref, ...externref) -> externref` bridge for one own
 * method of an externref-backed user subclass. Such instances are host
 * objects (for example `VirtualConsole extends EventEmitter`), therefore a
 * `ref.test` against the synthetic WasmGC class type is necessarily false.
 * The class-qualified export is resolved by the runtime through the instance
 * tag installed by `__tag_user_class`.
 */
function emitExternrefClassMethodDispatch(ctx: CodegenContext, className: string, methodName: string): void {
  const fullName = `${className}_${methodName}`;
  if (!ctx.classMethodSet.has(fullName)) return;
  const methodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance"));
  if (methodIdx === undefined) return;
  const method = definedFuncAt(ctx, methodIdx);
  const methodType = method ? ctx.mod.types[method.typeIdx] : undefined;
  if (!methodType || methodType.kind !== "func" || methodType.params.length < 1) return;
  if (!supportsHostClassBridgeParam(methodType.params[0]!)) return;
  const params = methodType.params.slice(1);
  // Keep the bridge conservative: an externref call boundary can pass host
  // values directly. Numeric/ref-specific adapters remain on the existing
  // compiler-generated call path until they have a dedicated ABI contract.
  if (params.some((param) => !supportsHostClassBridgeParam(param))) return;
  const exportName = `__class_call_${className}_${methodName}_${params.length}`;
  if (ctx.funcMap.has(exportName)) return;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, ...params.map(() => ({ kind: "externref" as const }))],
    [{ kind: "externref" }],
    `$${exportName}_type`,
  );
  const body: Instr[] = [];
  for (let index = 0; index < params.length + 1; index++) body.push({ op: "local.get", index });
  body.push({ op: "call", funcIdx: methodIdx });
  const resultType = methodType.results.length > 0 ? methodType.results[0] : undefined;
  if (resultType === undefined) {
    const undefinedIdx = ctx.funcMap.get("__get_undefined");
    body.push(undefinedIdx !== undefined ? { op: "call", funcIdx: undefinedIdx } : { op: "ref.null.extern" });
  } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    body.push({ op: "extern.convert_any" });
  } else if (resultType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return;
    body.push({ op: "call", funcIdx: boxIdx });
  } else if (resultType.kind === "i32") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return;
    body.push({ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx });
  } else if (resultType.kind === "i64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return;
    body.push({ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxIdx });
  } else if (resultType.kind === "f32") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return;
    body.push({ op: "f64.promote_f32" }, { op: "call", funcIdx: boxIdx });
  }

  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({ name: exportName, typeIdx, locals: [], body, exported: true });
  exportFunc(ctx.mod, exportName, funcIdx);
  ctx.funcMap.set(exportName, funcIdx);
}

/**
 * (#3123) Emit, per member key, the `__member_kind_<key>` discriminator and
 * (when any struct carries a getter of that name) the `__call_get_<key>`
 * getter dispatcher. Mirrors `emitIteratorMethodExport`'s per-struct
 * ref.test cascade. Getters remain self-only; methods additionally publish
 * their declared arity so the host can select an arity-specific bridge.
 */
function emitClassMemberKindExports(ctx: CodegenContext, dispatchTypeIdx: number, keys: string[]): void {
  const mod = ctx.mod;
  const skipStruct = isSyntheticStructName;

  type KindEntry = {
    typeIdx: number;
    funcIdx: number;
    resultType: ValType | undefined;
    paramTypes: ValType[];
    isRest?: boolean;
  };
  const collect = (nameOf: (structName: string) => string): KindEntry[] => {
    const entries: KindEntry[] = [];
    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined || skipStruct(structName)) continue;
      const fullName = nameOf(structName);
      if (process.env.DEBUG_MARKED_CODEGEN === "1" && fullName.endsWith("_parseInline")) {
        console.error(
          "[marked-member-kind-scan]",
          structName,
          fullName,
          ctx.classMethodSet.has(fullName),
          ctx.staticMethodSet.has(fullName),
          ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance")),
          ctx.funcMap.get(fullName),
        );
      }
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance"));
      if (funcIdx === undefined) continue;
      const funcDef = definedFuncAt(ctx, funcIdx);
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      if (!funcType || funcType.kind !== "func") continue;
      const memberKey = fullName.slice(fullName.lastIndexOf("_") + 1);
      const isGetter = fullName.includes("_get_");
      const restInfo = ctx.funcRestParams.get(fullName);
      if (!isGetter && restInfo) {
        if (!ctx.hostDynamicClassMethodNames.has(memberKey)) continue;
        const resultType: ValType | undefined = funcType.results.length > 0 ? funcType.results[0]! : undefined;
        entries.push({ typeIdx, funcIdx, resultType, paramTypes: funcType.params, isRest: true });
        continue;
      }
      if ((isGetter || !ctx.hostDynamicClassMethodNames.has(memberKey)) && funcType.params.length !== 1) continue;
      if (funcType.params.length < 1) continue;
      if (funcType.params.slice(1).some((param) => !supportsHostClassBridgeParam(param))) continue;
      const resultType: ValType | undefined = funcType.results.length > 0 ? funcType.results[0]! : undefined;
      entries.push({ typeIdx, funcIdx, resultType, paramTypes: funcType.params });
    }
    return entries;
  };

  const kindTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$member_kind_type");
  const arityTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$member_arity_type");

  for (const key of keys) {
    if (ctx.funcMap.has(`__member_kind_${key}`)) continue; // idempotent
    const methodEntries = collect((s) => `${s}_${key}`);
    const getterEntries = collect((s) => `${s}_get_${key}`);
    if (methodEntries.length === 0 && getterEntries.length === 0) continue;

    // __member_kind_<key>: ref.test cascade → 1 (method) / 2 (getter) / 0.
    {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "i32.const", value: 0 }];
      const arm = (typeIdx: number, kind: number, tail: Instr[]): Instr[] => [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: kind }],
          else: tail,
        },
      ];
      for (const e of methodEntries) current = arm(e.typeIdx, 1, current);
      for (const e of getterEntries) current = arm(e.typeIdx, 2, current);
      const exportName = `__member_kind_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: kindTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current],
        exported: true,
      } as WasmFunction);
      exportFunc(mod, exportName, funcIdx);
      ctx.funcMap.set(exportName, funcIdx);
    }

    // __member_arity_<key>: identify the matching method's declared arity.
    // The host bridge uses this to choose the correct all-externref dispatcher
    // even when the JS call omits trailing arguments or supplies extras.
    if (methodEntries.length > 0 && !ctx.funcMap.has(`__member_arity_${key}`)) {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "i32.const", value: -1 }];
      for (const e of methodEntries) {
        current = [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: e.typeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: e.isRest ? -1 : e.paramTypes.length - 1 }],
            else: current,
          },
        ];
      }
      const exportName = `__member_arity_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: arityTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current],
        exported: true,
      } as WasmFunction);
      exportFunc(mod, exportName, funcIdx);
      ctx.funcMap.set(exportName, funcIdx);
    }

    // __call_get_<key>: run the compiled getter, box-coerce to externref.
    if (getterEntries.length > 0) {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "ref.null.extern" }];
      for (const e of getterEntries) {
        const callArm: Instr[] = [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: e.typeIdx },
          { op: "call", funcIdx: e.funcIdx },
        ];
        if (e.resultType === undefined) {
          const undefinedIdx = ctx.funcMap.get("__get_undefined");
          callArm.push(
            ...(undefinedIdx !== undefined
              ? ([{ op: "call", funcIdx: undefinedIdx }] satisfies Instr[])
              : ([{ op: "ref.null.extern" }] satisfies Instr[])),
          );
        } else if (e.resultType.kind === "ref" || e.resultType.kind === "ref_null") {
          callArm.push({ op: "extern.convert_any" });
        } else if (e.resultType.kind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx });
        } else if (e.resultType.kind === "i32") {
          callArm.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx });
        }
        current = [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: e.typeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: callArm,
            else: current,
          },
        ];
      }
      const exportName = `__call_get_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: dispatchTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current],
        exported: true,
      } as WasmFunction);
      exportFunc(mod, exportName, funcIdx);
      ctx.funcMap.set(exportName, funcIdx);
    }
  }
}

/**
 * (#1716) Emit `__call_@@toPrimitive(self, hint) -> externref` — a 2-arg
 * dispatch wrapper so the runtime can invoke a class's `[Symbol.toPrimitive]`
 * *method* on an opaque WasmGC struct.
 *
 * Unlike valueOf/toString (which compile to `__call_<name>` 1-arg dispatchers
 * emitted by `emitToPrimitiveMethodExports` and picked up by `_hostToPrimitive`'s
 * OrdinaryToPrimitive loop), the exotic @@toPrimitive method takes the ToPrimitive
 * hint string and had NO runtime dispatch export — so ToPropertyKey (object used
 * as a property key) and String()/RegExp()/Date() object-arg coercion on such a
 * key/arg silently fell through to the opaque-struct "[object Object]" sentinel
 * (the §7.1.1 residual tracked in #1716). The method body is registered as
 * `${structName}_@@toPrimitive(self, hint)`; we ref.test `self` against each
 * such struct and forward the externref hint.
 *
 * The dispatch forwards the runtime-supplied hint as an externref (the JS-host
 * string backend's representation). In nativeStrings mode the hint param is a
 * WasmGC `(ref $string)` i16 array we cannot synthesize from the externref
 * inline, and the runtime that calls `__call_@@toPrimitive` is JS-host-only and
 * never runs in the standalone nativeStrings path — so such entries are skipped
 * to keep Wasm validation green in every mode.
 */
function emitToPrimitiveMethodExport(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const methodSuffix = "@@toPrimitive";
  const exportName = "__call_@@toPrimitive";

  // (#2083) Ensure the union imports (which register `__box_number`) are present
  // BEFORE the entries loop below resolves `funcIdx` values and reads result
  // signatures. A numeric (`f64`/`i32`) `[Symbol.toPrimitive]` result is boxed to
  // externref via `__box_number` for the dispatcher's externref fallthrough; the
  // boxing arms `ctx.funcMap.get("__box_number")` and silently skip the `call`
  // when it is absent, leaving an `f64`/struct ref where the block result demands
  // `externref` (invalid Wasm). This used to be masked because
  // `emitVecAccessExports` ran earlier and unconditionally called
  // `addUnionImports`; now that the vec exports are gated on actual array usage
  // (#2083), an object-only program with a numeric `[Symbol.toPrimitive]` and no
  // arrays no longer gets that side effect. `addUnionImports` adds imports and
  // SHIFTS function indices, so it MUST run before `funcIdx`/`resultType` are
  // captured below — doing it after would leave the captured `funcIdx` integers
  // pointing at the wrong (pre-shift) functions. It is idempotent
  // (`ctx.hasUnionImports` guard), so modules that already added the imports —
  // every array-using module, and any object module that needed them elsewhere —
  // are byte-identical. Gated on the presence of any numeric `@@toPrimitive`
  // method so non-toPrimitive / string-only-toPrimitive modules add no import.
  if (toPrimitiveNeedsBoxing(ctx, methodSuffix)) {
    addUnionImports(ctx);
  }

  const entries: { typeIdx: number; funcIdx: number; resultType: ValType; takesHint: boolean }[] = [];

  for (const [structName] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (isSyntheticStructName(structName)) continue;

    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${structName}_${methodSuffix}`)); // (#1983)
    if (funcIdx === undefined) continue;

    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    const resultType: ValType =
      funcType && funcType.kind === "func" && funcType.results.length > 0
        ? funcType.results[0]!
        : { kind: "externref" };

    // (#2883) The resolved `${structName}_@@toPrimitive` function is either a
    // 2-param `(self, hint) -> result` method (the method declared its hint
    // param — nominal class OR object literal `[Symbol.toPrimitive](hint)`) or a
    // 1-param `(self) -> result` body (the method ignores the hint, e.g. the very
    // common `[Symbol.toPrimitive]() { throw … }` abrupt-completion shape, whose
    // object-literal closure body is `(captureStruct) -> result`). The dispatcher
    // must forward the hint ONLY in the 2-param case; pushing `self + hint` into a
    // 1-param callee produced an arity mismatch that a downstream arg-coercion
    // pass "repaired" by dropping the result and leaving the struct ref on the
    // stack — yielding an invalid `fallthru[0] (expected externref, got (ref N))`
    // module for ~40 suite-wide tests. Branch on the real param count.
    const paramCount = funcType && funcType.kind === "func" ? funcType.params.length : 1;
    const takesHint = paramCount >= 2;
    // When the hint IS forwarded, skip nativeStrings non-externref string-ref
    // hint params (the runtime that calls `__call_@@toPrimitive` is JS-host-only
    // and cannot synthesize the WasmGC string-ref hint inline — see doc comment).
    const hintParamType = takesHint && funcType && funcType.kind === "func" ? funcType.params[1] : undefined;
    if (hintParamType !== undefined && hintParamType.kind !== "externref") continue;

    entries.push({ typeIdx, funcIdx, resultType, takesHint });
  }

  if (entries.length === 0) return;

  const dispatchTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_method_2arg_type",
  );

  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const body: Instr[] = [];
  // local 2 = any.convert_extern(self)
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: 2 });

  let current: Instr[] = [{ op: "ref.null.extern" }];

  for (const entry of entries) {
    const testAndCall: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: entry.typeIdx },
    ];
    // (#2883) Forward the ToPrimitive hint ONLY to a method that declared it.
    // A hint-less `[Symbol.toPrimitive]()` body takes a single (self/capture)
    // param; pushing the hint there is an arity mismatch that corrupts the
    // dispatcher (see entry-collection comment above).
    if (entry.takesHint) {
      testAndCall.push({ op: "local.get", index: 1 }); // hint (externref)
    }
    testAndCall.push({ op: "call", funcIdx: entry.funcIdx });

    if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
      testAndCall.push({ op: "extern.convert_any" });
    } else if (entry.resultType.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
    } else if (entry.resultType.kind === "i32") {
      testAndCall.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
    }

    current = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: entry.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: testAndCall,
        else: current,
      },
    ];
  }

  body.push(...current);

  mod.functions.push({
    name: exportName,
    typeIdx: dispatchTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  exportFunc(mod, exportName, funcIdx);
}

/**
 * (#2083) True when at least one class `[Symbol.toPrimitive]` method in the
 * module returns a numeric (`f64`/`i32`) type — i.e. the `__call_@@toPrimitive`
 * dispatcher will need `__box_number` to box that result to externref. Mirrors
 * the entry-filtering in `emitToPrimitiveMethodExport` (skips Wrapper/$AnyValue/
 * vec/arr structs) and reads the compiled method's result signature. Computed
 * BEFORE any `addUnionImports`-induced funcIdx shift, off the same `funcMap` /
 * `mod.functions` state, so it is shift-stable. Used to gate the pre-emit
 * `addUnionImports` so non-numeric-toPrimitive modules add no import.
 */
function toPrimitiveNeedsBoxing(ctx: CodegenContext, methodSuffix: string): boolean {
  const mod = ctx.mod;
  for (const [structName] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${structName}_${methodSuffix}`));
    if (funcIdx === undefined) continue;
    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    const resultType =
      funcType && funcType.kind === "func" && funcType.results.length > 0 ? funcType.results[0] : undefined;
    if (resultType && (resultType.kind === "f64" || resultType.kind === "i32")) return true;
  }
  return false;
}

/**
 * Emit __call_toString and __call_valueOf exports for ToPrimitive dispatch (#866).
 * These allow the JS runtime to call toString/valueOf on WasmGC structs
 * that are opaque to JavaScript (struct fields are funcrefs, not JS functions).
 *
 * Handles both:
 * - Standalone methods: StructName_toString compiled as a function
 * - Closure fields: toString field is a closure ref, call via struct.get + call_ref
 */
function emitToPrimitiveMethodExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_toPrim_type");

  const emitDispatchForMethod = (methodName: string, exportName: string) => {
    type DispatchEntry =
      | {
          structName: string;
          typeIdx: number;
          mode: "standalone";
          funcIdx: number;
          resultType: ValType;
        }
      | {
          structName: string;
          typeIdx: number;
          mode: "closure";
          fieldIdx: number;
          closureTypeIdx: number;
          closureInfo: ClosureInfo;
        }
      | {
          // (#1989) externref field holding a closure (the `any`-typed
          // object-literal method case — the field stores
          // `extern.convert_any(closureStruct)`). Recover the closure per
          // instance: `struct.get` (externref) → `any.convert_extern` →
          // `ref.cast closureTypeIdx` → field-0 funcref → `call_ref`. This makes
          // `__call_valueOf`/`__call_toString` per-object even when same-shape
          // literals share a struct type but store distinct method funcrefs.
          structName: string;
          typeIdx: number;
          mode: "closure-extern";
          fieldIdx: number;
          closureTypeIdx: number;
          closureInfo: ClosureInfo;
        }
      | {
          // (#2891) eqref closure field, GUARDED multi-candidate dispatch. A
          // single-literal object struct stores its `valueOf`/`toString` method
          // as a per-instance closure in an `eqref` field, but
          // `ctx.valueOfClosureTypes` accumulates the closure types of BOTH
          // fields, so a fixed "first tracked type" pick (the legacy eqref arm)
          // can `ref.cast` the WRONG field's closure type and TRAP. We instead
          // `ref.test` each candidate closure type on the actual stored field
          // value and `call_ref` the one that matches (null if none) — trap-free.
          // This is what lets standalone reduce a single-literal object operand
          // (the pre-#2891 code gated single literals out for exactly this trap
          // risk). Standalone-only widening; the host `_hostToPrimitive` path is
          // unchanged (it stays on the name-keyed arm).
          structName: string;
          typeIdx: number;
          mode: "closure-eqref-multi";
          fieldIdx: number;
          candidates: { closureTypeIdx: number; closureInfo: ClosureInfo }[];
        }
      | {
          // (ES5 standalone lane) A callable stored in an `externref`/`eqref`
          // method field whose closure type was never tracked for this struct
          // (the fnctor `this.toString = function(){…}` shape). Dispatched
          // DYNAMICALLY through `__call_accessor_get(recv, callable)` rather than
          // a baked `call_ref`, so it needs no compile-time closure identity.
          structName: string;
          typeIdx: number;
          mode: "callable-dynamic";
          fieldIdx: number;
          fieldKind: "externref" | "eqref";
          accessorGetIdx: number;
          typeofFunctionIdx: number;
        };

    const entries: DispatchEntry[] = [];

    for (const [structName, fields] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (isSyntheticStructName(structName)) continue;

      const methodFullName = `${structName}_${methodName}`;
      const fieldIdx = fields.findIndex((f) => f.name === methodName);
      const field = fieldIdx >= 0 ? fields[fieldIdx]! : undefined;

      // (#1989) 1. Per-instance closure FIELD takes precedence over the
      // name-keyed standalone method — but ONLY for structs with the genuine
      // same-shape collision (`toPrimitiveForkedStructs`): two+ object literals
      // share the deduped struct type, each storing its OWN method closure in
      // the field, so reading the field + `call_ref` resolves to the right body
      // per object. The standalone `${structName}_${methodName}` func is only the
      // first literal's body and would collapse all instances onto it.
      //
      // Single-literal structs intentionally STAY on the name-keyed standalone
      // arm below: it is the one literal's correct body, is simpler, and
      // (critically) preserves the §7.1.1.1 step-6 object-return TypeError walk
      // in `_hostToPrimitive`. Same-shape valueOf/toString closures are
      // `ref.test`-indistinguishable, so routing a single-literal struct through
      // the per-instance arm could mis-select the closure type for `toString`.
      const forked = ctx.toPrimitiveForkedStructs.has(structName);
      // (#2891) In STANDALONE, also route single-literal closure-method structs
      // through the per-instance closure arm — there is no host `_hostToPrimitive`
      // to fall back on, so the name-keyed arm (which collapses same-shape
      // literals AND cannot model the §7.1.1.1 object-return fall-through) is not
      // enough. The eqref path below is GUARDED (`closure-eqref-multi`), so the
      // trap that previously justified gating single literals out is avoided.
      const preferClosure = forked || ctx.standalone;
      let pushedClosure = false;
      if (field && preferClosure) {
        // Closure ref field (eagerly-typed closure ref).
        if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          const closureTypeIdx = (field.type as { typeIdx: number }).typeIdx;
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo && closureInfo.paramTypes.length === 0) {
            entries.push({ structName, typeIdx, mode: "closure", fieldIdx, closureTypeIdx, closureInfo });
            pushedClosure = true;
          }
        }
        // eqref field — GUARDED multi-candidate dispatch over the tracked closure
        // types (typed object-literal methods). `ref.test` selects the closure
        // type actually stored in THIS field, so accumulating both valueOf and
        // toString closure types in `valueOfClosureTypes` can no longer mis-cast.
        if (!pushedClosure && field.type.kind === "eqref") {
          const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
          const candidates: { closureTypeIdx: number; closureInfo: ClosureInfo }[] = [];
          for (const closureTypeIdx of trackedTypes) {
            const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            if (closureInfo && closureInfo.paramTypes.length === 0) {
              candidates.push({ closureTypeIdx, closureInfo });
            }
          }
          if (candidates.length > 0) {
            entries.push({ structName, typeIdx, mode: "closure-eqref-multi", fieldIdx, candidates });
            pushedClosure = true;
          }
        }
        // (#1989) externref field holding a closure — the `any`-typed
        // object-literal method case. The field stores
        // `extern.convert_any(closureStruct)`; recover it per instance.
        if (!pushedClosure && field.type.kind === "externref") {
          const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
          for (const closureTypeIdx of trackedTypes) {
            const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            if (closureInfo && closureInfo.paramTypes.length === 0) {
              entries.push({ structName, typeIdx, mode: "closure-extern", fieldIdx, closureTypeIdx, closureInfo });
              pushedClosure = true;
              break;
            }
          }
        }
        // (ES5 standalone lane) The field holds a callable, but no closure type
        // was TRACKED for this struct — so none of the three arms above can bake
        // a static `call_ref`. Dispatch dynamically instead, through the same
        // `__call_accessor_get(recv, callable)` driver the open-`$Object`
        // property runtime uses to run a getter with a bound `this`.
        //
        // This is the plain-function-constructor ("fnctor") case:
        // `function F(){ this.toString = function(){…} }`. Its instance is a
        // NOMINAL struct whose `toString` field is a plain `externref`, but the
        // write goes through the fnctor constructor-field path, not the typed
        // `obj.f = fn` path that populates `ctx.valueOfClosureTypes` — so
        // `trackedTypes` is empty and #1989's `closure-extern` arm never fires.
        // The struct then produced NO dispatch entry at all, `__call_toString`
        // answered `ref.null.extern`, and `__class_to_primitive`'s string-hint
        // tail rendered the canonical "[object Object]". Measured standalone:
        // `"" + new F()`, `String(new F())` and every borrowed
        // `String.prototype.<m>.call(new F(), …)` all answered "[object Object]"
        // for a receiver whose own `toString` returns "OWN".
        //
        // `__typeof_function` gates the call so a non-callable field (a data
        // property literally named `toString`) still reports "absent" (null)
        // rather than invoking a garbage funcref — same answer as today.
        if (!pushedClosure && (field.type.kind === "externref" || field.type.kind === "eqref")) {
          const accessorGetIdx = ctx.funcMap.get(CALL_ACCESSOR_GET);
          const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
          if (accessorGetIdx !== undefined && typeofFunctionIdx !== undefined) {
            entries.push({
              structName,
              typeIdx,
              mode: "callable-dynamic",
              fieldIdx,
              fieldKind: field.type.kind,
              accessorGetIdx,
              typeofFunctionIdx,
            });
            pushedClosure = true;
          }
        }
      }
      if (pushedClosure) continue;

      // 2. Fallback: name-keyed standalone method `StructName_toString`. Used by
      // nominal class methods and structs whose method has no stored closure.
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx !== undefined) {
        const funcDef = definedFuncAt(ctx, funcIdx);
        const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
        const resultType: ValType =
          funcType && funcType.kind === "func" && funcType.results.length > 0
            ? funcType.results[0]!
            : { kind: "externref" };
        entries.push({ structName, typeIdx, mode: "standalone", funcIdx, resultType });
      }
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1;

    const boxResult = (resultType: ValType, instrs: Instr[]) => {
      if (resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "i32") {
        instrs.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "i64") {
        // i64 (BigInt) — convert to f64 then box, or drop and return null
        instrs.push({ op: "f64.convert_i64_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        instrs.push({ op: "extern.convert_any" });
      }
    };

    const buildDispatch = (idx: number): Instr[] => {
      if (idx >= entries.length) return [{ op: "ref.null.extern" }];
      const entry = entries[idx]!;

      const thenInstrs: Instr[] = [];
      if (entry.mode === "standalone") {
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          {
            op: "call",
            funcIdx: entry.funcIdx,
          },
        );
        boxResult(entry.resultType, thenInstrs);
      } else if (entry.mode === "closure-extern") {
        // (#1989) externref field holding `extern.convert_any(closureStruct)`.
        // Recover the per-instance closure: struct.get (externref) →
        // any.convert_extern → ref.cast closureType → field-0 funcref → call_ref.
        const ci = entry.closureInfo;
        const closureLocal = 2; // eqref scratch local
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
          // externref field → anyref → concrete closure ref → eqref scratch.
          // (#2878) `any.convert_extern` yields `anyref`, which is the SUPERtype
          // of the `eqref` scratch local — a bare `local.set` of anyref into an
          // eqref local fails validation ("local.set expected eqref, found
          // anyref of type anyref"), the standalone `__call_toString` /
          // `__call_valueOf` invalid-Wasm bucket (#2860/#2868 residual). Narrow
          // to the concrete closure struct type first (a valid eqref subtype);
          // the field holds `extern.convert_any(closureStruct)`, so this recovers
          // exactly that struct. The `ref.cast entry.closureTypeIdx` uses of
          // `closureLocal` below become redundant re-casts of the same concrete
          // type (harmless), and this adds no new trap — that cast already ran
          // unconditionally on the value.
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "local.set", index: closureLocal },
          // self-param: the closure struct
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // funcref from closure field 0
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx },
        );
        if (!ci.returnType) {
          thenInstrs.push({ op: "ref.null.extern" });
        } else {
          boxResult(ci.returnType, thenInstrs);
        }
      } else if (entry.mode === "callable-dynamic") {
        // (ES5 standalone lane) Untracked callable in a method field: read it,
        // confirm it is callable, and invoke it with `this` bound to the
        // receiver via the shared accessor-get driver. `boxResult` is not needed
        // — the driver already answers a boxed `externref`.
        //
        // A field never assigned holds `ref.null.extern` (or the `$undefined`
        // singleton); `__typeof_function` answers 0 for both, so the arm reports
        // "no such method" exactly as an absent entry did.
        const callableLocal = 6; // externref scratch (the stored method value)
        const loadField: Instr[] = [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
        ];
        if (entry.fieldKind === "eqref") loadField.push({ op: "extern.convert_any" });
        thenInstrs.push(
          ...loadField,
          { op: "local.set", index: callableLocal },
          { op: "local.get", index: callableLocal },
          { op: "call", funcIdx: entry.typeofFunctionIdx },
          {
            op: "if",
            blockType: { kind: "val" as const, type: { kind: "externref" as const } },
            then: [
              // receiver (externref) — `this` for the call
              { op: "local.get", index: anyLocal },
              { op: "extern.convert_any" },
              { op: "local.get", index: callableLocal },
              { op: "call", funcIdx: entry.accessorGetIdx },
            ],
            else: [{ op: "ref.null.extern" }],
          },
        );
      } else if (entry.mode === "closure-eqref-multi") {
        // (#2891) GUARDED dispatch over candidate closure types for an eqref
        // method field. Read the field once into the eqref scratch, then
        // `ref.test` each candidate and `call_ref` the matching one (null if
        // none) — never an unguarded `ref.cast`, so the wrong-field-type trap is
        // impossible.
        const closureLocal = 2; // eqref scratch local (the stored method closure)
        const fieldEntry = entry;
        const buildCandidate = (ci: number): Instr[] => {
          if (ci >= fieldEntry.candidates.length) return [{ op: "ref.null.extern" }];
          const { closureTypeIdx, closureInfo } = fieldEntry.candidates[ci]!;
          // Body run when BOTH the struct cast and the funcref type match.
          const callInstrs: Instr[] = [
            // self-param: the closure struct (cast is safe — struct ref.test passed)
            { op: "local.get", index: closureLocal },
            { op: "ref.cast", typeIdx: closureTypeIdx },
            // funcref already validated + stashed in eqrefFuncLocal
            { op: "local.get", index: eqrefFuncLocal },
            { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx },
            { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
          ];
          if (!closureInfo.returnType) {
            callInstrs.push({ op: "ref.null.extern" });
          } else {
            boxResult(closureInfo.returnType, callInstrs);
          }
          // Guard 1: the stored closure must be (a subtype of) this candidate's
          // struct type. Guard 2: its funcref (field 0) must be this candidate's
          // func type — distinct methods can share a struct type but differ in
          // func type, so the funcref test is the real discriminator (an
          // unguarded `ref.cast funcTypeIdx` would TRAP otherwise).
          return [
            { op: "local.get", index: closureLocal },
            { op: "ref.test", typeIdx: closureTypeIdx },
            {
              op: "if",
              blockType: { kind: "val" as const, type: { kind: "externref" as const } },
              then: [
                { op: "local.get", index: closureLocal },
                { op: "ref.cast", typeIdx: closureTypeIdx },
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
                { op: "local.tee", index: eqrefFuncLocal },
                { op: "ref.test", typeIdx: closureInfo.funcTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val" as const, type: { kind: "externref" as const } },
                  then: callInstrs,
                  else: buildCandidate(ci + 1),
                },
              ],
              else: buildCandidate(ci + 1),
            },
          ];
        };
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
          { op: "local.set", index: closureLocal },
          ...buildCandidate(0),
        );
      } else {
        // Closure field: extract closure, get funcref, call_ref
        const ci = entry.closureInfo;
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          {
            op: "struct.get",
            typeIdx: entry.typeIdx,
            fieldIdx: entry.fieldIdx,
          },
        );
        // The struct.get returns the field type (eqref or ref). Store in eqref local.
        const closureLocal = 2; // eqref local
        thenInstrs.push(
          { op: "local.set", index: closureLocal },
          // Cast eqref to closure struct type for the self-param
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // Get funcref from closure field 0
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx },
        );
        const retType = ci.returnType ?? { kind: "externref" as const };
        if (!ci.returnType) {
          // void — push null externref
          thenInstrs.push({ op: "ref.null.extern" });
        } else {
          boxResult(retType, thenInstrs);
        }
      }

      return [
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "externref" as const } },
          then: thenInstrs,
          else: buildDispatch(idx + 1),
        },
      ];
    };

    // Determine locals: param 0 (externref), local 1 (anyref), local 2 (eqref for closure)
    // (#2679) locals 3/4 (__prev_this / __tp_result) thread `__current_this`.
    const hasClosureEntry = entries.some(
      (e) => e.mode === "closure" || e.mode === "closure-extern" || e.mode === "closure-eqref-multi",
    );
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (hasClosureEntry) {
      locals.push({ name: "__closure", type: { kind: "eqref" } });
    } else {
      // Reserve slot 2 so the prevThis/result locals land at fixed indices 3/4
      // regardless of the closure-entry branch.
      locals.push({ name: "__closure_unused", type: { kind: "eqref" } });
    }
    // (#2679) `__call_valueOf`/`__call_toString` must invoke the method with the
    // RECEIVER as `this` (§7.1.1.1 OrdinaryToPrimitive step 4.b `Call(method, O)`).
    // A compiled `valueOf(){…this…}` reads `this` from `__current_this`; the
    // dispatch below `call_ref`s the closure body WITHOUT installing it, so the
    // body saw a stale `this`. Install `__current_this` = param 0 (the receiver)
    // around the dispatch and restore it afterward (nesting-safe).
    const prevThisLocal2 = 3;
    const tpResultLocal = 4;
    locals.push({ name: "__prev_this", type: { kind: "externref" } });
    locals.push({ name: "__tp_result", type: { kind: "externref" } });
    // (#2891) funcref scratch (index 5) for the guarded `closure-eqref-multi`
    // dispatch — distinct method closures can share one closure STRUCT type but
    // carry different FUNC types, so the candidate is discriminated by a guarded
    // `ref.test` on the funcref (field 0), not by the struct type alone.
    locals.push({ name: "__tp_funcref", type: { kind: "funcref" } });
    const eqrefFuncLocal = 5;
    // (ES5 standalone lane) externref scratch (index 6) for the
    // `callable-dynamic` arm — the untracked method value read out of the
    // struct field, held across the `__typeof_function` guard and the
    // `__call_accessor_get` invocation.
    locals.push({ name: "__tp_callable", type: { kind: "externref" } });
    const currentThisGlobalIdx2 = ensureCurrentThisGlobal(ctx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      // save __current_this, install the receiver
      { op: "global.get", index: currentThisGlobalIdx2 },
      { op: "local.set", index: prevThisLocal2 },
      { op: "local.get", index: 0 },
      { op: "global.set", index: currentThisGlobalIdx2 },
      // dispatch (leaves result externref on stack) → capture
      ...buildDispatch(0),
      { op: "local.set", index: tpResultLocal },
      // restore __current_this, return the captured result
      { op: "local.get", index: prevThisLocal2 },
      { op: "global.set", index: currentThisGlobalIdx2 },
      { op: "local.get", index: tpResultLocal },
    ];

    mod.functions.push({
      name: exportName,
      typeIdx: dispatchTypeIdx,
      locals,
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2638) Record the dispatcher funcIdx so `fillClassToPrimitive` can `call`
    // it from the reserved `__class_to_primitive` driver. The host-side
    // `_hostToPrimitive` loop reaches these via the export, not funcMap, so this
    // is purely additive (the iterator dispatchers already use this convention).
    ctx.funcMap.set(exportName, funcIdx);
  };

  emitDispatchForMethod("toString", "__call_toString");
  emitDispatchForMethod("valueOf", "__call_valueOf");
}

/**
 * (#2931) Register live-binding module globals for function declarations whose
 * name is *reassigned* somewhere in the realm (`fn = …`, `fn += …`, …).
 *
 * ES function bindings are live and mutable: a function declaration name can be
 * reassigned, and later reads must observe the new value. But a function
 * declaration is otherwise bound to an immutable Wasm func index, and the
 * assignment write-path (`emitIdentifierWriteFromLocal`) — finding the name in
 * neither `localMap`/`capturedGlobals`/`moduleGlobals` — falls through to
 * "auto-allocate a throwaway local", losing the write entirely.
 *
 * This pass (run after `collectDeclarations`, before bodies compile) statically
 * detects reassigned function-declaration names, backs each with a MUTABLE
 * `externref` module global (which the write-path then targets via `global.set`),
 * and records the name in `ctx.liveFuncBindingGlobals` so the identifier read-path
 * reads through the global (`global.get`). `__module_init` seeds each global with
 * the function's closure so a read *before* any reassignment still yields the
 * function (see `compileModuleInitBody`). Reassigning a function declaration is a
 * rare pattern, so `liveFuncBindingGlobals` is empty for virtually every program
 * and this is a no-op there.
 */
function registerReassignedFunctionGlobals(
  ctx: CodegenContext,
  sourceFiles: readonly ts.SourceFile[],
  runtimeEvalPlan: IrRuntimeEvalBoundaryPlan,
): void {
  const reassigned = new Set<string>();
  const runtimeEvalConsumer = (ctx.standalone || ctx.wasi) && runtimeEvalPlan.sharedRealmMayContainCanonicalValues;
  const dynamicSourceFragments = runtimeEvalPlan.dynamicSourceFragments;
  const hasUnknownDynamicSource = runtimeEvalPlan.unknownDynamicSource;
  const scan = (node: ts.Node): void => {
    // Simple / compound assignment (`fn = …`, `fn += …`, …) whose LHS is a
    // bare identifier resolving to a function declaration.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      let sym: ts.Symbol | undefined;
      try {
        sym = ctx.checker.getSymbolAtLocation(node.left);
      } catch {
        sym = undefined;
      }
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (decl && ts.isFunctionDeclaration(decl) && decl.name) {
        reassigned.add(decl.name.text);
      }
    }
    ts.forEachChild(node, scan);
  };
  for (const sf of sourceFiles) scan(sf);
  if (runtimeEvalConsumer) {
    ctx.runtimeEvalGlobalFunctionBindings = true;
    // A script `var` is a mutable JS binding, so runtime eval may replace its
    // current value with a value whose representation differs from the
    // initializer inferred by the AOT compiler (most notably an interpreted
    // function). Keep eval-visible var storage representation-neutral. The
    // declaration collector has allocated these globals, but no user body or
    // module initializer has been compiled yet, so widening here becomes the
    // authoritative type seen by every later read and write.
    const evalVisibleGlobals = new Set<string>([
      ...(ctx.globalObjectVarBindings ?? []),
      ...(ctx.globalLexicalBindings ?? []),
    ]);
    for (const name of evalVisibleGlobals) {
      const globalIdx = ctx.moduleGlobals.get(name);
      if (globalIdx === undefined) continue;
      const global = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      if (!global || global.type.kind === "externref") continue;
      global.type = { kind: "externref" };
      global.init = [{ op: "ref.null.extern" }];
    }
    const mentionedByDynamicSource = (name: string): boolean =>
      dynamicSourceFragments.some((fragment) => {
        let from = 0;
        while (from <= fragment.length) {
          const at = fragment.indexOf(name, from);
          if (at < 0) return false;
          const before = at === 0 ? "" : fragment[at - 1]!;
          const afterAt = at + name.length;
          const after = afterAt >= fragment.length ? "" : fragment[afterAt]!;
          const ident = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
          if (!ident(before) && !ident(after)) return true;
          from = at + name.length;
        }
        return false;
      });
    for (const name of ctx.topLevelFunctionNames) {
      const declaration = ctx.topLevelFunctionDeclarations.get(name);
      const canBeReboundByEval = !ctx.sourceIsModule || !declaration || !hasExportModifier(declaration);
      if (canBeReboundByEval && (hasUnknownDynamicSource || mentionedByDynamicSource(name))) {
        reassigned.add(name);
      }
    }
  }
  if (reassigned.size === 0) return;

  const set = (ctx.liveFuncBindingGlobals ??= new Set<string>());
  for (const name of reassigned) {
    const funcIdx = ctx.funcMap.get(name);
    // Only defined user functions (not host imports) have an in-module body.
    if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) continue;
    if (ctx.moduleGlobals.has(name)) continue; // already a global — nothing to do
    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__mod_${name}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.moduleGlobals.set(name, globalIdx);
    set.add(name);
  }
}

/**
 * (#2930) Register import-binding local-name aliases.
 *
 * Codegen keys `funcMap` / `closureMap` / `moduleGlobals` (and the per-name call
 * metadata) by the imported symbol's *declaration name*, never by the local
 * import binding. So an import whose LOCAL name differs from the target's
 * declaration name — a default import (`import val from './m'` where `./m`
 * declares `function fn`), a renamed named import (`import { add as plus }`), an
 * anonymous `export default function () {}`, or `export { g as default }` — left
 * the local binding (`val` / `plus`) unresolved: every read/call of it fell
 * through to the graceful-null default (returned 0 / null / a wrong closure).
 *
 * This pass runs AFTER `collectDeclarations` (targets are registered) and BEFORE
 * function bodies compile (which reference the local names). For each import
 * binding it follows the checker alias to the target declaration's name and
 * copies the resolution entries onto the local name. Purely additive: it writes
 * ONLY local-name keys that are currently absent, so every already-resolving
 * name stays byte-identical.
 */
function registerImportBindingAliases(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): void {
  const aliasOneBinding = (localId: ts.Identifier): void => {
    const localName = localId.text;
    // Already resolvable under the local name (e.g. `import { add }` where the
    // local name equals the export) — nothing to alias.
    const existingLocalFunc = ctx.funcMap.get(localName);
    if (
      ctx.moduleGlobals.has(localName) ||
      ctx.closureMap.has(localName) ||
      (existingLocalFunc !== undefined && !isImportFuncIdx(ctx, existingLocalFunc))
    ) {
      return;
    }
    let sym: ts.Symbol | undefined;
    try {
      sym = ctx.checker.getSymbolAtLocation(localId);
    } catch {
      return;
    }
    if (!sym) return;
    let target: ts.Symbol | undefined = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        target = ctx.checker.getAliasedSymbol(sym);
      } catch {
        return;
      }
    }
    if (!target) return;
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (!decl) return;
    // The name the target was registered under in funcMap/moduleGlobals/closureMap.
    let targetName: string | undefined;
    const declName = (decl as { name?: ts.Node }).name;
    if (declName && ts.isIdentifier(declName)) {
      targetName = declName.text;
    } else if (
      (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) &&
      ts.canHaveModifiers(decl) &&
      ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      // Anonymous `export default function () {}` / `export default class {}`
      // is registered under the synthetic name "default".
      targetName = "default";
    }
    if (!targetName || targetName === localName) return;
    // Imported class bindings need the same canonical class identity as the
    // exporting module.  `classExprNameMap` normally aliases a variable-bound
    // class expression (for example `D = class {}`) to its synthetic class
    // name, but the map was only keyed by the export-side spelling.  A named
    // import such as `import { Marked } from "marked"` therefore fell through
    // the identifier value path and materialized as null even though `new
    // Marked()` could still be resolved statically.  Preserve the class
    // singleton across that module-binding alias.
    const targetClassName = ctx.classExprNameMap.get(targetName) ?? targetName;
    if (ctx.classSet.has(targetClassName)) {
      ctx.classExprNameMap.set(localName, targetClassName);
    }
    // Copy each resolution entry keyed by the target name onto the local name.
    // Every write is guarded so a genuine same-named binding is never clobbered.
    const fnIdx = ctx.funcMap.get(targetName);
    if (fnIdx !== undefined && !ctx.funcMap.has(localName)) ctx.funcMap.set(localName, fnIdx);
    const closure = ctx.closureMap.get(targetName);
    if (closure !== undefined && !ctx.closureMap.has(localName)) ctx.closureMap.set(localName, closure);
    const modGlobal = ctx.moduleGlobals.get(targetName);
    if (modGlobal !== undefined && !ctx.moduleGlobals.has(localName)) ctx.moduleGlobals.set(localName, modGlobal);
    const optParams = ctx.funcOptionalParams.get(targetName);
    if (optParams !== undefined && !ctx.funcOptionalParams.has(localName)) {
      ctx.funcOptionalParams.set(localName, optParams);
    }
    const nested = ctx.nestedFuncCaptures.get(targetName);
    if (nested !== undefined && !ctx.nestedFuncCaptures.has(localName)) ctx.nestedFuncCaptures.set(localName, nested);
    // (#2931) If the target is a reassigned function backed by a live-binding
    // global, propagate membership so the aliased local name reads through the
    // (copied) module global too.
    if (ctx.liveFuncBindingGlobals?.has(targetName)) ctx.liveFuncBindingGlobals.add(localName);
  };

  for (const sf of sourceFiles) {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      // Default import: `import val from './m'`.
      if (clause.name) aliasOneBinding(clause.name);
      // Named imports: `import { a, b as c } from './m'`.
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) aliasOneBinding(el.name);
      }
      // Namespace import (`import * as ns`) resolves to a module object, not a
      // single function/global binding — nothing to alias here.
    }
  }
}

/**
 * Compile multiple typed source files into a single WasmModule IR.
 * All source files share the same codegen context (funcMap, structMap, etc.).
 * Only functions exported from the entry file become Wasm exports.
 */
export function generateMultiModule(multiAst: MultiTypedAST, options?: CodegenOptions): GeneratedCodegenModule {
  const mod = createEmptyModule();
  const irPlanningIdentityContext =
    options?.experimentalIR || options?.trackIrOutcomes
      ? buildIrPlanningIdentityContext(
          buildIrUnitInventory(multiAst.sourceFiles, {
            entrySource: multiAst.entryFile,
            checker: multiAst.checker,
          }),
        )
      : undefined;
  const programAbiSession = irPlanningIdentityContext
    ? new ProgramAbiSession(irPlanningIdentityContext.inventory, mod)
    : undefined;
  const ctx = createCodegenContext(mod, multiAst.checker, options, programAbiSession, irPlanningIdentityContext);
  ctx.irBodyRouteAuditSession?.registerGenerator("multi", "generateMultiModule");
  const standaloneCalendar = planMultiCalendar(ctx, multiAst.checker, multiAst.sourceFiles, multiAst.entryFile);
  ctx.runtimeEvalBoundaryPlan = buildIrRuntimeEvalBoundaryPlan(multiAst.sourceFiles, ctx.oracle);
  if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalBoundaryPlan.callableBoundaryRequired) {
    ctx.runtimeEvalCallableBoundaryEnabled = true;
  }
  // Multi-file compilation is linked through import/export module records.
  ctx.sourceIsModule = true;
  // (#4223) Same demand gate as the single-source path — any source file that
  // reads a `constructor` property arms the wrapper carriers.
  ctx.wrapperCtorCarrierDemanded =
    ctx.standalone === true && multiAst.sourceFiles.some((sf) => moduleReadsConstructorProp(sf));
  // (#4232) Narrower gate for the ordinary-object arm alone.
  ctx.plainCtorCarrierDemanded =
    ctx.wrapperCtorCarrierDemanded && multiAst.sourceFiles.some((sf) => moduleMentionsObjectIdentifier(sf));
  // (#4235) Run the fnctor pipeline HERE — the same point in the pass that
  // `generateModule` runs it, but over the whole module graph.
  //
  // Until this landed `generateMultiModule` never assigned `ctx.fnctorEscapeGate`
  // at all, so on every `compileProject` / `compileMulti` the escape gate, the
  // presence-bit/hot-cold split (#4211/#4217) and the per-type layout analysis
  // and emission (#3927) were ALL inert — silently. Not a fallback, not a
  // warning: the compile succeeded with the unsplit representation, and the
  // resulting zero was indistinguishable from "this package has no fnctors".
  // With the layout emission defaulting ON (2026-08-08) that became a lying
  // default — the flag reported enabled while the machinery never ran, on the
  // path most of the npm-compat corpus actually compiles through.
  //
  // The analysis takes the graph's source files, so its closed-world passes
  // (write-once admission, allocation-site layout labelling) are closed over the
  // WHOLE program rather than one file of it; see `analyzeFnctorEscapeGate` for
  // why each pass is monotone-safe under that widening, and for the two hazards
  // it handles explicitly (import-alias symbol identity, and cross-module
  // fnctor NAME collisions, which are refused and COUNTED).
  ctx.fnctorEscapeGate = analyzeFnctorEscapeGate(multiAst.checker, multiAst.sourceFiles, ctx.standalone, "multi");
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, multiAst.entryFile);
    }
    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Phase 1: Collect extern declarations first (needed before import collectors)
    profilePhase("extern-decls", () => {
      for (const sf of multiAst.sourceFiles) {
        collectExternDeclarations(ctx, sf);
      }
      // `analyzeMultiSource` keeps the import-scoped Node emulation surface
      // (`__js2wasm_node_env.d.ts`) in the TypeScript Program but deliberately
      // omits it from `multiAst.sourceFiles` so it is not emitted as user code.
      // It still carries the typed Node class stubs used by host heritage (for
      // example `events.EventEmitter`), so collect its declarations before
      // class discovery just like the single-file preprocessor does.
      const nodeEnvDts = multiAst.program
        .getSourceFiles()
        .find((sf) => sf.fileName.endsWith("__js2wasm_node_env.d.ts"));
      if (nodeEnvDts) collectExternDeclarations(ctx, nodeEnvDts);
    });

    // Multi-source projects can import every class declaration from package
    // files rather than the entry module. Register the host class/prototype
    // bridges from the whole graph before declarations and bodies are emitted,
    // matching the single-source path and keeping function indices stable.
    if (multiAst.sourceFiles.some((sf) => sourceContainsClass(sf)) && !(ctx.standalone || ctx.wasi)) {
      const regProtoTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_prototype", { kind: "func", typeIdx: regProtoTypeIdx });
      const regClassTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_class_object", { kind: "func", typeIdx: regClassTypeIdx });
      const regStaticMethodTypeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      addImport(ctx, "env", "__register_class_static_method", {
        kind: "func",
        typeIdx: regStaticMethodTypeIdx,
      });
    }

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      for (const sf of multiAst.sourceFiles) {
        checkWasiDomUsage(ctx, sf);
        rejectTimersUnderWasi(ctx, sf);
      }
    }

    // Scan lib files for DOM extern classes + globals (only if any user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    const anyUsesDom = profilePhase("lib-globals-probe", () =>
      multiAst.sourceFiles.some((sf) => sourceUsesLibGlobals(sf)),
    );
    if (anyUsesDom) {
      profilePhase("lib-globals-scan", () => {
        // #2520 — gate the lib-file referenced-names filter to wasi/standalone
        // only; under the default gc target it reorders the import/type table and
        // exposed a latent late-import index-shift (#1787 −6). See the matching
        // comment in generateModule above.
        const libRefs =
          ctx.wasi || ctx.standalone ? collectReferencedGlobalNames(multiAst.sourceFiles, ctx.checker) : undefined;
        // (#4218) Same syntactic lib-walk as generateModule above.
        const libSfs = multiAst.program.getSourceFiles().filter((libSf) => {
          const baseName = libSf.fileName.split("/").pop() ?? libSf.fileName;
          return baseName.startsWith("lib.") && baseName.endsWith(".d.ts");
        });
        const libIndex = process.env.JS2WASM_LIB_SCAN === "checker" ? undefined : buildLibDeclIndex(libSfs);
        for (const libSf of libSfs) {
          collectExternDeclarations(ctx, libSf, libRefs, libIndex);
          for (const sf of multiAst.sourceFiles) {
            if (sourceUsesLibGlobals(sf)) {
              collectDeclaredGlobals(ctx, libSf, sf, libIndex);
            }
          }
        }
      });
    }

    registerBuiltinExternClasses(ctx);
    if (options?.nodeBuiltins?.length) registerNodeBuiltinImports(ctx, options.nodeBuiltins);

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    profilePhase("object-widening", () => {
      for (const sf of multiAst.sourceFiles) {
        collectObjectLiteralAssignedPropertyNames(ctx, sf);
        collectEmptyObjectWidening(ctx, multiAst.checker, sf);
        // (#2837) see single-file path above.
        collectGrowableObjectLiterals(ctx, multiAst.checker, sf);
      }
    });

    // Single-pass collection of all source imports for each file (#592)
    profilePhase("import-collect", () => {
      for (const sf of multiAst.sourceFiles) {
        collectUsedExternImports(ctx, sf);
        collectAllSourceImports(ctx, sf);
      }
    });

    // #1677 — reconcile native-string helper indices before emitting deferred
    // helpers that look them up (see single-module path).
    reconcileNativeStrFinalizeShift(ctx);

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered.
    emitToUint32Helper(ctx);

    // (#1483) Emit deferred WASI helper functions for the same reason.
    emitDeferredWasiHelpers(ctx);

    // (#3496) Mirror the single-source pre-body step for standalone console
    // output. The FYI harness defines `print` in the entry source and reaches
    // it through `$DONE`; compileMulti's collector correctly marks the console
    // use, but without minting the sink before bodies compile, `console.log`
    // deliberately lowers to a no-op and the runner cannot observe the async
    // completion marker. The helper remains host-free and is only emitted when
    // a source actually uses a console method.
    if (ctx.usesStandaloneConsoleSink) {
      ensureStandaloneStdoutSink(ctx);
    }
    emitStandaloneDomStringBoundary(ctx);

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1121: Numeric return-type inference (must run BEFORE collectDeclarations
    // so the inferred f64 return is baked into the function signature).
    profilePhase("numeric-return-inference", () => {
      const merged = new Map<string, ValType>();
      for (const sf of multiAst.sourceFiles) {
        const partial = inferNumericReturnTypes(ctx, sf);
        for (const [k, v] of partial) merged.set(k, v);
      }
      ctx.numericReturnTypes = merged;
    });
    ctx.booleanPropertyNames = profilePhase("boolean-property-analysis", () =>
      analyzeBooleanPropertyNames(ctx, multiAst.sourceFiles),
    );
    // (#3765 multi-source parity) The standalone single-source path installs
    // the definition-site numeric-local oracle before declarations are minted,
    // but linked `compileMulti` graphs never did. That left JS-package locals
    // boxed even when every definition in the closed graph is provably numeric
    // (for example string lengths and `indexOf` results forwarded through an
    // imported parser). Run the same whole-program analysis over the complete
    // linked source population and consume only its symbol-scoped local verdict;
    // field-shape promotion remains owned by the existing single-source path.
    let linkedNumericHost: NumericPropertyAnalysisHost | undefined;
    let linkedPriorNumericFunctions: ReadonlySet<string> | undefined;
    if (ctx.standalone && process.env.JS2WASM_NUMERIC_LOCALS !== "0") {
      linkedNumericHost = { oracle: ctx.oracle, excludeNames: ctx.booleanPropertyNames };
      const localVerdicts = profilePhase("numeric-local-analysis", () =>
        analyzeNumericPropertyNames(linkedNumericHost!, multiAst.sourceFiles),
      );
      ctx.usageInference.setNumericLocalOracle(localVerdicts.isNumericLocal);
      ctx.numericLocalVerdict = localVerdicts.isNumericLocal;
      ctx.stringLocalVerdict = localVerdicts.isStringLocal;
      linkedPriorNumericFunctions = localVerdicts.numericFunctions;
    }
    // (#4121) Same install as the single-source lane — after the numeric-local
    // verdict the widening predicate reads, before any body compiles.
    ctx.usageInference.setWidenedCarrierOracle(widenedCarrierOracleFor(ctx));
    ctx.bindingAwareNumericReturnTypes = profilePhase("binding-aware-numeric-return-inference", () =>
      inferBindingAwareNumericReturnTypes(ctx, multiAst.sourceFiles),
    );
    profilePhase("numeric-local-call-return-refinement", () =>
      applyCallReturnRefinement(ctx, linkedNumericHost, multiAst.sourceFiles, linkedPriorNumericFunctions),
    );
    // #1677 — final reconcile before any user function is registered.
    reconcileNativeStrFinalizeShift(ctx);

    // #1719 S1 — whole-realm: OR across all source files so an override in any
    // module trips the ITER_OVERRIDDEN brand. Must run BEFORE collectDeclarations
    // (the module-init filter / #1719 CPR write-arm reads the brand to keep the
    // override statement in __module_init).
    profilePhase("global-environment-scan", () => {
      for (const sf of multiAst.sourceFiles) {
        if (sourceOverridesArrayIterator(sf)) {
          ctx.arrayIteratorMaybeOverridden = true;
        }
        recordSourceGlobalEnvironment(ctx, sf);
      }
    });

    // Phase 2: Collect all declarations — only entry file gets Wasm exports
    // (#2023) Whole-realm new.target detection — OR across all source files.
    profilePhase("new-target-scan", () => {
      for (const sf of multiAst.sourceFiles) {
        scanForNewTarget(ctx, sf);
      }
    });

    // (#802) Whole-realm proto-mutation receiver detection — OR across all
    // source files (marked roots must be known before class collection).
    profilePhase("dynamic-proto-scan", () => {
      for (const sf of multiAst.sourceFiles) {
        scanForDynamicProto(ctx, sf);
      }
    });

    // (#2001 S1) Whole-realm array-hole detection — OR across all source files.
    profilePhase("array-hole-scan", () => {
      for (const sf of multiAst.sourceFiles) {
        scanForArrayHoles(ctx, sf);
      }
    });

    // (#4037) Multi-source parity for the #2026/#53 up-front `$ObjVecArr`
    // reservation. The single-source path reserves it whenever its source
    // declares a class; `generateMultiModule` never did, so ANY dynamic
    // `new K(...args)` anywhere in a multi-source graph hit
    // "runtime-argv needs the up-front-reserved $ObjVecArr type … which was not
    // reserved for this module" and blocked emission — three times on ESLint.
    //
    // Gated on any source declaring a class, matching the single-source gate, so
    // class-free graphs stay byte-identical. Placed before `collectDeclarations`
    // (and therefore before any body compiles) so the type index is fixed at one
    // deterministic point for every pass that reads it.
    if (multiAst.sourceFiles.some((sf) => sourceContainsClass(sf))) {
      reserveObjVecArrType(ctx);
    }

    // (#4235) Multi-source parity for the #2773 S1 up-front fnctor struct-type
    // reservation, in the same relative position the single-source path uses:
    // after the `$ObjVecArr` reservation, before `collectDeclarations` and
    // therefore before any body compiles — so `$__fnctor_<Name>`'s type index is
    // fixed at ONE deterministic point for every pass that reads it. Both calls
    // are gated on the escape gate having approved something, so a fnctor-free
    // graph reserves nothing and stays byte-identical.
    for (const sf of multiAst.sourceFiles) {
      collectDynamicObjectReturnCarrierTypes(ctx, multiAst.checker, sf);
    }
    reserveFnctorStructTypes(ctx);

    // (#4133) `ctx.funcMap` is keyed by BARE function name, so two modules that
    // each declare a top-level `function shared()` collide: registration mints a
    // distinct Wasm slot for each (verified — the emitted module really does
    // carry two `$shared` functions), but the name→index map keeps only the LAST
    // one. Every call in every module then reached that one body, and the
    // compile reported `success: true` with ZERO errors while computing the
    // wrong answer. On the resolved ESLint graph 55 names collide across 146
    // sources (`posix.js` + `windows.js` alone share ~20), and a body compiled
    // for one local frame installed against another's is also what surfaced as
    // `local index out of range` at binary emit.
    //
    // The slots already exist and bodies are compiled ONE SOURCE AT A TIME, so
    // the fix does not need the 282-set/1780-get re-key the full issue describes:
    // snapshot each source's own binding here, then re-apply it before that
    // source's bodies compile. Every `funcMap.get` site — including the ~117
    // internal-helper lookups in `object-runtime.ts` — is untouched.
    const collidingFuncNames = collectMultiIrFunctionNameCollisions(multiAst.sourceFiles);
    const ownFuncIdxBySource = new Map<ts.SourceFile, Map<string, number>>();

    profilePhase("collect-declarations", () => {
      for (const sf of multiAst.sourceFiles) {
        const isEntry = sf === multiAst.entryFile;
        collectDeclarations(ctx, sf, isEntry);
        if (collidingFuncNames.size === 0) continue;
        // Immediately after THIS source's collect pass, `funcMap` still holds
        // this source's index for every name it declares — a later source has
        // not overwritten it yet. That is the only moment the per-source binding
        // is observable without changing `collectDeclarations`.
        const own = new Map<string, number>();
        for (const stmt of sf.statements) {
          if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
          const name = stmt.name.text;
          if (!collidingFuncNames.has(name)) continue;
          const idx = ctx.funcMap.get(name);
          if (idx !== undefined) own.set(name, idx);
        }
        if (own.size > 0) ownFuncIdxBySource.set(sf, own);
      }
    });
    // #2847: make initial boolean brands visible while bodies are emitted;
    // recover again at finalize for fields discovered during body compilation.
    recoverBooleanStructFieldBrands(ctx);

    // Shape inference: detect array-like variables and override their types
    profilePhase("shape-inference", () => {
      for (const sf of multiAst.sourceFiles) {
        applyShapeInference(ctx, multiAst.checker, sf);
      }
    });

    // (#1636-S1) Eagerly register the `__current_this` module global so that
    // `ThisKeyword` resolution in free-function-closure bodies (compiled in
    // the next phase) can emit `global.get __current_this` instead of
    // falling through to `undefined`. The companion `__call_fn_method_N`
    // exports that install / restore this global are emitted later in
    // post-processing — registering the global here keeps both sides in sync.
    ensureCurrentThisGlobal(ctx);

    // (#2931) Back reassigned function-declaration names (`fn = …`) with a mutable
    // live-binding module global BEFORE aliasing, so an import of such a function
    // (#2930) copies the live global too. No-op unless a function is reassigned.
    registerReassignedFunctionGlobals(ctx, multiAst.sourceFiles, ctx.runtimeEvalBoundaryPlan!);

    // (#4182) Module-scope Annex B B.3.3.2 live bindings (see the single-source
    // site above). Runs before aliasing/bodies for the same reason as #2931.
    registerAnnexBGlobalLiveBindings(ctx, multiAst.sourceFiles);

    // (#2930) Register import-binding aliases (default / renamed / anonymous-default
    // imports whose LOCAL name differs from the imported target's declaration name)
    // so their reads and calls resolve to the target instead of the graceful-null
    // default. Runs after collectDeclarations (targets registered), before bodies.
    registerImportBindingAliases(ctx, multiAst.sourceFiles);

    standaloneCalendar.reserveDirectCallbacks(irPlanningIdentityContext);

    // (#4589) Prepare one exact standalone scalar leaf before direct bodies.
    const earlyMultiIr = planEarlyMultiIrOverlay(ctx, multiAst, irPlanningIdentityContext!, options);

    // Phase 3: Compile all function bodies.
    //
    // (#3782) compileDeclarations recompiles the one accumulated module
    // initializer for every source file. Its own two-pass reset covers one
    // invocation, but without a graph-level reset the next source starts from
    // the prior pass's END state: Acorn's first Object.defineProperty/freeze
    // operations are then compiled as redefinitions of already-frozen objects,
    // and the linked standalone start function throws even when the entry is an
    // otherwise empty module. Every pass sees the complete collected init list,
    // so restore only the compiler's order-sensitive facts before each pass;
    // keep declarations, closures, globals, and emitted bodies accumulated.
    const multiDeclarationOrderState = {
      definedPropertyFlags: new Map(ctx.definedPropertyFlags),
      // (#3872) Same order-sensitivity as `definedPropertyFlags` — see the note
      // at the declarations.ts snapshot.
      nonWritableExternKeys: new Set(ctx.nonWritableExternKeys),
      frozenVars: new Set(ctx.frozenVars),
      sealedVars: new Set(ctx.sealedVars),
      nonExtensibleVars: new Set(ctx.nonExtensibleVars),
    };
    profilePhase("bodies", () => {
      const lastIndex = multiAst.sourceFiles.length - 1;
      for (const [index, sf] of multiAst.sourceFiles.entries()) {
        ctx.definedPropertyFlags = new Map(multiDeclarationOrderState.definedPropertyFlags);
        ctx.nonWritableExternKeys = new Set(multiDeclarationOrderState.nonWritableExternKeys);
        ctx.frozenVars = new Set(multiDeclarationOrderState.frozenVars);
        ctx.sealedVars = new Set(multiDeclarationOrderState.sealedVars);
        ctx.nonExtensibleVars = new Set(multiDeclarationOrderState.nonExtensibleVars);
        // The accumulated `__module_init` is graph state, not per-source state:
        // `collectDeclarations` has already run over every source, so the
        // statement list this loop sees is complete and IDENTICAL on every
        // iteration. Compile the discovery pass once at the front, the
        // final-registry pass once at the end, and nothing in between — see
        // `ModuleInitMode`. This is what made the 146-source ESLint graph
        // quadratic in both time and retained function bodies.
        const moduleInitMode: ModuleInitMode = index === lastIndex ? "full" : index === 0 ? "discover" : "skip";
        // (#4133) Point every colliding name at THIS source's own slot for the
        // duration of its body compilation, so its calls resolve to its own
        // function instead of whichever module happened to register last.
        // Iterating in the same order as the collect loop leaves the map in the
        // same last-wins end state it had before, so exports and the finalizers
        // that run after this loop observe exactly what they observed before.
        for (const [name, idx] of ownFuncIdxBySource.get(sf) ?? []) {
          ctx.funcMap.set(name, idx);
        }
        profilePhase(sf.fileName, () =>
          compileMultiPreparedScalarLeafDeclarations(ctx, sf, earlyMultiIr.get(sf), moduleInitMode),
        );
      }
    });

    frameStage(ctx, "bodies");

    // (#1602) Rebuild method-closure trampolines against final method sigs.
    profilePhase("finalize-method-trampolines", () => finalizeMethodTrampolines(ctx));
    frameStage(ctx, "finalizeMethodTrampolines");
    profileCount("functions-after-bodies", ctx.mod.functions.length);

    // (#2138 M0) Late IR overlay for multi-module top-level functions. Ordinary
    // owners have direct bodies and finalized trampolines here; #4589's one
    // exact standalone scalar singleton instead carries its Prepared body and
    // correlated skip into this report. Imported calls remain an external
    // selector boundary. Class members and module init stay direct-owned; never
    // patch the shared `__module_init` once per source file.
    // Fast-mode legacy declarations use i32 for `number`, while the current IR
    // overlay uses f64. A multi-file target can be reached by a legacy caller,
    // so replacing only that target would change its live Wasm ABI. Keep the
    // whole multi-file overlay pre-claim disabled until those numeric boundary
    // representations are planned mode-aware.
    if (options?.experimentalIR && !ctx.fast) {
      const hostImportedFunctions =
        ctx.standalone || ctx.wasi || ctx.strictNoHostImports
          ? undefined
          : irOverlayIdentity.makeIrOverlayImportedResolver(multiAst.checker, irPlanningIdentityContext!);
      const safety = buildMultiIrGraphSafety(ctx, multiAst.sourceFiles, multiAst.checker);
      profilePhase("ir-overlay", () => {
        for (const sourceFile of multiAst.sourceFiles) {
          profilePhase(sourceFile.fileName, () =>
            compileMultiIrOverlaySource(
              ctx,
              multiAst,
              sourceFile,
              irPlanningIdentityContext!,
              safety,
              hostImportedFunctions,
              earlyMultiIr.get(sourceFile),
            ),
          );
        }
      });
      // A+B1 may create callback singleton trampolines after the legacy
      // finalization pass. Rebuild those late declarations against the target's
      // final signature before any fixup/validation pass observes them.
      finalizeMethodTrampolines(ctx);
      frameStage(ctx, "ir-overlay");
    }

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    profilePhase("fixup-struct-new-args", () => fixupStructNewArgCounts(ctx));
    frameStage(ctx, "fixupStructNewArgCounts");

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    profilePhase("fixup-struct-new-coercion", () => fixupStructNewResultCoercion(ctx));
    frameStage(ctx, "fixupStructNewResultCoercion");

    // Build per-shape default property flags table for all user-visible structs
    profilePhase("shape-prop-flags", () => buildShapePropFlagsTable(ctx));
    frameStage(ctx, "buildShapePropFlagsTable");

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    profilePhase("declared-func-refs", () => collectDeclaredFuncRefs(ctx));
    frameStage(ctx, "collectDeclaredFuncRefs");

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;
    // (#1700/#4399) Surface per-export boundary classifications so wrapExports
    // can marshal typed arrays and native strings across the JS↔Wasm edge.
    if (ctx.exportSignatures.size > 0) {
      const obj: Record<string, import("../ir/types.js").ExportSignature> = {};
      for (const [k, v] of ctx.exportSignatures) obj[k] = v;
      mod.exportSignatures = obj;
    }

    // (#2847) Whole-program conservative branding for multi-source modules.
    recoverBooleanStructFieldBrands(ctx);

    // Mirror single-source exact shape provenance before any closed-struct
    // runtime finalizer consumes the complete multi-source type table.
    resolveAndRecordShapeStamping(ctx);

    // (#2831) Reserve the host-externref → wasm-vec materializers before the
    // `__sset_*` setters and deferred member dispatchers bake their value
    // coercions (mirrors the generateModule path).
    reserveVecFieldMaterializers(ctx);
    reserveColdTailAllocators(ctx); // (#3927) mirrors the generateModule path
    reserveFnctorResidAllocators(ctx); // (#3927) per-type layouts — mirrors the generateModule path

    // Emit exported struct field getter helpers for the runtime (mirrors
    // generateModule path — #1308 surfaced that multi-source projects
    // were missing these export emits).
    emitStructFieldGetters(ctx);
    emitStructFieldBooleanMarkers(ctx);
    emitStructFieldPresenceGetters(ctx);
    emitStructFieldSetters(ctx);

    // (#2660 M3) Same ordering as the single-source pipeline.
    fillClosurePrototypeEdge(ctx);

    // (#3468) Multi-source compilation can reserve the closure own-property
    // side-table helpers too. Fill their placeholders only after every source
    // has registered its closure types, matching the single-source pipeline.
    fillClosurePropHelpers(ctx);

    // (#3537) Same for the array-expando side table.
    fillVecPropHelpers(ctx);

    // (#3496) A multi-source entry can reserve a closed method dispatcher just
    // like a single source can. The literal Test262 harness does so for
    // `assert.compareArray(...)`: the property assignment registers a closure
    // candidate and the later call reserves `__call_m_compareArray_2`.
    // Finalize those placeholders only after every source has contributed its
    // object shapes and closure methods, matching the single-source pipeline.
    // The fill is read-only over the function map because its dependencies are
    // registered when the dispatcher is reserved.
    fillClosedMethodDispatch(ctx);

    // (#3683 S3) Fill the reserved `__dc_<F>_<m>_<n>` direct-call trampolines
    // now that every typed twin exists. Runs AFTER the closed-method fill
    // because a trampoline whose twin did not materialize degrades to that
    // dispatcher. Read-only over funcMap.
    fillDirectCallTrampolines(ctx);

    // (#3493) compileMulti shares the same property-access lowering as the
    // single-source path, so a dynamic property write/read can reserve one of
    // these deferred dispatchers here too. Leaving its placeholder body as
    // `unreachable` made an otherwise-valid top-level `globalThis.x = value`
    // trap as soon as #3493 stopped eliding that statement. Fill both sides
    // after every source file has registered its struct types, exactly as the
    // single-source finalizer does. Their dependencies were registered by the
    // reserve phase, so these fills do not mutate function indices.
    fillMemberSetDispatch(ctx);
    fillMemberGetDispatch(ctx);
    fillTypedMemberGetF64Dispatch(ctx); // (#3673) typed f64 twins
    fillTypedMemberSetF64Dispatch(ctx); // (#4157 A) the WRITE-side f64 twins
    inlineMemberGetCallSites(ctx); // (#4157) call-site inline cache, default ON
    inlineIsTruthyCallSites(ctx); // (#4157) ToBoolean call-site fast path, default ON
    fuseBoxBooleanSinks(ctx); // (#4157) unboxed boolean fusion — AFTER the truthy IC, default OFF
    fillFusedToNumber(ctx); // (#4157) fused __to_number — no-op unless reserved

    // Mirror the single-source closed-struct own-property finalizer.
    fillErrorPropHelpers(ctx); // (#4098) multi-source parity for the shared Error bag ABI
    fillInstanceTombstones(ctx); // (#4098 G1 s1) BEFORE the ladders below: they bake its call
    fillInstanceProps(ctx); // (#4194) instance expando carrier + bag get/set + tombstone resurrect
    fillClosedStructHasOwnArms(ctx);
    // (#4248) A builtin `.prototype` is a `$NativeProto`, not a `$Object`, so
    // its OWN members are invisible to the table walk. AFTER the closed-struct
    // prologue so the two arms compose in receiver-shape order.
    unshiftNativeProtoHasOwnArms(ctx);
    // (#4248) §15.5.4/§15.6.4/§15.7.4 — the three wrapper prototypes ARE
    // wrapper objects, so ToPrimitive must answer their [[PrimitiveValue]].
    unshiftNativeProtoToPrimitiveArm(ctx);
    fillClosedStructOwnPropertyNamesArms(ctx);
    fillClosedStructEnumerationArms(ctx); // (#3920) Object.keys / for…in
    fillClosedStructExternGetArms(ctx);
    // (#4194/#4232 reconciliation) Declared-field WRITE-through on `__extern_set`
    // is #4232's fill (closed-struct-extern-set.ts — presence bits, cold tail,
    // tombstone revival, single-engine coercion). The expando-bag half — writes
    // with no physical slot, bag visibility, enumeration merge — is
    // fillInstanceProps (instance-props.ts). Misses fall through from the
    // declared ladder to the bag miss-arm, so the two compose without overlap.
    fillClosedStructExternSetArms(ctx);
    fillFnctorPrototypeDispatchArms(ctx);
    // (#2875 w4-F) LAST __extern_set prologue: a runtime-keyed write to a
    // getter-only RegExp member is a sloppy no-op, not a bag entry.
    unshiftRegExpAccessorSetGuard(ctx);
    // (#2875 w4-F) `delete <Builtin>.prototype.<m>` rewrites the member CSV.
    unshiftNativeProtoDeleteArm(ctx);

    // (#3673 round 9b) LAST __extern_get body fill: prepend the per-key
    // prototype-lookup cache hit arm ahead of the ladder arms unshifted above.
    // (#4223) BEFORE the cache arm (which must stay last): answer
    // `<wrapper>.constructor` from the builtin ctor carrier.
    unshiftExternGetWrapperCtorArm(ctx);
    // (#4248) §21.1.5 — an inherited builtin-proto METHOD read off a wrapper
    // instance (or off the prototype through a binding) must yield the same
    // singleton the static `<Builtin>.prototype.<m>` read does.
    unshiftExternGetProtoMethodArm(ctx);
    unshiftExternGetProtoCacheArm(ctx);

    // (#4157) Inline `__extern_get`'s cache-hit arm at static-name call sites.
    // MUST run HERE: `unshiftExternGetProtoCacheArm` above is the last pass that
    // prepends to `__extern_get`, and the extractor accepts the body only while
    // that arm is still the PREFIX — which is also the property the arm's own
    // soundness rests on. Later fills (`fillDynamicForinVecArms`, the
    // `ta-dyn-mop` arm) unshift in front of it, so running after them makes the
    // extraction fail and the pass decline wholesale. DEFAULT ON since the flip.
    inlineExternGetCallSites(ctx);

    // (#4157) Inline the member-WRITE dispatchers' first arm at the call
    // sites — multi-source parity with the generateModule call above (same
    // after-the-set-fills, before-any-index-remap ordering). DEFAULT OFF.
    inlineMemberSetCallSites(ctx);
    // (#4157) `__call_m_*` devirtualization — same finalize point as the
    // single-source pipeline above (after all dispatcher fills, before
    // dead-elim / census). DEFAULT OFF.
    inlineCallDispatchSites(ctx);
    inlineFlatStrCallSites(ctx); // (#4157) flatten/equals site fast paths — rationale in flat-str-ic.ts
    fillRuntimeEvalCallablePropertyGetArm(ctx);

    // (#3495) `__extern_get_idx` is reserved while compiling standalone
    // numeric reads through an externref (for example `globalThis.logs[i]`).
    // Its eager body only knows `$Object`/`$ObjVec`; splice the per-element-kind
    // compiler-vec arms after every source has registered its array carriers,
    // exactly as the single-source finalizer does. Without this multi-source
    // fill, the backing vec contains the right values but every indexed read
    // silently returns the undefined sentinel.
    fillExternGetIdxVecArms(ctx);
    // (#3666/#3251) Multi-source parity after every carrier/dynamic reader is complete.
    fillObjVecReflectionHelpers(ctx);
    // (#4098) Multi-source parity: the helper bodies were filled above; now
    // splice the native Error reader after the other dynamic-reader fills.
    fillExternGetErrorProps(ctx);
    // (#3371) Reflect.construct reserves the same host-free constructor
    // classifier and native-view prototype overrides in project compilation as
    // in the single-source pipeline. Keep native views after generic vec fills
    // so they retain front precedence.
    fillTaDynViewMopArms(ctx);
    fillDataViewConstructProtoArm(ctx);
    fillReflectIsConstructor(ctx);
    // (#4160) Prototype-index store — multi-source parity with the
    // generateModule call above (same after-the-shape-probing-fills ordering;
    // see the single-source comment). No-op unless reserved.
    fillProtoIndexStore(ctx);
    fillHoleyArrayHasIdxArm(ctx);
    // Emit __vec_get / __vec_len exports for runtime iterator fallback.
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports for DataView host runtime.
    emitDataViewByteExports(ctx);

    // (#3058) Resizable-ArrayBuffer helper exports (mirrors generateModule path).
    emitResizableAbExports(ctx);

    // Emit __test_str_from_externref / __test_str_to_externref helpers
    // (no-op unless ctx.testRuntime && ctx.nativeStrings).
    emitTestRuntimeStringHelpers(ctx);

    // Emit __call_@@iterator export for runtime Symbol.iterator dispatch.
    emitIteratorMethodExport(ctx);

    // Emit __call_fn_0 export for calling zero-arg closures from JS (#851, #1308).
    emitClosureCallExport(ctx);

    // Emit __call_fn_1 export for calling one-arg closures from JS (#1090, #1308).
    emitClosureCallExport1(ctx);

    // Multi-source projects can pass entry-module closures into an imported
    // function whose dynamic call is compiled before that closure wrapper is
    // known. The host fallback needs matching dispatchers or wider closures return null.
    emitClosureCallExport2(ctx);
    emitClosureCallExport3(ctx);
    emitClosureCallExport4(ctx);
    emitDateHostBridge(ctx);

    // Mirror the single-source receiver bridge over the complete multi-source
    // closure registry. Include native-construction demand in the cap so its
    // deferred drivers and ordinary host method calls share one dispatcher set.
    {
      let maxClosureArity = 5;
      for (const info of ctx.closureInfoByTypeIdx.values()) {
        if (info.paramTypes.length > maxClosureArity) maxClosureArity = info.paramTypes.length;
      }
      maxClosureArity = maxHostFnctorMethodArity(ctx, maxClosureArity);
      maxClosureArity = Math.max(maxClosureArity, maxReservedNativeConstructArity(ctx));
      const cap = Math.min(maxClosureArity, 8);
      for (let n = 0; n <= cap; n++) emitClosureMethodCallExportN(ctx, n);
    }
    // (#4098) Error sidecar accessors reserve receiver-aware drivers while the
    // MOP is built. Refill them only after multi-source method dispatchers exist.
    fillAccessorDrivers(ctx);

    // Unknown-arity host wrappers use this classifier to choose a dispatcher
    // wide enough for the closure's declared parameters.
    emitClosureArityExport(ctx);

    // Fill multi-source constructor method drivers after all closure tables.
    fillHostFnctorMethodDrivers(ctx);

    // Fill apply only after every multi-source arity dispatcher exists.
    fillApplyClosure(ctx);

    // #1504: emit __is_closure for wrapExports discrimination.
    emitIsClosureExport(ctx);

    // #2742: accessor-returned rest-closure discriminator (see primary path).
    emitClosureHasRestExport(ctx);

    // #2794: POSITIVE data-vs-closure discriminator (see generateModule path).
    emitIsDataStructExport(ctx);

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (edits helper bodies in place — no funcIdx churn).
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch.
    emitToPrimitiveMethodExports(ctx);

    // (#2358 #10 / #2638) Fill the reserved `__array_to_primitive_string` /
    // `__class_to_primitive` driver bodies now that `__extern_length` /
    // `__extern_get_idx` (filled by fillExternGetIdxVecArms above) and the
    // `__call_valueOf`/`__call_toString` dispatchers (emitToPrimitiveMethodExports
    // just above) are registered. Mirrors the single-module `generateModule`
    // pipeline, which called these two fills but this multi-file path never
    // did — every standalone multi-file compile reaching `__to_primitive`'s
    // array/class arms (e.g. `TypedArray.prototype.set(arr, offset)` where
    // `offset` needs ToNumber on a plain object or array) left both driver
    // placeholders as their bare `unreachable` stub, so a would-be-catchable
    // coercion crashed the whole module with an uncatchable Wasm trap instead
    // of the value it should have produced. No-op when neither driver was
    // reserved (`ctx.arrayToPrimitiveReserved`/`ctx.classToPrimitiveReserved`
    // unset) — byte-identical for modules that never reach `__to_primitive`'s
    // array/class-instance arms.
    fillArrayToPrimitive(ctx);
    fillClassToPrimitive(ctx);

    // (#3981) Same class of multi-file gap as the two fills immediately above.
    // This path emits only `__call_fn_0`/`__call_fn_1`, never the
    // `__call_fn_method_<N>` receiver dispatchers the single-module path emits
    // at 0..5 — so a standalone `new <function value>()` reserved its
    // `__native_construct_<N>` driver and then had nothing to fill it with,
    // leaving the bare `unreachable` stub. That is a strictly worse outcome
    // than the null it replaced: an uncatchable Wasm trap. Emit the dispatchers
    // ONLY up to the arity a construct driver actually reserved, so a
    // multi-file module without such a site stays byte-identical.
    fillNativeConstructDrivers(ctx);
    fillConstructBoundDriver(ctx); // (#4196) same stub hazard; degrades to null
    fillRuntimeEvalConstructDriver(ctx); // (#4438) same stub hazard; degrades to null
    // Native Proxy trap drivers use the same finalize-only closure bridge in
    // project compilation as in the single-source pipeline.
    fillProxyDispatch(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

    // (#2962) Emit __exn_render_prepare / __exn_render_char so the test262
    // harness can render a natively-thrown GC payload ("TypeError: boom")
    // with zero host imports. No-op unless (standalone || wasi) &&
    // nativeStrings && the `$exc` tag was registered (i.e. the module can
    // actually throw).
    emitExceptionRenderExports(ctx);

    // (#3469) Emit __stdout_prepare / __stdout_char so the runner can read the
    // standalone host-free `console.log`/`print` output (the test262 async
    // completion marker) with zero host imports. No-op unless the standalone
    // stdout sink was minted (ctx.stdoutAccGlobalIdx >= 0).
    emitStdoutSinkExports(ctx);

    // #1326c Phase 1C-A — export __drain_microtasks BEFORE WASI _start so the
    // _start wrapper (which appends a drain call) can find its funcIdx.
    // Idempotent + no-op when the queue was never registered.
    exportDrainMicrotasksIfRegistered(ctx);
    exportPromiseBoundaryIfRegistered(ctx);

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    // (#2580 M0) Emit the dynamic-read primitives (__dyn_has/__dyn_get) iff a
    // call site flagged the module needs them (M1+). Gated on ctx.usesDynRead,
    // which M0 never sets, so this is a no-op in M0 → byte-identical. Runs before
    // dead-elim/freeze so the helper funcIdx values are stable.
    ensureDynReadHelpers(ctx);
    // (#3053 U0) See the single-module pipeline note above. No-op unless
    // ctx.usesDynMemberGet is set (U1+); byte-identical in U0.
    ensureDynMemberGet(ctx);

    // (#2800) Allocate + wire the `__in_module_init` flag global now that every
    // import global has settled (final absolute index), patching the recorded
    // delete-aware read `global.get` placeholders and wrapping `__module_init`.
    // Runs before dead-elim (which never prunes/remaps live globals) and the
    // index freeze. No-op unless a gc/host delete-aware read recorded the flag.
    finalizeInModuleInitFlag(ctx);

    // (#4150/#4157) Same module-value caches as the single-module pipeline.
    finalizeModuleValueCaches(ctx);

    // (#2853) Nominal shape branding — same pass + placement as the
    // single-module pipeline (see generateModule): after all instruction
    // emission, before dead-type elimination.
    resolveAndRecordShapeBranding(ctx);

    finalizeLeafStructTypes(ctx);

    emitDataStructHostBridgeManifest(ctx);
    standaloneCalendar.publishDomStringBoundary();

    // (#4035) Apply the host-bridge export policy BEFORE dead elimination, so
    // the functions/types those exports pin are actually reclaimed. No-op when
    // the bridge is published (js-host default).
    finalizeStandaloneTimerCallbackExports(ctx);

    // (#4257) Re-declare `ref.func` targets that the mid-finalize scan above
    // could not see: every `__extern_get`/dispatcher body FILL runs after it.
    // Additive + before dead-elim (which remaps declaredFuncRefs).
    collectDeclaredFuncRefs(ctx, { additive: true });

    // Dead import and type elimination pass
    eliminateDeadLayoutAndPlanProgramAbi(ctx); // #1899 authoritative remap, then #3520 retained ABI

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // (#3921) Allocation census — no-op unless JS2WASM_ALLOC_CENSUS=1. Placed
    // here because dead-type elimination has already remapped every `typeIdx`,
    // so the index on each `struct.new` is the one the reader will see.
    installAllocCensus(ctx);
    installExecCensus(ctx);
    // (#4157) IR-level inliner for USER code — runs by DEFAULT since the
    // tuned-set flip; a no-op only at JS2WASM_IR_INLINE=0. This exact slot is
    // load-bearing; the four preconditions are spelled out under "Placement
    // contract" in `ir-inline.ts`. Do not move it without reading them.
    inlineUserFunctions(ctx);

    // Mirror the single-source ES5 Function `caller` finalizer.
    finalizeFunctionPoisonPillCalls(ctx);

    // #1984 — freeze the index spaces (multi-module path). Same boundary as the
    // single-module generateModule: all legitimate late import mutations have
    // run; stackBalance / fixupExternConvertAny / emit add no imports. Any
    // addImport/ensureLateImport after here throws at the producer site.
    finalizeVecHostBridgeExports(ctx);
    ctx.indexSpaceFrozen = true;
    ctx.programAbiSession?.publish(mod);

    // (#4157 park 6) Cross-hierarchy operand repair — must run BEFORE the two
    // position-guessing repairs inside stackBalance. See its own header.
    repairCrossHierarchyOperands(mod);
    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);
    // #1918 — drain fixup telemetry: per-compile debug log + optional strict mode.
    drainStackBalanceTelemetry(ctx, multiAst.entryFile.fileName);

    // Late fixup: repair extern.convert_any applied to non-anyref values.
    // Must run after stackBalance since fixCallArgTypesInBody can insert
    // duplicate/redundant extern.convert_any when walking back through
    // already-converted producers (#1400). Without this, ESLint's Config_new
    // and similar multi-arg __extern_set call sites emit 2–4 consecutive
    // extern.convert_any ops, the second of which fails validation
    // ("found extern.convert_any of type externref" — externref is NOT a
    // subtype of anyref). Mirror the single-module pipeline at line 1053.
    fixupExternConvertAny(ctx);
  } catch (e) {
    const failure = classifyIrFailure(e, "build");
    for (const sourceFile of multiAst.sourceFiles) {
      recordWholeSourceFailure(ctx, sourceFile, failure, irPlanningIdentityContext);
    }
    // (#4030) Same reasoning as the expression catch: an untyped throw reaching
    // here is a compiler bug, and a bare message costs a full instrumented
    // re-run to localise on a large graph.
    reportErrorNoNode(ctx, `Codegen error: ${describeInternalError(e)}`);
  }

  // (#2094) Emit-time backstop for the addImport gate — see generateModule.
  assertNoLeakedHostImports(ctx, mod);

  // (#4134) `JS2WASM_CHECK_FRAMES=1` reports every function whose body reads or
  // writes a local its own frame never declares, AT THE END OF CODEGEN.
  //
  // The emitter already rejects these, but only after every post-codegen pass
  // has run — fixups, peephole, dead-code elision, late-import shifting — so
  // "the emitter saw it" says nothing about who produced it. Running the same
  // check here bisects the pipeline in one step: a function reported here was
  // already inconsistent when codegen finished; one that is clean here but
  // rejected at emit was corrupted by a later pass. Inert unless set.
  if (typeof process !== "undefined" && process.env?.JS2WASM_CHECK_FRAMES) {
    reportOutOfFrameLocals(ctx, mod);
  }

  return {
    module: mod,
    errors: ctx.errors,
    fallbackCounts: ctx.fallbackCounts,
    irPostClaimErrors: ctx.irPostClaimErrors,
    irCompiledFuncs: ctx.irCompiledFuncs,
    irOutcomes: ctx.irOutcomes,
    irBodyRouteAudit: snapshotLegacyBodyAudit(ctx),
    programAbi: ctx.programAbiSession?.publication,
  };
}

/**
 * (#4134) Count bodies that reference locals outside their own frame.
 *
 * `JS2WASM_FRAME_STAGES=1` calls this after each post-body pass in
 * `generateMultiModule` so the FIRST pass that introduces a breach names itself.
 * The surviving breach class is provably not emitted by body compilation (a
 * push-trap on ordinary function bodies stays silent for it), so the introducing
 * pass has to be found by bisecting the pass list.
 */
export function countOutOfFrameLocals(mod: WasmModule): number {
  const localOps = new Set(["local.get", "local.set", "local.tee"]);
  let n = 0;
  for (const func of mod.functions) {
    const type = mod.types[func.typeIdx];
    if (!type || type.kind !== "func") continue;
    const frame = type.params.length + func.locals.length;
    let bad = false;
    const walk = (instrs: readonly Instr[]): void => {
      for (const instr of instrs) {
        if (bad) return;
        if (localOps.has(instr.op)) {
          const index = (instr as { index?: number }).index;
          if (typeof index === "number" && index >= frame) bad = true;
        }
        for (const key of ["body", "then", "else", "catchAll"] as const) {
          const nested = (instr as unknown as Record<string, unknown>)[key];
          if (Array.isArray(nested)) walk(nested as Instr[]);
        }
        const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
        if (Array.isArray(catches)) for (const c of catches) if (Array.isArray(c.body)) walk(c.body);
      }
    };
    walk(func.body);
    if (bad) n += 1;
  }
  return n;
}

let frameStagePrev = 0;

/** (#4134) Report the first pass boundary at which the breach count grows. */
function frameStage(ctx: CodegenContext, label: string): void {
  if (!process.env?.JS2WASM_FRAME_STAGES) return;
  const n = countOutOfFrameLocals(ctx.mod);
  if (n !== frameStagePrev) {
    process.stderr.write(`[js2:frame-stage] after ${label}: ${frameStagePrev} -> ${n}\n`);
    // Did the FRAME shrink, or did the BODY grow? That fork decides whether to
    // hunt a locals-array replacement or a late instruction splice.
    for (const func of ctx.mod.functions) {
      const snap = frameSnapshotAtCompile.get(func);
      if (!snap) continue;
      if (snap.locals !== func.locals.length || snap.bodyLen !== func.body.length) {
        process.stderr.write(
          `[js2:frame-stage]   '${func.name}' locals ${snap.locals}->${func.locals.length}` +
            ` bodyLen ${snap.bodyLen}->${func.body.length}\n`,
        );
      }
    }
    frameStagePrev = n;
  }
}

/** (#4134) Report bodies that reference locals outside their own frame. */
function reportOutOfFrameLocals(ctx: CodegenContext, mod: WasmModule): void {
  const localOps = new Set(["local.get", "local.set", "local.tee"]);
  let reported = 0;
  for (const [position, func] of mod.functions.entries()) {
    const type = mod.types[func.typeIdx];
    if (!type || type.kind !== "func") continue;
    const frame = type.params.length + func.locals.length;
    let worst = -1;
    const walk = (instrs: readonly Instr[]): void => {
      for (const instr of instrs) {
        if (localOps.has(instr.op)) {
          const index = (instr as { index?: number }).index;
          if (typeof index === "number" && index >= frame && index > worst) worst = index;
        }
        for (const key of ["body", "then", "else", "catchAll"] as const) {
          const nested = (instr as unknown as Record<string, unknown>)[key];
          if (Array.isArray(nested)) walk(nested as Instr[]);
        }
        const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
        if (Array.isArray(catches)) for (const c of catches) if (Array.isArray(c.body)) walk(c.body);
      }
    };
    walk(func.body);
    if (worst < 0) continue;
    reported += 1;
    process.stderr.write(
      `[js2:frames] position ${position} '${func.name}' frame=${frame} ` +
        `(${type.params.length} params + ${func.locals.length} locals) worst local index=${worst}\n`,
    );
  }
  process.stderr.write(`[js2:frames] ${reported} function(s) reference out-of-frame locals at end of codegen\n`);
}

// ── Unified single-pass import collector (#592) ─────────────────────
//
// Instead of walking the AST 19+ times with separate collect* functions,
// collectAllSourceImports performs a SINGLE recursive traversal and
// dispatches to all collector logic on every node.  The individual
// collect* functions below are preserved but no longer called from
// generateModule / generateMultiModule — they remain as reference and
// for any call sites that need them independently.

// String method signatures: name → { params (excluding self), resultKind }
export const STRING_METHODS: Record<string, { params: ValType[]; result: ValType }> = {
  toUpperCase: { params: [], result: { kind: "externref" } },
  toLowerCase: { params: [], result: { kind: "externref" } },
  trim: { params: [], result: { kind: "externref" } },
  trimStart: { params: [], result: { kind: "externref" } },
  trimEnd: { params: [], result: { kind: "externref" } },
  charAt: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  slice: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  substring: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  indexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  lastIndexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  // #2002 — second arg is the start position (includes/startsWith) or
  // endPosition (endsWith). Declared as f64 so the generic arg loop forwards
  // it to the host instead of truncating to import arity. An omitted position
  // is padded with NaN; the `string_method` host shim strips a trailing NaN
  // so the JS method applies its spec default (0 for includes/startsWith,
  // length for endsWith) rather than ToInteger(NaN)=0.
  includes: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  startsWith: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  endsWith: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  replace: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  replaceAll: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  repeat: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  padStart: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  padEnd: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  // split: separator (externref) + limit (f64, -1 sentinel for "no limit" — #3761).
  // The host runtime in `string_method` detects -1 and calls `split(sep)` without
  // the limit. An explicit NaN must remain distinct: ToUint32(NaN) is 0.
  split: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "externref" } },
  match: { params: [{ kind: "externref" }], result: { kind: "externref" } },
  search: { params: [{ kind: "externref" }], result: { kind: "f64" } },
  at: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  codePointAt: { params: [{ kind: "f64" }], result: { kind: "f64" } },
  normalize: { params: [{ kind: "externref" }], result: { kind: "externref" } },
};

// Register addStringImports so any-helpers.ts can call it via the delegate
// (breaks circular dep: index.ts → any-helpers.ts → shared.ts ← index.ts)
registerAddStringImports(addStringImports);
// #1471: lets late-imports.ts route box/unbox/typeof/is_truthy names to the
// in-module native funcs under no-JS-host mode without an import cycle.
registerAddUnionImports(addUnionImports);

/** Parse a RegExp literal text (e.g. "/\\d+/gi") into pattern and flags */
export function parseRegExpLiteral(text: string): { pattern: string; flags: string } {
  // The text includes the leading '/' and trailing '/flags'.
  // Find the last '/' which separates pattern from flags.
  const lastSlash = text.lastIndexOf("/");
  const pattern = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  return { pattern, flags };
}

/** Math methods that need host imports (no native Wasm opcode) */
export const MATH_HOST_METHODS_1ARG = new Set([
  "exp",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "acosh",
  "asinh",
  "atanh",
  "cbrt",
  "expm1",
  "log1p",
]);
export const MATH_HOST_METHODS_2ARG = new Set(["pow", "atan2"]);

/**
 * Emit the __toUint32 Wasm helper function. Must be called AFTER all imports
 * that are added directly via addImport (bypassing ensureLateImport's shift
 * mechanism) have been registered, and BEFORE any user function body that
 * calls Math.clz32 or Math.imul is compiled. Emitting earlier leaves a stale
 * funcMap entry because addImport does not shift defined-function indices.
 *
 * Implements ES §7.1.7: NaN/±Infinity → 0, otherwise trunc(x) modulo 2^32.
 */
export function emitToUint32Helper(ctx: CodegenContext): void {
  if (!ctx.needsToUint32) return;
  if (ctx.funcMap.has("__toUint32")) return;
  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__toUint32", funcIdx);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 0 },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "f64.abs" },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "i64.trunc_sat_f64_s" },
    { op: "i32.wrap_i64" },
  ];
  ctx.mod.functions.push({
    name: "__toUint32",
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/** Known constructors handled natively (not needing __new_ imports) */
export const KNOWN_CONSTRUCTORS = new Set([
  "Array",
  "Date",
  "Map",
  "Set",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  // (#1467) AggregateError gets its own 3-param `__new_AggregateError` host
  // import registered by new-super.ts (errors + message + options). The
  // generic unknown-constructor pre-pass would register it with a 2-param
  // signature (errors + message only), which then collides with new-super.ts's
  // 3-param call site and silently drops the `options` argument. Keep this
  // entry in `KNOWN_CONSTRUCTORS` so the pre-pass skips it and lets
  // new-super.ts register the canonical signature.
  "AggregateError",
  "Test262Error",
  "Object",
  "Function",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Number",
  "String",
  "Boolean",
  "ArrayBuffer",
  "DataView",
  "Proxy",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
]);

/** Functional array methods that need host callback bridges */
export const FUNCTIONAL_ARRAY_METHODS = new Set([
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
]);

/**
 * Check if a ts.Type is a TypeScript tuple type (e.g. [number, string]).
 * Tuples are TypeReference types whose target has the Tuple object flag.
 * The Tuple flag is on the target, not the reference itself.
 */
export function isTupleType(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const objType = type as ts.ObjectType;
  // Direct Tuple flag check (on the target for TypeReference types)
  if ((objType.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  // TypeReference → check target's objectFlags
  if ((objType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const ref = type as ts.TypeReference;
    if (ref.target && (ref.target.objectFlags & ts.ObjectFlags.Tuple) !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get the element types of a tuple type.
 * Returns the resolved ValType for each element position.
 */
export function getTupleElementTypes(ctx: CodegenContext, tsType: ts.Type): ValType[] {
  const typeRef = tsType as ts.TypeReference;
  const typeArgs = ctx.checker.getTypeArguments(typeRef);
  return typeArgs.map((t) => {
    // In tuple element position, `undefined` must not map to i32: i32 can't
    // distinguish "missing" from 0, which breaks destructuring default checks
    // on hole/undefined elements (e.g. `[x=23] = [,]` — the param default is a
    // hole-array tuple; the sNaN sentinel gets truncated to i32 0 and the inner
    // default `x=23` never fires). Promote to f64 so the sNaN sentinel survives.
    if ((t.flags & ts.TypeFlags.Undefined) !== 0) {
      return { kind: "f64" };
    }
    return resolveWasmType(ctx, t);
  });
}

/**
 * Build a unique key for a tuple type signature based on its element types.
 * Used as the key for tupleTypeMap to de-duplicate identical tuple shapes.
 */
function tupleTypeKey(elemTypes: ValType[]): string {
  return elemTypes
    .map((t) => {
      if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}_${t.typeIdx}`;
      return t.kind;
    })
    .join(",");
}

/**
 * Get or register a Wasm GC struct type for a tuple type.
 * Each unique tuple signature (e.g. [f64, externref]) maps to one struct type
 * with fields named _0, _1, etc.
 */
export function getOrRegisterTupleType(ctx: CodegenContext, elemTypes: ValType[]): number {
  const key = tupleTypeKey(elemTypes);
  const existing = ctx.tupleTypeMap.get(key);
  if (existing !== undefined) return existing;

  const fields: FieldDef[] = elemTypes.map((t, i) => ({
    name: `_${i}`,
    type: t,
    mutable: false,
  }));

  const typeIdx = ctx.mod.types.length;
  const structName = `__tuple_${ctx.tupleTypeMap.size}`;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.tupleTypeMap.set(key, typeIdx);
  ctx.structMap.set(structName, typeIdx);

  // Register in structFields so emitStructFieldGetters can export __sget_0, __sget_1 etc.
  // This enables the runtime to introspect tuple elements (needed for Map/Set iterables).
  ctx.structFields.set(
    structName,
    fields.map((f) => ({
      name: f.name,
      type: f.type,
      mutable: f.mutable ?? false,
    })),
  );

  return typeIdx;
}

/**
 * Native type annotation map: type alias names that map to Wasm types.
 * When a user writes `type i32 = number; let x: i32 = 42;`, the compiler
 * will use Wasm i32 instead of f64 for the local variable.
 */
const NATIVE_TYPE_MAP: Record<string, ValType> = {
  i32: { kind: "i32" },
  u8: { kind: "i32" }, // unsigned 8-bit — stored as i32 (masked at boundaries)
  u16: { kind: "i32" }, // unsigned 16-bit — stored as i32 (masked at boundaries)
  u32: { kind: "i32" }, // unsigned 32-bit — stored as i32
  i8: { kind: "i32" }, // signed 8-bit — stored as i32
  i16: { kind: "i32" }, // signed 16-bit — stored as i32
  f32: { kind: "f32" },
  f64: { kind: "f64" },
  // i64 intentionally omitted — requires BigInt integration, not yet supported
};

/**
 * Detect native type annotations (e.g., `type i32 = number`) from a TS type's
 * alias symbol. Returns the corresponding Wasm ValType, or null if not a native
 * type annotation.
 *
 * **(#3673) This premise is false and this function can never fire.**
 * TypeScript populates `aliasSymbol` for aliases of OBJECT and UNION types,
 * but not for an alias of an intrinsic primitive: `type i32 = number` resolves
 * to the shared `numberType`, which carries no alias identity (verified on TS
 * 5.9.3; instrumenting a full compile of an `i32`-annotated program gave 84
 * calls, 0 hits, and no alias name ever observed). The live resolution now
 * happens syntactically, from the declaration's TYPE NODE — see
 * `native-type-annotations.ts`. This function is kept because it is on the
 * `resolveWasmType` fast path and returning `null` there is exactly the
 * historical behaviour; do NOT "fix" it by widening the type test, and do not
 * add new callers.
 */
export function resolveNativeTypeAnnotation(tsType: ts.Type): ValType | null {
  const aliasName = tsType.aliasSymbol?.name;
  if (aliasName && aliasName in NATIVE_TYPE_MAP) {
    // Verify the alias resolves to number (not some unrelated type named "i32")
    // by checking that the underlying type is a number type.
    // aliasSymbol is set → the resolved type should be NumberLike.
    const flags = tsType.flags;
    if (flags & ts.TypeFlags.Number || flags & ts.TypeFlags.NumberLiteral) {
      return NATIVE_TYPE_MAP[aliasName]!;
    }
  }
  return null;
}

/**
 * (#2176) Resolve the type of an identifier reference, preferring the user's
 * own declaration over an ambient lib (`.d.ts`) global of the same name.
 *
 * Root cause: js2wasm analyzes a top-level program as a **script** (no
 * import/export ⇒ not a module). In script mode a top-level `const name = …`
 * does NOT shadow the writable global `var name: string` declared in
 * `lib.dom.d.ts` (both live in the global scope, and TypeScript resolves a
 * bare reference to the ambient symbol). So `const y = name` types `y` as
 * `void` (the ambient `name`) instead of `string`, and the colliding-name
 * read (`` `${name}` ``, `"x" + name`, `const y = name`) loses its real type —
 * the codegen then registers `y` as an i32 global and the value reads back as
 * `0`/`undefined`. Runtime values are stored correctly under `$__mod_name`;
 * only the *type* is poisoned. Common colliders: `name` (→ undefined),
 * `length`, `top`, `status`, `origin`, etc. from lib.dom.
 *
 * Fix: when `getTypeAtLocation(id)` binds to a symbol whose declarations live
 * ONLY in lib `.d.ts` files, but a user-level binding of that exact name is in
 * scope (a non-lib declaration), re-derive the type from the user binding so
 * the read/declaration sees the real type. Falls back to the original type
 * when no user binding shadows the ambient — zero behavior change for genuine
 * host-global reads (`window.name`, bare `length` with no user binding).
 */
export function resolveIdentifierType(ctx: CodegenContext, id: ts.Identifier): ts.Type {
  const sym = ctx.checker.getSymbolAtLocation(id);
  const decls = sym?.declarations;
  // Only intervene when the bound symbol is purely ambient (every declaration
  // lives in a lib/declaration file). A user declaration mixed in means TS
  // already resolved (at least partly) to the user — leave it alone.
  const isPurelyAmbient =
    decls !== undefined && decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
  if (!isPurelyAmbient) {
    return ctx.checker.getTypeAtLocation(id);
  }
  // A same-name user binding shadows the ambient global, but in script mode the
  // checker's scope contains ONLY the ambient symbol — `getSymbolsInScope`
  // never surfaces the user binding. So walk the AST enclosing scopes for a
  // user-source declaration (var/let/const, function, class, or param) of the
  // same name and re-derive the type from it.
  const userDecl = findUserBindingDecl(id);
  if (userDecl) {
    return ctx.checker.getTypeAtLocation(userDecl);
  }
  return ctx.checker.getTypeAtLocation(id);
}

/**
 * (#2176) Walk enclosing scopes from `id` outward to find a user-source
 * declaration that binds `id.text` (a `var`/`let`/`const` declaration,
 * function/class declaration, or parameter). Returns the binding node whose
 * `getTypeAtLocation` gives the real type, or undefined if no user binding
 * shadows the ambient global.
 */
function findUserBindingDecl(id: ts.Identifier): ts.Node | undefined {
  const name = id.text;
  const bindsName = (node: ts.Node): ts.Node | undefined => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      !node.getSourceFile().isDeclarationFile
    ) {
      return node;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name &&
      !node.getSourceFile().isDeclarationFile
    ) {
      return node;
    }
    return undefined;
  };
  // Search a statement list (block / source file body) for a binding.
  const searchStatements = (statements: readonly ts.Statement[]): ts.Node | undefined => {
    for (const stmt of statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const found = bindsName(d);
          if (found) return found;
        }
      } else {
        const found = bindsName(stmt);
        if (found) return found;
      }
    }
    return undefined;
  };
  let scope: ts.Node | undefined = id.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const found = searchStatements(scope.statements);
      if (found) return found;
    }
    // Function/arrow/method parameters bind names in their body scope.
    if (
      (ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope) ||
        ts.isConstructorDeclaration(scope)) &&
      scope.parameters
    ) {
      for (const p of scope.parameters) {
        const found = bindsName(p);
        if (found) return found;
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type, _depth = 0, _visited?: Set<ts.Type>): ValType {
  // Guard against infinite recursion (can happen with skipSemanticDiagnostics
  // when getTypeArguments returns the container type itself)
  if (_depth > 10) return { kind: "externref" };
  if (_visited && _visited.has(tsType)) return { kind: "externref" };
  if (!_visited) _visited = new Set<ts.Type>();
  _visited.add(tsType);
  // Native type annotations: type i32 = number; let x: i32 → Wasm i32
  // Check aliasSymbol first — TypeScript preserves the alias name on the type.
  const nativeType = resolveNativeTypeAnnotation(tsType);
  if (nativeType) return nativeType;

  // Fast mode: string → ref $AnyString (not externref).
  // The String WRAPPER object (`new String(x)`) is excluded here — `isStringType`
  // intentionally also matches the wrapper for primitive-string method dispatch,
  // but the wrapper is a `typeof "object"` value carrying its [[StringData]] in a
  // native `$Object` slot (#1910 S2 / #2160). Resolving it to `$AnyString` would
  // make the wrapper-`$Object` externref fail the ref.cast on bind → null. It must
  // fall through to the externref wrapper branch below.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(tsType) && !isStringWrapperType(tsType)) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }

  // Check tuple types BEFORE Array — tuples have the Object flag and Array symbol
  // but should be compiled to structs, not arrays
  if (isTupleType(tsType)) {
    const elemTypes = getTupleElementTypes(ctx, tsType);
    const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);
    return { kind: "ref", typeIdx: tupleIdx };
  }

  // Check Array<T> / T[] BEFORE isExternalDeclaredClass, because Array is declared
  // in the lib as `declare var Array: ArrayConstructor` which would match externref
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    // `TemplateStringsArray` (the first parameter of a tag function) is the
    // template object built by `compileTaggedTemplateExpression` — a vec struct
    // `{ length, data, raw }` (the template vec type). It extends
    // `ReadonlyArray<string>`, so it MUST be matched before the Array branch
    // below, otherwise it would lower to a plain string vec without the `raw`
    // field and indexed/`.raw` reads would mismatch the runtime struct (#2008).
    if (sym?.name === "TemplateStringsArray") {
      const templateVecTypeIdx = getOrRegisterTemplateVecType(ctx);
      return { kind: "ref_null", typeIdx: templateVecTypeIdx };
    }

    // `readonly T[]` / `ReadonlyArray<T>` lower identically to `T[]` — `readonly`
    // is a TS-only modifier with no runtime representation. Without this, a
    // ReadonlyArray-typed struct field falls through to the anonymous-struct /
    // externref path and mismatches the vec the array literal builds, trapping
    // on indexed read (#1748).
    if (sym?.name === "Array" || sym?.name === "ReadonlyArray") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemTsType = typeArgs[0];
      let elemWasm: ValType = elemTsType
        ? resolveWasmType(ctx, elemTsType, _depth + 1, _visited)
        : { kind: "externref" };
      // (#2806) An array whose element type is **purely** `undefined` / `void`
      // must lower to an externref-element vec, not a numeric (i32) vec — the
      // same alignment applied to `var x = (void 0)` slots. The canonical source
      // is acorn's `parseExprList`: `var elt = (void 0); … elt = <nodeRef>;
      // elts.push(elt); return elts`. TS infers the *function return type* as
      // `undefined[]`, so the returned vec type would be an i32 vec while the
      // local `elts` is an externref vec — `return elts` then copies/coerces
      // each pushed REFERENCE to i32 `0`, dropping the AST node refs (#2801).
      // Resolving `undefined[]`/`void[]` to externref here keeps the return type
      // (and any field/param so typed) in lockstep with the externref local.
      // `never[]` already resolves to externref; this closes the `undefined[]`
      // gap. Pure undefined/void only (no Number/Boolean/etc.) so `number[]`
      // (f64) and `boolean[]` (i32) are untouched; `number | undefined` carries
      // the Union flag, not Undefined, and is left alone.
      if (
        elemTsType &&
        (elemWasm.kind === "i32" || elemWasm.kind === "f64") &&
        (elemTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
        (elemTsType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0
      ) {
        elemWasm = { kind: "externref" };
      }
      const elemKey =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      // Use ref_null so locals can default-initialize to null
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Wrapper types (Number, String, Boolean) — map to externref.
    // new Number(x), new String(x), new Boolean(x) are wrapper objects (typeof "object").
    if (sym?.name === "Number" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "String" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "Boolean" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }

    // Promise<T> → unwrap to T (host/GC) OR externref (native carrier).
    if (sym?.name === "Promise") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      if (typeArgs.length > 0) {
        const inner = typeArgs[0]!;
        if (isVoidType(inner)) return { kind: "externref" }; // Promise<void> → externref (no value)
        // (#2905/#3134) A `Promise<T>` VALUE slot (local/param/field/non-async
        // return/vec element) lowers to externref on EVERY lane — it holds a
        // real promise, not the unwrapped `T`. Unwrapping to `T` (f64) then
        // `__unbox_number`'d a real promise externref → NaN; externref serves
        // the legacy sync-fakery rep too (an async call compiled synchronously
        // returns the unwrapped f64, which boxes at the coerce and unboxes /
        // `Promise_resolve`-assimilates on use). Unifying the rep also fixes a
        // `Promise<T>[]` element (frame spill guess now matches the stored
        // promise → unblocks #2967 2c class-2). An async fn's OWN return
        // pre-unwraps via `unwrapPromiseType` before this branch. externref is
        // a leaf valtype (no DCE/funcIdx churn). Broad rep change → full-CI A/B.
        return { kind: "externref" };
      }
      return { kind: "externref" }; // bare Promise without type arg
    }

    // TypedArray types → vec struct. Native Uint8Array uses packed-byte
    // storage; other typed arrays keep the legacy f64 representation.
    // Covers: Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    //         Int32Array, Uint32Array, Float32Array, Float64Array
    // (#838) BigInt64Array/BigUint64Array resolve to an i64-element vec (they are
    // deliberately kept OUT of `TYPED_ARRAY_NAMES` so the f64-assuming host
    // marshalling classifier treats them as "other"; `typedArrayVecStorage`
    // returns i64 for them).
    // (#838 gate — fable-dev-5) Only in standalone/wasi: in js-host the BigInt
    // views stay host globals (externref) so SharedArrayBuffer/Atomics interop
    // works — the native i64-vec has no js-host Atomics bridge yet (see the
    // construction-path notes in new-builtin-globals.ts / new-super.ts). Numeric
    // views map to a native vec in js-host too, but their Atomics bridge exists.
    const isBigIntView838 = sym?.name !== undefined && BIGINT_TYPED_ARRAY_NAMES.has(sym.name);
    if (sym?.name && (TYPED_ARRAY_NAMES.has(sym.name) || (isBigIntView838 && (ctx.wasi || ctx.standalone)))) {
      const storage = typedArrayVecStorage(ctx, sym.name);
      const vecIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Date → WasmGC struct with i64 timestamp field
    if (sym?.name === "Date") {
      const dateTypeIdx = ensureDateStructForCtx(ctx);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // (#1103a) Map → WasmGC native Map struct (`$Map`) in standalone /
    // nativeStrings mode. Mirrors Date above — a `Map`-typed binding/param
    // becomes `ref $Map` so `new Map()` stores directly and method/.size
    // dispatch reads a typed receiver (no externref round-trip / illegal cast).
    // JS-host mode keeps Map as an externref-backed externClass (falls through).
    if (sym?.name === "Map" && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // (#2162) Set → the SAME native `$Map` struct in standalone / nativeStrings
    // mode (a Set is a Map with key === value). A `Set`-typed binding becomes
    // `ref $Map` so `new Set()` stores directly and method/.size dispatch reads
    // a typed receiver. JS-host mode keeps Set as an externref externClass.
    if (sym?.name === "Set" && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // (#2162) WeakMap / WeakSet → the SAME native `$Map` struct in standalone /
    // nativeStrings mode (they reuse the Map backing store with object-identity
    // keys and no iteration). JS-host mode keeps them as externref externClasses.
    if ((sym?.name === "WeakMap" || sym?.name === "WeakSet") && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // Check externref AFTER Array check — Array is declared in lib but should use wasm GC arrays
    if (isExternalDeclaredClass(tsType, ctx.checker)) return { kind: "externref" };

    // (#2937) The checker type of a `{}` var poisoned as an `$Object`-hash
    // consumer (#2584/#2849) must NOT resolve to a closed struct. In JS-mode
    // sources the checker EVOLVES `var o = {}` through its later static-named
    // writes into an anonymous object type WITH those props; auto-registering
    // it below would type the local — and every flow position the object
    // passes through (returns, class fields, receivers) — as `(ref null
    // __anon_N)` while the poisoned initializer builds a host plain object
    // (externref). The declaration's guarded cast then stores ref.null and
    // every static read null-derefs (compiled-acorn `getOptions`, #2937).
    // Externref keeps ALL access forms on the poisoned var routed through the
    // host MOP coherently. The set is empty in standalone mode (recorded
    // host-only), so standalone codegen is unaffected.
    if (ctx.objectHashConsumerTypes.has(tsType)) return { kind: "externref" };

    // (#1712) Function-style-constructor instance types resolve to EXTERNREF,
    // never to a synthesized checker-shape struct. The runtime instance struct
    // (compileFnctorNew, `__fnctor_<name>`) is built from ctor `this.*` writes
    // only, while the checker's shape adds prototype-assigned methods as
    // members — the two shapes have no subtype relation, so any value typed
    // with the checker shape guard-casts to null and downstream struct.get /
    // ref.as_non_null traps (acorn `Parser.prototype.parse = function () {
    // return new Parser(...); }`). Externref makes fnctor instances flow
    // dynamically end to end: member calls take the host-bridge path (which
    // resolves through the vivified prototype) and field reads go through
    // __extern_get/_safeGet. NOTE: resolving to the CTOR struct here instead
    // was tried and regressed (.tmp/dbg15.mts G4/G5) — the member-call
    // static/dynamic split keys off this type, so only the always-dynamic
    // externref resolution is safe. Standalone admits only fnctors approved by
    // the escape gate: those have a reserved native `__fnctor_<name>` receiver
    // arm plus a per-fnctor `$Object` prototype used by the native dynamic
    // getter/method dispatcher. Other standalone fnctors keep their existing
    // closed representation.
    const approvedStandaloneFnctor =
      ctx.standalone && sym?.name !== undefined && ctx.fnctorEscapeGate?.approvedNames.has(sym.name) === true;
    // (#2071) A constructor whose body may `return` a FOREIGN object makes the
    // checker's instance-shape inference UNSOUND: the constructed value may be
    // an arbitrary object (§10.2.1.3 step 13), so a closed struct shape — and
    // every member coercion derived from it — can misread the override
    // (measured: `obj.prop` holding "A" answered ToNumber("A") = NaN through
    // the inferred `prop: number`). Such instances degrade to externref and
    // flow dynamically end to end, the same representation the escape-gate arm
    // below already uses. Must answer in lockstep with the ctor-ABI widening
    // in compileNewFunctionDeclaration — both read the same pure-AST predicate.
    const foreignReturnFnctor = (ctx.standalone || ctx.wasi) && typeIsForeignReturnFnctorInstance(tsType);
    if ((!ctx.standalone && !ctx.wasi) || approvedStandaloneFnctor || foreignReturnFnctor) {
      const fnDecl = sym?.valueDeclaration;
      const isFnCtorType =
        (sym?.name !== undefined && ctx.funcConstructorMap.has(sym.name)) ||
        (!!fnDecl &&
          (ts.isFunctionDeclaration(fnDecl) ||
            ts.isFunctionExpression(fnDecl) ||
            (ts.isVariableDeclaration(fnDecl) && !!fnDecl.initializer && ts.isFunctionExpression(fnDecl.initializer))));
      // Only when the type is an INSTANCE shape (has properties but is not
      // itself callable) — the function VALUE type (callable) must keep its
      // closure-wrapper resolution.
      if (isFnCtorType && tsType.getCallSignatures().length === 0) {
        // (#2071) Foreign-return-capable: always dynamic, never the reserved
        // struct — the value at runtime may not BE that struct. This WINS over
        // escape-gate approval: approval says the struct layout is stable, not
        // that `new F()` yields it — with an approved foreign-return ctor the
        // struct-typed binding guard-cast the overriding $Object to null and
        // every read answered undefined (measured, S13.2.2_A15_T1 shape).
        if (foreignReturnFnctor && (ctx.standalone || ctx.wasi)) {
          return { kind: "externref" };
        }
        // (#4155 Phase 1) Opt-in: map onto the ALREADY-RESERVED runtime struct.
        return resolveFnctorInstanceType(ctx, sym?.name) ?? { kind: "externref" };
      }
    }

    // (#2542) A PURE string-index-signature type — `{ [s: string]: T }`, a
    // `type`-alias to one, or an `interface Dict { [s: string]: T }` — with no own
    // named properties is an open dictionary. Its only access mode is runtime
    // string-keyed [[Get]]/[[Set]] (`o[k]`), serviced by the native object runtime
    // over a `$Object` externref (`__extern_get`/`__extern_set`). Without this
    // guard the type lowers to an EMPTY WasmGC struct (anonymous → the auto-register
    // below; named interface → `collectInterface`'s empty struct): a value typed
    // that way (param, return, local) becomes `ref $empty`, so a `$Object` argument
    // guard-casts to null at the call boundary and every `o[k]` read returns 0.
    // Resolving to externref keeps such values flowing as `$Object`s end to end,
    // matching the open-`$Object` literal lowering in compileObjectLiteral (#2542).
    //
    // Runs BEFORE the named-struct lookup so a pure-index-signature *interface*
    // (already registered as an empty struct by `collectInterface`) still resolves
    // to externref — the empty struct stays registered (harmless; dead-eliminated
    // if unreferenced) but is never used as a value type, so no type-index shift.
    //
    // HOST-FREE targets (standalone AND wasi). The gate originally read
    // `ctx.standalone` alone, which left wasi — equally host-free — with neither
    // the host import gc/host uses nor this routing, so `o[k]` silently read the
    // DEFAULT there. Analysis + measurements on plan/issues/2542-*.md. gc/host is
    // unchanged (a JS host services `o[k]`); a MIXED `{ a: number; [s: string]: T }`
    // stays excluded — it has a static shape consumers read by field.
    if (
      (ctx.standalone || ctx.wasi) &&
      tsType.getProperties().length === 0 &&
      tsType.getCallSignatures().length === 0 &&
      !!ctx.checker.getIndexInfoOfType(tsType, ts.IndexKind.String)
    ) {
      return { kind: "externref" };
    }

    let name = exactClassExpressionTypeName(ctx, tsType) ?? sym?.name;
    // Map class expression display names to their synthetic names only when
    // declaration identity was unavailable. Unrelated anonymous classes all
    // use `__class`, so this fallback cannot safely override an exact match.
    if (name && !ctx.structMap.has(name)) {
      name = ctx.classExprNameMap.get(name) ?? name;
    }
    // (#3051 Slice 3, NARROWED after the PR-#2910 merge_group park) Accessor-
    // bearing ANONYMOUS object types are NOT blanket-lowered to externref here:
    // #2724's guard in ensureStructForType deliberately keeps getter-ONLY
    // literal types registered as structs because the object-REST copy paths
    // (`{...x} = { get v() {…} }`, for-await rest) steer by that registration
    // (struct→externref→__extern_rest_object); unregistering routed them to the
    // externref-rest path which never invokes the getter (regressed
    // dstr/obj-rest-getter-abrupt-get-error in the merge_group re-validation).
    // The host-object-representation fix for CLOSURE RETURNS lives at the two
    // return-type resolution sites in closures.ts via
    // `resolveWasmTypeForClosureReturn` instead.
    // Check named structs (interfaces, type aliases)
    if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
      // (#1366a) Externref-backed user classes (e.g. `class Sub extends Error`)
      // have their instance live as a real JS object; the registered struct
      // type exists for tag/registry bookkeeping only. Wasm-typed values for
      // these types must be externref so callers see what `<className>_new`
      // actually returns.
      if (ctx.classExternrefBackedSet.has(name)) {
        return { kind: "externref" };
      }
      return { kind: "ref", typeIdx: ctx.structMap.get(name)! };
    }
    // (#4149) EMPTY anonymous object shape (`{}` — zero properties, zero call
    // signatures) on a host-free target: resolve to externref, never to the
    // zero-field closed struct. An empty object literal is BUILT as a native
    // `$Object` (`__new_plain_object`) — same fact the field-level widening in
    // ensureStructForType and the pure-index-signature guard above rely on — so
    // a binding typed `ref_null $__anon_empty` guard-casts that `$Object` to
    // NULL, silently severing the alias. That is the acorn/UMD wrapper shape:
    // `var e = m.exports; e.f = fn; m.exports.f()` had BOTH `e` and the
    // re-read alias nulled, so the write landed nowhere and the call answered
    // null. Zero properties means no static field access can ever rely on the
    // struct layout, so keeping the value on its dynamic `$Object` rep loses
    // nothing. Named classes resolved above are untouched.
    // ALL lanes: gc/host builds `{}` as a host plain object (externref) — the
    // guarded cast nulls the binding there identically (host read then throws
    // `Cannot read properties of null`), so the widening is lane-independent.
    // No name gate: a `{}` type reached through a variable carries that
    // variable's symbol name (e.g. `x`), and anything legitimately struct-typed
    // (named class/interface) already returned through the structMap branch
    // above — only anonymous/empty shapes fall through to here.
    if (
      tsType.getProperties().length === 0 &&
      tsType.getCallSignatures().length === 0 &&
      tsType.getConstructSignatures().length === 0
    ) {
      return { kind: "externref" };
    }
    // Check anonymous type registry
    const anonName = ctx.anonTypeMap.get(tsType);
    if (anonName && ctx.structMap.has(anonName)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(anonName)! };
    }

    // Auto-register anonymous object types that look like plain data objects
    // (name is __type or __object, has properties, not a class/function/external type)
    if (!anonName && (name === "__type" || name === "__object") && tsType.getProperties().length > 0) {
      ensureStructForType(ctx, tsType);
      const registeredName = ctx.anonTypeMap.get(tsType);
      if (registeredName && ctx.structMap.has(registeredName)) {
        return { kind: "ref", typeIdx: ctx.structMap.get(registeredName)! };
      }
    }
  }

  // Handle unions (T | undefined | void) — resolve inner type.
  // (#1550) Filter Void alongside Null/Undefined — TS treats counter()'s `void`
  // return as a distinct type, but at runtime it's just `undefined`. Without
  // this, `void | null` (e.g. binding `w` in `function f({w = counter()} = {w: null})`)
  // collapses to `void` → i32 and the destructured null is erased.
  if (tsType.isUnion()) {
    // (#1769/#3666) Nullable primitive function results/params/fields need the
    // same sentinel-preserving carrier already used by local preallocation.
    // Resolving `number | null` to plain f64 erases a returned null to 0 before
    // the caller can test it (Acorn's readInt/readHexChar error sentinel).
    // Optional object fields (`number | undefined`, etc.) already have
    // shape-specific absence handling. Widening those here changes their
    // concrete struct layout and can make direct delete/read paths disagree.
    // The Acorn boundary that needs a carrier at this general resolver is the
    // explicit-null result family (`number | null`, `string | null`, ...).
    if (isNullablePrimitiveType(tsType) && tsType.types.some((type) => type.flags & ts.TypeFlags.Null)) {
      return { kind: "externref" };
    }
    const nonNullish = tsType.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Void),
    );
    if (nonNullish.length === 1 && tsType.types.length === 2) {
      const inner = resolveWasmType(ctx, nonNullish[0]!, _depth + 1, _visited);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
    // (#745 S2) Known heterogeneous primitive unions (number|string, …) adopt
    // the universal $AnyValue tagged carrier in unionAnyRep lanes
    // (standalone/nativeStrings), replacing externref + per-op
    // box/unbox/typeof round-trips. Homogeneous unions, nullable single-kind
    // unions (handled above), and unions with any non-primitive member keep
    // their existing representation — see isHeterogeneousPrimitiveUnion.
    if (ctx.unionAnyRep && isHeterogeneousPrimitiveUnion(tsType)) {
      ensureAnyValueType(ctx);
      return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
    }
  }

  // any/unknown → ref_null $AnyValue (boxed any) when available.
  // Only in fast mode where there are no host-imported extern classes to conflict with.
  // In non-fast mode, any/unknown falls through to mapTsTypeToWasm → externref.
  if (ctx.fast && tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    ensureAnyValueType(ctx);
    return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  }

  // Preserve the semantic brand for primitive symbols at every binding
  // boundary, not only inside registered struct fields.  Symbols share the
  // physical i32 representation with booleans and numbers, but crossing an
  // externref boundary must use __unbox_symbol rather than ToNumber.  Without
  // this final brand step a module-level destructuring such as
  // `const { iterator } = Symbol` allocated an unbranded i32 global and the
  // destructuring emitter generated Number(Symbol.iterator), which correctly
  // throws but incorrectly prevented ordinary Symbol-keyed imports from
  // initializing.  The brand is a no-op for every non-symbol type.
  return symbolBrand(tsType, mapTsTypeToWasm(tsType, ctx.checker, ctx.fast));
}

/**
 * (#3051 Slice 3) True when the object type carries at least one property
 * declared as an OBJECT-LITERAL get/set accessor (`{ get x() {…} }` /
 * `{ set x(v) {…} }`). Such values are runtime-represented as HOST plain
 * objects (see `compileObjectLiteralWithAccessors`, #1239). Class/interface
 * accessors (declaration parent is not an ObjectLiteralExpression) do NOT
 * qualify — those instances keep their struct representation.
 */
function typeHasObjLitAccessorProperty(tsType: ts.Type): boolean {
  for (const p of tsType.getProperties()) {
    const decls = p.getDeclarations?.() ?? p.declarations;
    if (!decls) continue;
    for (const d of decls) {
      if (
        (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
        d.parent != null &&
        ts.isObjectLiteralExpression(d.parent)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * (#3051 Slice 3, narrowed) Resolve a CLOSURE/CALLBACK return type, lowering
 * accessor-bearing anonymous object-literal types to externref. The runtime
 * value of `{ get index() {…} }` is a HOST plain object
 * (`compileObjectLiteralWithAccessors`, #1239); typing the closure's wasm
 * return as the checker's struct made the return-path coercion
 * externref→struct null-drop on the failed `ref.test` (type-coercion.ts) —
 * a `regexp.exec` override returning a poisoned `{ get index() { throw … } }`
 * arrived at V8's @@replace protocol as `null` (= no match) and the getter
 * never fired (the test262 `result-get-*-err` cluster). Scoped to RETURN-type
 * resolution ONLY: blanket-lowering these types in `resolveWasmType` broke the
 * #2724 object-REST steering (see the note in `resolveWasmType`).
 */
export function resolveWasmTypeForClosureReturn(ctx: CodegenContext, retType: ts.Type): ValType {
  const symName = retType.getSymbol()?.name;
  if ((symName === "__type" || symName === "__object") && typeHasObjLitAccessorProperty(retType)) {
    return { kind: "externref" };
  }
  return resolveWasmType(ctx, retType);
}

/**
 * Compute a hash key for a list of struct fields (for O(1) structural dedup).
 */
export function fieldsHashKey(fields: FieldDef[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const t = f.type;
    if (t.kind === "ref" || t.kind === "ref_null") {
      parts.push(`${f.name}:${t.kind}:${(t as { typeIdx: number }).typeIdx}`);
    } else if (t.kind === "i32" && ((t as { boolean?: true }).boolean || t.symbol === true)) {
      // (#1788) Keep boolean-branded i32 fields distinct from numeric i32 in the
      // structural dedup key — they box differently (`__box_boolean` vs
      // `__box_number`), so two shapes that differ only in boolean-vs-number must
      // not collapse to one struct (which would inherit the wrong getter boxing).
      parts.push(`${f.name}:i32:${t.symbol === true ? "sym" : "bool"}`);
    } else {
      parts.push(`${f.name}:${t.kind}`);
    }
  }
  return parts.join("|");
}

/** Ensure the $__Date struct type exists in the module, return its type index. */
function ensureDateStructForCtx(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct" as const,
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }]);
  return typeIdx;
}

/**
 * A property-name-wide carrier scan is intentionally conservative, but it must
 * not turn every concrete string/boolean field with the same name into an
 * externref.  Test262 descriptor literals commonly use fields such as
 * `value` and `configurable`; those are concrete primitives even though an
 * unrelated dynamic object write may use the same property name.  Only widen
 * types that can actually receive an object-shaped value (or an explicitly
 * nullish seed, handled by the caller) so their literal values keep their
 * original representation.
 */
function typeMayCarryObjectValue(type: ts.Type): boolean {
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) {
    return true;
  }
  if (flags & ts.TypeFlags.Union) {
    return (type as ts.UnionType).types.some((member) => typeMayCarryObjectValue(member));
  }
  return false;
}

/**
 * Ensure a ts.Type that's an object type is registered as a struct.
 * For named types already in structMap, this is a no-op.
 * For anonymous types, auto-registers them with a generated name.
 */
export function ensureStructForType(ctx: CodegenContext, tsType: ts.Type): void {
  if (!(tsType.flags & ts.TypeFlags.Object)) return;
  if (isExternalDeclaredClass(tsType, ctx.checker)) return;
  // (#2937) Never register a struct for the evolved checker type of a poisoned
  // `$Object`-hash-consumer `{}` var — it must stay externref/host-MOP end to
  // end (see resolveWasmType's matching guard for the full rationale).
  if (ctx.objectHashConsumerTypes.has(tsType)) return;
  // Types declared in `.d.ts` files (interfaces, type aliases, classes
  // exported from declaration-file-only packages) have no JS implementation
  // we can lower to a WasmGC struct. Registering them as anon structs
  // recursively pulls in their fields' types, which for any non-trivial
  // shape (e.g. `errors: ValidationError[]` in `@types/json-schema`)
  // produces forward heap-type references that fail Wasm validation.
  // Skip registration — these types map to `externref` everywhere. (#1287)
  const dtsDecls = tsType.symbol?.getDeclarations?.();
  if (dtsDecls && dtsDecls.length > 0 && dtsDecls.every((d) => d.getSourceFile().isDeclarationFile)) {
    return;
  }
  // Tuple types are handled by getOrRegisterTupleType, not as anonymous structs
  if (isTupleType(tsType)) return;
  // #1247: Array types compile to vec structs (length+data) via getOrRegisterVecType,
  // not anonymous structs that pull in every Array.prototype method as a field. Without
  // this guard, `string[]` registers an anonymous struct named after Array.prototype's
  // shape, and `paths.shift()` resolves through compileCallablePropertyCall (a
  // callable-field dispatch) instead of compileArrayMethodCall — producing
  // struct-type mismatches at instantiation when the local was allocated via the
  // vec path but the callable-property dispatch reads through the anon struct.
  {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (
      sym?.name === "Array" ||
      sym?.name === "ReadonlyArray" ||
      sym?.name === "Int8Array" ||
      sym?.name === "Uint8Array" ||
      sym?.name === "Uint8ClampedArray" ||
      sym?.name === "Int16Array" ||
      sym?.name === "Uint16Array" ||
      sym?.name === "Int32Array" ||
      sym?.name === "Uint32Array" ||
      sym?.name === "Float32Array" ||
      sym?.name === "Float64Array" ||
      sym?.name === "Promise" ||
      sym?.name === "Date" ||
      sym?.name === "Map" ||
      sym?.name === "Set" ||
      sym?.name === "WeakMap" ||
      sym?.name === "WeakSet" ||
      sym?.name === "RegExp" ||
      sym?.name === "Number" ||
      sym?.name === "String" ||
      sym?.name === "Boolean"
    ) {
      return;
    }
  }
  // Callable types (functions) are compiled as closures, not structs
  if (tsType.getCallSignatures().length > 0) return;
  // (#2542) A pure string-index-signature type — `{ [s: string]: T }` with no own
  // named properties — is an open dictionary that lowers to a `$Object` externref
  // (see resolveWasmType's #2542 guard), NOT an empty WasmGC struct. Registering an
  // empty struct here would make `resolveWasmType` pick `ref $empty` for the binding
  // and break the call-boundary `$Object`→struct cast (every `o[k]` read returns 0).
  // Host-free targets (standalone AND wasi), matching the resolveWasmType guard's
  // scope — see the #2542-follow-up note there for why wasi belongs here.
  if (
    (ctx.standalone || ctx.wasi) &&
    tsType.getProperties().length === 0 &&
    !!ctx.checker.getIndexInfoOfType(tsType, ts.IndexKind.String)
  ) {
    return;
  }
  // Guard against infinite recursion on circular/self-referencing types.
  // Uses per-compilation ctx.ensureStructPending (not module-scoped) to avoid
  // leaking state between compile() calls in the same process (#923).
  if (ctx.ensureStructPending.has(tsType)) return;
  ctx.ensureStructPending.add(tsType);

  const name = tsType.symbol?.name;

  // Already registered as named struct
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) return;

  // Already registered as anonymous struct
  if (ctx.anonTypeMap.has(tsType)) return;

  // Get properties from the type (empty objects get an empty struct)
  const props = tsType.getProperties();

  // (#2724) An object-LITERAL accessor-bearing type that ALSO carries a
  // non-accessor (data/method) own property must not become a closed struct.
  // getTypeOfSymbol on a getter symbol yields the getter's RETURN type, so a
  // getter `return` would be laid out as a plain data field (e.g. f64) — but the
  // literal is built as an externref $Object by compileObjectLiteralWithAccessors
  // (literals.ts). The two representations collide (gc: the externref $Object does
  // not match the struct, so reads come back null; standalone: the externref→struct
  // ref.cast traps with "illegal cast"). Skip registration → the type lowers to
  // externref everywhere (resolveWasmType falls through to mapTsTypeToWasm), and the
  // existing $Object accessor read path (__extern_get → __call_accessor_get) services
  // it. This is the root cause of #1642's residual iterator-close-*-get-method-* edges
  // (the iterator factory `{ next, get return() }` registered a closed struct, so
  // __iterator(iterable) read back null and __iterator_next(null) threw upstream of
  // close).
  //
  // (#2724 narrowing — merge_group floor fix) SCOPED to MIXED accessor literals
  // (≥1 obj-literal accessor AND ≥1 non-accessor own property). A getter-ONLY
  // literal like `{ get v() {} }` is, on main, used almost exclusively as an
  // object-REST/spread SOURCE (`{...x} = { get v() {} }`, `for await ({...x} of
  // [{ get v() {} }])`, RegExpExec's `{ get 0() {} }`). The object-rest copy paths
  // (assignment.ts / loops.ts) read the source through a `struct→externref →
  // __extern_rest_object` conversion that REQUIRES the source to be a registered
  // struct; lowering a getter-only literal to externref instead routes it to the
  // externref-rest path which does not run __extern_rest_object (assignment-rest)
  // or double-wraps it (`extern.convert_any` on an already-externref value in the
  // for-await path) — so the getter is never invoked / re-invoked, breaking
  // CopyDataProperties semantics. Restricting the guard to MIXED literals keeps
  // every getter-only rest/RegExp source on its working struct path (zero
  // regressions vs. the merged baseline) while still externref-lowering the #1642
  // iterators (which are mixed: an iterator always has a `next` method). The
  // getter-only return/member-read case is deferred to the #2580 externref-rest
  // substrate work. SCOPED to object-LITERAL accessors only (declaration parent is
  // an ObjectLiteralExpression): a CLASS getter's declaration parent is a
  // ClassDeclaration (and an interface's an InterfaceDeclaration) and MUST keep the
  // struct + getter-method representation.
  let hasObjLitAccessor = false;
  let hasNonAccessor = false;
  for (const prop of props) {
    const isAccessorSym = (prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0;
    if (
      isAccessorSym &&
      (prop.declarations ?? []).some(
        (d) =>
          (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
          d.parent != null &&
          ts.isObjectLiteralExpression(d.parent),
      )
    ) {
      hasObjLitAccessor = true;
    } else if (!isAccessorSym) {
      hasNonAccessor = true;
    }
  }
  if (hasObjLitAccessor && hasNonAccessor) return; // leave externref; do not register a struct

  const fields: FieldDef[] = [];
  // #1118 follow-up: track callable-property arities so structs whose methods
  // differ in arity don't dedup. Two object literals like `{ then(r) {…} }`
  // and `{ then(r, j) {…} }` both stringify their `then` field to externref,
  // so without this distinguishing info their structs would dedup. The
  // method placeholders share a funcMap entry, and the second method body
  // overrides the first's typeIdx — breaking trampolines created against
  // the original arity. Including the arity in the hash key keeps such
  // structs distinct.
  const methodSigParts: string[] = [];
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    ensureStructForType(ctx, propType);
    let wasmType = symbolBrand(propType, resolveWasmType(ctx, propType));
    const nullishScalarSeed =
      wasmType.kind === "i32" &&
      (propType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;
    const assignedObjectWrites = ctx.objectLiteralAssignedPropertyTypes.get(prop.name);
    const hasIncompatibleObjectWrite =
      assignedObjectWrites?.some((rhsType) => {
        // `any`/`unknown` writes are deliberately handled by the property's
        // own dynamic type. An `any` write in the generic Test262 descriptor
        // helper must not widen every concrete `{ value: ... }` literal that
        // happens to share that property name.
        if (rhsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        return typeMayCarryObjectValue(rhsType) && !ctx.checker.isTypeAssignableTo(rhsType, propType);
      }) ?? false;
    const receivesObjectCarrier =
      ctx.objectLiteralAssignedPropertyNames.has(prop.name) &&
      ((propType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
        hasIncompatibleObjectWrite ||
        nullishScalarSeed);
    if (
      receivesObjectCarrier &&
      (wasmType.kind === "ref" ||
        wasmType.kind === "ref_null" ||
        (wasmType.kind === "i32" && wasmType.boolean === true) ||
        nullishScalarSeed)
    ) {
      wasmType = { kind: "externref" };
    }
    // (#1468) `{ k: undefined }` makes TS infer the property's type as the
    // literal `undefined`. `mapTsTypeToWasm` maps that to i32 because for
    // function return types `undefined`/`void` indicate "no result". For a
    // struct *field* the property is a value slot, so i32 silently loses the
    // information that the slot holds `undefined`: codegen writes
    // `i32.const 0` (which the host reads back as `false`) and destructuring
    // defaults like `{ k = D }` never fire because the value isn't
    // observably undefined. Widening the field to externref lets the
    // existing `__get_undefined()` path in `compileExpression` preserve the
    // identity of `undefined`, which then trips `__extern_is_undefined` in
    // the destructuring default fast-path.
    //
    // Scope: only when the field's TS type is *exactly* the `undefined`
    // (or `void`) primitive — for `T | undefined` unions the union branch
    // in `mapTsTypeToWasm` already widens to externref / inner-T, so this
    // never affects them.
    if (
      wasmType.kind === "i32" &&
      (propType.flags & ts.TypeFlags.Undefined || propType.flags & ts.TypeFlags.Void) &&
      !(propType.flags & ts.TypeFlags.Boolean) &&
      !(propType.flags & ts.TypeFlags.BooleanLiteral) &&
      !(propType.flags & ts.TypeFlags.Number) &&
      !(propType.flags & ts.TypeFlags.NumberLiteral) &&
      !(propType.flags & ts.TypeFlags.ESSymbol) &&
      !(propType.flags & ts.TypeFlags.UniqueESSymbol)
    ) {
      wasmType = { kind: "externref" };
    }
    const callSigs = propType.getCallSignatures();
    // (#1589A) When the property's TS type has zero own properties (an empty
    // `{}` value) but resolveWasmType picked a `ref`/`ref_null` to a struct,
    // widen the field to externref. An empty object literal is constructed at
    // runtime as a host externref (`__new_plain_object`), not as a WasmGC
    // struct instance — so coercing it into a `ref null <struct>` field fails
    // the `ref.test` and stores `ref.null`. Reading the field back through
    // `__sget_<i>` then yields null, which (a) loses the value and (b) makes
    // `__extern_has_idx` report the property as absent, breaking spec
    // HasProperty (§7.3.12) for `Array.prototype.indexOf.call`-style loops.
    // Storing the value as externref preserves both the value and presence.
    // (`__Date` is the i64-timestamp struct, never an empty object literal.)
    if (
      (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
      callSigs.length === 0 &&
      propType.getProperties().length === 0
    ) {
      const refTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
      const refStructName = ctx.typeIdxToStructName.get(refTypeIdx);
      if (refStructName !== "__Date") {
        wasmType = { kind: "externref" };
      }
    }
    // For valueOf/toString callable properties, store as eqref instead of externref
    // so coercion can recover the closure and call it via call_ref
    if (wasmType.kind === "externref" && callSigs.length > 0 && (prop.name === "valueOf" || prop.name === "toString")) {
      wasmType = { kind: "eqref" };
    }
    fields.push({ name: prop.name, type: wasmType, mutable: true });
    if (callSigs.length > 0) {
      const sig = callSigs[0]!;
      // Include arity AND return-type signature in the hash key. Two object
      // literals like `{ valueOf() { return 42n } }` and
      // `{ valueOf() { throw ... } }` both have arity 0 but different return
      // types (i64 vs never/void). Without distinguishing them, the placeholder
      // method's typeIdx flips between the two, breaking trampolines.
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const retStr = retType ? ctx.checker.typeToString(retType) : "void";
      methodSigParts.push(`${prop.name}#${sig.parameters.length}->${retStr}`);
    }
  }

  // Structural dedup: O(1) hash-based lookup for matching anonymous struct fields.
  // This avoids creating duplicate struct types for the same shape when TS returns
  // different ts.Type objects (e.g. variable type vs. initializer type).
  const hashKey = fieldsHashKey(fields) + (methodSigParts.length > 0 ? "||" + methodSigParts.join(",") : "");
  const existingName = ctx.anonStructHash.get(hashKey);
  if (existingName) {
    ctx.anonTypeMap.set(tsType, existingName);
    return;
  }

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: field.type.typeIdx };
    }
  }

  const structName = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(structName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, structName);
  ctx.structFields.set(structName, fields);
  ctx.anonStructHash.set(hashKey, structName);
  ctx.anonTypeMap.set(tsType, structName);

  // Pre-register placeholder functions for callable properties (methods).
  // This ensures that struct method calls (e.g. obj.foo()) can resolve
  // the function index during the first pass, before the object literal's
  // method bodies are compiled in compileObjectLiteralForStruct.
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const callSigs = propType.getCallSignatures();
    if (callSigs.length === 0) continue;

    // Only pre-register methods that have a user-defined declaration
    // (MethodDeclaration or PropertyAssignment with function initializer in user code).
    // Skip inherited/prototype methods (toString, valueOf from Object.prototype)
    // and lib type method signatures, as they won't have a body to compile
    // in compileObjectLiteralForStruct.
    const decl = prop.valueDeclaration;
    if (!decl) continue;
    // Only pre-register MethodDeclaration — PropertyAssignment with function
    // initializers are compiled as closures (eqref fields), not direct calls,
    // so a placeholder function would never be filled and remain with an empty
    // body causing "stack for fallthru" validation errors.
    if (!ts.isMethodDeclaration(decl)) continue;
    // Also skip declarations from .d.ts files (lib types)
    const declSourceFile = decl.getSourceFile();
    if (declSourceFile && declSourceFile.isDeclarationFile) continue;

    const fullName = `${structName}_${prop.name}`;
    const methodKey = classMemberFuncKey(ctx, fullName); // (#1983) collision-free key + display name
    if (ctx.funcMap.has(methodKey)) continue; // already registered

    const sig = callSigs[0]!;
    // Build parameter types: self (ref $structTypeIdx) + declared params.
    // (#1671) This pre-registration is the CANONICAL `funcMap` entry that
    // direct calls `obj.method()` dispatch through. Its param types MUST match
    // what the method body actually compiles to in
    // `compileObjectLiteralForStruct` (search "methodParams" in literals.ts) —
    // applying the same default-init `ref→ref_null` widening AND the
    // binding-pattern `→externref` destructure widening (#1151 Gap B).
    // Otherwise the body-compile detects a signature mismatch, forks a
    // per-literal funcIdx, and leaves THIS canonical func an empty stub body —
    // so a direct `obj.method()` lands on the stub and traps
    // ("dereferencing a null pointer" / iterator "reading 'next' of null").
    const methodParams: ValType[] = [{ kind: "ref", typeIdx }];
    for (const param of sig.parameters) {
      const paramDecl = param.valueDeclaration;
      if (paramDecl && ts.isParameter(paramDecl)) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        let wasmType = resolveWasmType(ctx, pt);
        if (paramDecl.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        const hasBindingPattern = ts.isArrayBindingPattern(paramDecl.name) || ts.isObjectBindingPattern(paramDecl.name);
        if (hasBindingPattern && !paramDecl.type && !paramDecl.dotDotDotToken && wasmType.kind !== "externref") {
          wasmType = { kind: "externref" };
        }
        methodParams.push(wasmType);
      } else if (paramDecl) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        methodParams.push(resolveWasmType(ctx, pt));
      } else {
        methodParams.push({ kind: "f64" });
      }
    }
    // Check if this is a generator method (*method() { ... })
    const isGenMethod = ts.isMethodDeclaration(decl) && decl.asteriskToken !== undefined;
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const methodResults: ValType[] = isGenMethod
      ? [{ kind: "externref" }]
      : retType && !isVoidType(retType)
        ? [resolveWasmType(ctx, retType)]
        : [];

    const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
    // (#3024) STABLE handle (#1916 S3), not the legacy live-regime
    // `numImportFuncs + functions.length`. This pre-mint runs during the
    // DECLARATION SCAN (via the collectEmptyObjectWidening /
    // collectGrowableObjectLiterals pre-passes' resolveWasmType), BEFORE the
    // import collectors — a live index minted here goes stale the moment any
    // collector prepends an import without a fixup, and `definedFuncAt` then
    // fails to resolve it at literal-compile time, forking a duplicate method
    // body while trampolines keep forwarding into the stale (import-range)
    // index ("call[0] expected externref/f64, found …" — the Array.prototype
    // S15.4.4.x A2 valueOf cluster). A stable handle is layout-independent:
    // shift walkers skip it and resolution happens at emit.
    const methodFuncIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(methodKey, methodFuncIdx); // (#1983) relocated key

    const methodFunc: WasmFunction = {
      name: methodKey, // (#1983) display name matches relocated funcMap key for body-fill
      typeIdx: methodTypeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    pushDefinedFunc(ctx, methodFuncIdx, methodFunc);
  }
}

/**
 * Resolve a class member's PropertyName to a static string.
 * Handles identifiers, private identifiers, string literals, numeric literals,
 * and computed property names that can be evaluated at compile time.
 */

/**
 * Pre-pass: hoist all `var` declarations in a function body.
 * Walks statements recursively and pre-allocates a local for each `var`
 * variable not yet in localMap, so identifiers are valid before their
 * declaration site (JavaScript var-hoisting semantics).
 */
/**
 * (#2806) Does this variable binding require an **externref** slot because its
 * declared type is (only) `undefined` / `void`?
 *
 * Root cause of the compiled-acorn `CallExpression.arguments` drop: acorn writes
 * `var elt = (void 0); … elt = this.parseMaybeAssign(...); elts.push(elt)`. The
 * `void 0` EXPRESSION pins the binding to TS type `undefined` — UNLIKE
 * `var elt = undefined` / `var elt;`, which TS treats as evolving-any (→ `any`,
 * → externref). `resolveWasmType(undefined)` is a numeric (i32) slot, so a later
 * REFERENCE assignment is coerced to i32 `0` and the node ref is dropped.
 *
 * The fix routes a `void`-expression initializer through the SAME externref slot
 * that `= undefined` already gets — a correctness alignment, not new behaviour.
 * Used by BOTH the `var` hoister and the let/const declaration path so the slot
 * type is uniform (a `var` reuses its hoisted slot, so both sites MUST agree).
 *
 * IMPORTANT — the `void`-EXPRESSION arm triggers on the INITIALIZER ONLY, not on
 * a bare "purely `undefined`/`void` declared type". A binding can be
 * `undefined`-typed for unrelated reasons (e.g. `const afterA = obj.a` reading an
 * optional `a?: number` after `delete obj.a`), and those MUST stay a numeric slot
 * — the delete / optional-property machinery encodes `undefined` as an f64 sNaN
 * sentinel and relies on the local being f64/i32 so `afterA === undefined`
 * detects the sentinel. Forcing those to externref boxes the sentinel via
 * `__box_number` and breaks the `=== undefined` check (regressed
 * delete-sentinel #1112). The `void 0` expression is the precise, narrow signal
 * for the acorn evolving-local idiom.
 *
 * (#3033) SECOND arm — a member read off a DYNAMIC (externref) receiver whose
 * static type collapses to `undefined`. compiled-acorn's `pp$5.parseIdentNode`
 * does `var ty = this.type` where `this` is the Parser fnctor instance
 * (externref) but the checker — unable to resolve the untyped `this`'s shape —
 * types `this.type` as pure `undefined`. `resolveWasmType(undefined)` is a
 * numeric (i32) slot, so the RUNTIME value (a TokenType read dynamically through
 * `__extern_get`, returned as externref) was truncated to the i32
 * undefined-sentinel on store → `ty` read back `undefined`, and `x.var` (any
 * `<expr>.<keyword>` property name) threw. The read goes through the dynamic
 * host path (receiver externref) and returns externref, so the slot must be
 * externref to hold it. Distinguished from the #1112 sentinel case by the
 * receiver's wasm type: an optional field off a KNOWN struct receiver resolves
 * to `ref $struct` (NOT externref), so this arm does not fire for it and the
 * numeric sentinel is preserved. An externref slot holding a genuine runtime
 * `undefined` still compares `=== undefined` (the `emitUndefined` singleton), so
 * a dynamic read that really is undefined is unaffected.
 */
export function varBindingNeedsExternrefForUndefined(
  decl: ts.VariableDeclaration | undefined,
  ctx?: CodegenContext,
): boolean {
  // `var x = (void 0)` / `var x = void <expr>` — strip parens to find the void.
  let init = decl?.initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (ctx !== undefined && decl !== undefined && hoistedVarPreInitValueIsObserved(ctx, decl)) return true; // #4206
  if (init === undefined) return false;
  if (ts.isVoidExpression(init)) return true;
  // (ES5 defineProperty lane, #4491) `var r = f()` where f returns nothing:
  // the call's value IS `undefined` (§10.2.1.1 step 12 / OrdinaryCallEvaluateBody),
  // but a void-typed slot resolved f64 and stored the default 0 — so
  // `getFunc() === undefined` answered false everywhere the harness's
  // propertyHelper compares against a void helper's result. An externref slot
  // holds the canonical undefined carrier instead.
  if (ctx !== undefined && ts.isCallExpression(init)) {
    const callType = ctx.checker.getTypeAtLocation(init);
    if ((callType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0) return true;
  }
  // (#3033) Dynamic-receiver member read whose static type is purely undefined.
  if (ctx !== undefined && (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init))) {
    const declType = ctx.checker.getTypeAtLocation(decl!);
    const isPurelyUndefinedOrVoid = (declType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0;
    if (isPurelyUndefinedOrVoid && undefinedTypedMemberReadProducesExternref(ctx, init)) return true;
  }
  return false;
}

/**
 * (#3033 Bug 2a/2b) Shared predicate: a property/element access whose STATIC
 * type is purely `undefined`/`void` — the checker could not resolve the member
 * (untyped `this` receiver in a prototype-function, heterogeneous shapes, …) —
 * but whose RECEIVER produces an externref at runtime is a DYNAMIC member
 * read: its runtime value is externref, NOT the numeric undefined-sentinel
 * `resolveWasmType(undefined)` would give it. Recursive, so a CHAINED read
 * (`this.type.keyword` — Bug 2b) is recognized: the receiver `this.type` is
 * itself such a read. Used by BOTH the var/let slot typing
 * (`varBindingNeedsExternrefForUndefined`, Bug 2a) and the property-access
 * dynamic-receiver admission (`compilePropertyAccess` isExternObj, Bug 2b) so
 * the two stay in lockstep — no parallel branch.
 */
export function undefinedTypedMemberReadProducesExternref(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
  const t = ctx.checker.getTypeAtLocation(e);
  if ((t.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return false;
  const recvType = ctx.checker.getTypeAtLocation(e.expression);
  if (resolveWasmType(ctx, recvType).kind === "externref") return true;
  return undefinedTypedMemberReadProducesExternref(ctx, e.expression);
}

export function hoistVarDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForVars(ctx, fctx, stmt);
  }
}

/**
 * Walk a binding pattern and hoist all bound identifiers as locals.
 * Handles nested patterns: var { a, b: { c } } = obj; var [x, [y, z]] = arr;
 */
function hoistBindingPattern(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      // #1690b: do NOT skip allocation when the name collides with a module
      // global. This hoister only runs for nested function bodies; a `var`
      // declared anywhere inside a function must shadow any module-level
      // binding with the same name (ECMA-262 §10.2.10). Skipping left the
      // identifier resolver falling through to `global.get/set $__mod_<name>`,
      // so the inner destructured var aliased the module global.
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      const localIdx = allocLocal(fctx, name, wasmType);
      // Hoisted vars should be `undefined`, not `null` (#737)
      if (wasmType.kind === "externref") {
        emitUndefined(ctx, fctx);
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      hoistBindingPattern(ctx, fctx, element.name);
    }
  }
}

/**
 * Allocate TDZ flags for a let/const destructuring binding pattern so that
 * `let { x = x } = {}` and similar self/forward references in default
 * initializers throw ReferenceError per ECMA-262 §13.3.3.7 (#1128).
 *
 * Called from `compileObjectDestructuring` / `compileArrayDestructuring` at
 * entry — BEFORE the binding-element loop allocates the actual binding locals.
 * Only the TDZ flag is allocated here; the destructuring's own `allocLocal`
 * for the binding runs later (line ~648 of destructuring.ts) and registers
 * the binding name in `localMap`. By the time the default initializer is
 * compiled (after that `allocLocal`), `compileIdentifier` will see both
 * `localMap.has(name)` and `tdzFlagLocals.get(name)` and apply the TDZ check.
 *
 * The TDZ flag is allocated unconditionally for destructured bindings —
 * +1 i32 local per binding is cheap, and unconditionality avoids subtle
 * static-analysis gaps inside default initializers where `analyzeTdzAccess`
 * could otherwise mis-classify the access as "skip".
 */
export function ensureLetConstBindingPatternTdzFlags(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      // #1690b: do NOT skip when the name collides with a module global. This
      // runs only for nested function bodies, where a `let`/`const`
      // destructuring binding must shadow any module-level binding of the same
      // name (and carry its own TDZ flag) rather than aliasing the global.
      // Allocate the binding local up front if missing — needed so that when
      // a default initializer for a SIBLING binding compiles its expression,
      // a forward-reference to this binding (e.g. `let { a = b, b } = {}`)
      // resolves via `localMap.get(name)` and the TDZ check fires. Without
      // this, the forward-ref `b` falls through to the "undeclared globals"
      // path and silently returns a default value instead of throwing.
      if (!fctx.localMap.has(name)) {
        const elemType = ctx.checker.getTypeAtLocation(element);
        const wasmType = resolveWasmType(ctx, elemType);
        allocLocal(fctx, name, wasmType);
      }
      // Allocate TDZ flag if missing — zero-init (uninitialized).
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) {
        const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
        fctx.tdzFlagLocals.set(name, flagIdx);
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureLetConstBindingPatternTdzFlags(ctx, fctx, element.name);
    }
  }
}

/**
 * A bare `for (name in value)` assignment always writes a property key string
 * into `name`. Because `var` declarations are function-scoped, that write may
 * precede a later declaration whose initializer makes the checker infer a
 * numeric slot:
 *
 *   for (propName in config) { ... }
 *   var propName = arguments.length - 2;
 *
 * React's cloneElement has exactly this shape. Allocating `propName` as f64
 * coerces every enumerated key to NaN before the loop body can read it. Keep
 * the hoisted binding dynamic whenever the same symbol is a for-in target so
 * it can represent both the string keys and later values.
 */
function varBindingIsForInIdentifierTarget(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const bindingDeclaration = ctx.oracle.variableDeclarationOf(decl.name);
  if (!bindingDeclaration) return false;

  let root: ts.Node = decl.getSourceFile();
  for (let node: ts.Node | undefined = decl.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      root = (node as ts.Node & { body?: ts.Node }).body ?? node;
      break;
    }
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isForInStatement(node)) {
      let target: ts.Expression | ts.VariableDeclarationList = node.initializer;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target) && ctx.oracle.variableDeclarationOf(target) === bindingDeclaration) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Hoist a single variable declaration (handles both simple identifiers and binding patterns). */
function hoistVarDecl(ctx: CodegenContext, fctx: FunctionContext, decl: ts.VariableDeclaration): void {
  if (ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    if (fctx.localMap.has(name)) return;
    // #1690b: do NOT skip allocation when the name collides with a module
    // global. This hoister only runs for nested function bodies; per JS var
    // hoisting (ECMA-262 §10.2.10) a `var x` inside a function must allocate a
    // function-local that shadows any module-level `x`. The previous skip left
    // the resolver aliasing `global.get/set $__mod_x` for every read/write of
    // the inner `x`, so the function mutated the module global instead.
    const varType = ctx.checker.getTypeAtLocation(decl);
    // (#1239 / #1433) Object literals carrying get/set accessor declarations,
    // or `[Symbol.dispose]` / `[Symbol.asyncDispose]` computed methods, are
    // routed through the JS-host plain-object (externref) path. The local
    // must be allocated as externref so subsequent property reads/writes
    // bind to the host object, not a struct slot. Tag the var here so
    // resolveStructNameForExpr sees the override at every later access.
    let initForcesExternref = false;
    if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
      if (ctx.ordinaryToPrimitiveObjectDeclarations.has(decl)) {
        initForcesExternref = true;
      }
      // (#802 Slice A) A proto-receiver object literal is built as an open
      // `$Object` (externref, standalone-only) in compileObjectLiteral; the
      // hoisted `var` slot must be externref to match (mirrors the let/const path
      // in statements/variables.ts via ctx.dynamicProtoLiteralNodes).
      if (ctx.standalone && ctx.dynamicProtoLiteralNodes.has(decl.initializer)) {
        initForcesExternref = true;
      }
      for (const p of decl.initializer.properties) {
        if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          initForcesExternref = true;
          break;
        }
        if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) {
          const inner = p.name.expression;
          if (
            ts.isPropertyAccessExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === "Symbol" &&
            (inner.name.text === "dispose" || inner.name.text === "asyncDispose")
          ) {
            initForcesExternref = true;
            break;
          }
        }
      }
      // (#2804) A spread-containing object literal in a NON-SPECIFIC context
      // (no concrete contextual struct type — e.g. `var b = { ...a, z: 3 }`)
      // takes the host plain-object path (compileObjectLiteralWithAccessors),
      // building an externref `$Object`, NOT the closed struct TS infers. The
      // hoisted slot must be externref to match (else the value is ref.cast to
      // the inferred struct → read NaN/null). Mirrors the let/const path in
      // statements/variables.ts (objectLiteralSpreadTakesHostPath); inlined here
      // to avoid an index↔literals import cycle.
      if (!initForcesExternref && decl.initializer.properties.some((p) => ts.isSpreadAssignment(p))) {
        const spreadCtxType = ctx.checker.getContextualType(decl.initializer);
        const nonSpecificCtx =
          !spreadCtxType ||
          (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
          (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
          (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
          spreadCtxType.getProperties().length === 0;
        if (nonSpecificCtx) initForcesExternref = true;
      }
    }
    // (#684) Usage-narrowed f64 override for a boxed-`any` var — computed
    // separately so the entry-init below can seed NaN (see next comment).
    const forInTargetForcesExternref = varBindingIsForInIdentifierTarget(ctx, decl);
    if (forInTargetForcesExternref) {
      (fctx.forInIdentifierVars ??= new Set()).add(name);
    }
    let inferredArrayVecType: ValType | null = null;
    if (varType.flags & ts.TypeFlags.Object) {
      const symbol = (varType as ts.TypeReference).symbol ?? varType.symbol;
      if (symbol?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
        const isInitiallyEmptyArray =
          decl.initializer !== undefined &&
          ts.isArrayLiteralExpression(decl.initializer) &&
          decl.initializer.elements.length === 0;
        if (isInitiallyEmptyArray || (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any)) {
          inferredArrayVecType = inferArrayVecType(ctx, decl);
        }
      }
    }
    const mixedAssignmentCarrier = inferredArrayVecType === null && bindingHasMixedAssignmentCarrier(ctx, decl);
    if (mixedAssignmentCarrier) {
      (fctx.mixedAssignmentCarrierVars ??= new Set()).add(name);
    }
    // (#4121) `initForcesExternref` / `forInTargetForcesExternref` describe a
    // value the slot must physically hold, so they stay absolute. A
    // mixed-assignment demotion does not — a positive unboxing proof outranks
    // it (see `numericProofOverridesMixedCarrier`).
    const hardForcesExternref = initForcesExternref || forInTargetForcesExternref;
    const usageF64 = hardForcesExternref
      ? null
      : mixedAssignmentCarrier
        ? numericProofOverridesMixedCarrier(usageInferredLocalType(ctx, decl))
        : usageInferredLocalType(ctx, decl);
    const carrierForcesExternref = hardForcesExternref || (mixedAssignmentCarrier && usageF64 === null);
    let wasmType: ValType =
      inferredArrayVecType ??
      (carrierForcesExternref || isNullablePrimitiveType(varType) || varBindingNeedsExternrefForUndefined(decl, ctx)
        ? { kind: "externref" as const }
        : (usageF64 ?? resolveWasmType(ctx, varType)));
    // (#2660 S3b) A provably-monomorphic `var x = new F(...)` binding of an
    // approved fnctor gets the reserved struct slot instead of externref —
    // decision logic + admission proof in fnctor-typed-bindings.ts. Admission
    // guarantees no use can observe the pre-init value, so the `undefined`
    // entry seed below is safely skipped (a ref_null local defaults to null).
    if (wasmType.kind === "externref") {
      wasmType = resolveFnctorTypedBindingType(ctx, decl) ?? wasmType;
    }
    if (initForcesExternref) ctx.externrefAccessorVars.add(name);
    const localIdx = allocLocal(fctx, name, wasmType);
    // (#684) A hoisted `var` is `undefined` from function entry; when narrowed
    // to an f64 slot its entry value must be `ToNumber(undefined) === NaN`, NOT
    // the wasm default 0 — otherwise a read before the `var x = …`/`x = …`
    // assignment (JS var-hoisting) would observe 0 instead of NaN. Seed NaN at
    // entry, symmetric with the externref `emitUndefined` below.
    if (usageF64 && wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: NaN });
      fctx.body.push({ op: "local.set", index: localIdx });
      return;
    }
    // In JS, hoisted `var` variables are `undefined` before their declaration,
    // not `null`. For externref locals, emit __get_undefined() + local.set (#737).
    if (wasmType.kind === "externref") {
      // (#2106 S1 / PR-2) Under the `undefinedSingleton` regime `emitUndefined`
      // produces the NON-null tag-1 `$undefined` singleton. If this var's
      // declaration will retype the slot from externref to a concrete non-any
      // ref (standalone RegExp match array — the sole externref → ref hoist
      // retype), the later `local-set-coerce` fixup would `ref.cast_null`-trap on
      // that singleton ("illegal cast", the dominant flip-ON RegExp cluster). A
      // concrete-ref slot cannot represent the singleton anyway, so emit the
      // flag-OFF `ref.null.extern` value — it casts cleanly to `ref.null N`.
      // Byte-inert flag-OFF (the guard is false unless the regime is active).
      if (undefinedSingletonActive(ctx) && hoistedVarRetypesToConcreteRef(ctx, decl)) {
        fctx.body.push({ op: "ref.null.extern" });
      } else {
        emitUndefined(ctx, fctx);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
    return;
  }
  // Handle destructuring patterns: var { x, y } = obj; var [a, b] = arr;
  if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    hoistBindingPattern(ctx, fctx, decl.name);
  }
}

function walkStmtForVars(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Only hoist `var` (not let/const/using/await-using). #1177
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) return;
    for (const decl of list.declarations) {
      hoistVarDecl(ctx, fctx, decl);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForVars(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForVars(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
    // Hoist the loop variable for `for (var x in obj)` / `for (var x of arr)`
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isLabeledStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForVars(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForVars(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForVars(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForVars(ctx, fctx, s);
    }
  }
}

/**
 * Pre-pass: hoist all `let`/`const` declarations in a function body with TDZ flags.
 * Unlike var-hoisting (which makes variables immediately accessible), let/const
 * hoisting only pre-allocates the local + a TDZ flag so nested functions can
 * capture the variable. The variable is still in TDZ until the declaration runs.
 */
export function hoistLetConstWithTdz(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForLetConst(ctx, fctx, stmt);
  }
}

/**
 * Check if a let/const variable needs a TDZ flag by analyzing all references.
 * Returns false if every access to the symbol is provably after the declaration
 * in straight-line code (same function, no closures, loop-local safe).
 */
export function needsTdzFlag(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return true;
  const declEnd = decl.getEnd();
  const declFunc = getContainingFunctionForTdz(decl);

  // Collect all references to this symbol in the containing function
  // We walk the function body checking every identifier that resolves to this symbol
  const funcBody = declFunc && "body" in declFunc ? (declFunc as any).body : undefined;
  const scope = funcBody || decl.getSourceFile();

  let needsFlag = false;
  function visit(node: ts.Node): void {
    if (needsFlag) return;
    if (ts.isIdentifier(node) && node !== decl.name) {
      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym === symbol) {
        const accessPos = node.getStart();
        const accessFunc = getContainingFunctionForTdz(node);
        // Cross-function access (closure) — needs flag
        if (accessFunc !== declFunc) {
          needsFlag = true;
          return;
        }
        // Access before declaration — needs flag
        if (accessPos < declEnd) {
          needsFlag = true;
          return;
        }
        // Check loop safety: if access is inside a loop containing the decl,
        // it's only safe if decl is in the loop body and access is after decl
        if (isInsideLoopContainingForTdz(node, decl)) {
          needsFlag = true;
          return;
        }
      }
    }
    // Don't recurse into nested functions (they have their own scope)
    if (
      node !== scope &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      // But DO check if they reference our symbol (closure capture)
      forEachChild(node, visit);
      return;
    }
    forEachChild(node, visit);
  }
  forEachChild(scope, visit);
  return needsFlag;
}

/** Walk up to find nearest containing function (TDZ analysis version for index.ts). */
function getContainingFunctionForTdz(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Check if access is inside a loop containing decl (TDZ version for index.ts). */
function isInsideLoopContainingForTdz(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return false;
    }
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      if (isDescendantOfNode(decl, current)) {
        // For-initializer variables (e.g. `for (let i = 0; ...)`) are always
        // initialized before the body/condition/incrementor execute
        if (ts.isForStatement(current) && current.initializer && isDescendantOfNode(decl, current.initializer)) {
          return false;
        }
        // For-in/for-of loop variables are initialized each iteration
        if (
          (ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
          isDescendantOfNode(decl, current.initializer)
        ) {
          return false;
        }
        // Both in loop — check if decl is in loop body and access after decl
        const body = getLoopBodyNode(current);
        if (body && isDescendantOfNode(decl, body) && access.getStart() >= decl.getEnd()) {
          return false; // loop-local, access after decl — safe per iteration
        }
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isDescendantOfNode(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function getLoopBodyNode(loop: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(loop)) return loop.statement;
  if (ts.isForInStatement(loop)) return loop.statement;
  if (ts.isForOfStatement(loop)) return loop.statement;
  if (ts.isWhileStatement(loop)) return loop.statement;
  if (ts.isDoStatement(loop)) return loop.statement;
  return undefined;
}

function isVecStructType(ctx: CodegenContext, type: ValType | undefined): type is ValType & { typeIdx: number } {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  const def = ctx.mod.types[type.typeIdx];
  return def?.kind === "struct" && def.fields[0]?.name === "length" && def.fields[1]?.name === "data";
}

function stripRegExpInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticRegExpExpressionForInference(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripRegExpInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripRegExpInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    return decl?.initializer !== undefined && isStaticRegExpExpressionForInference(ctx, decl.initializer);
  }
  return false;
}

function nativeStringVecTypeForStandaloneRegExp(ctx: CodegenContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  // The match result is the match-vec SUBTYPE of the nstr vec (#1914) — the
  // precise local type keeps `.index`/`.input` reads cast-free while every
  // base-vec consumer still applies via subsumption.
  const vecTypeIdx = ensureRegexMatchVecType(ctx);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** True for the computed key `Symbol.match` (the @@match well-known symbol). */
function isSymbolMatchKeyForInference(arg: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    arg.expression.text === "Symbol" &&
    arg.name.text === "match"
  );
}

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    const method = unwrapped.expression.name.text;
    if (method === "exec") {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.expression.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    if (method === "match" && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.arguments[0]!)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    return null;
  }
  // `re[Symbol.match](s)` (#2161) — symbol-protocol dual of `s.match(re)`.
  if (ts.isElementAccessExpression(unwrapped.expression)) {
    const elem = unwrapped.expression;
    if (isSymbolMatchKeyForInference(elem.argumentExpression) && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, elem.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
  }
  return null;
}

function isStaticRegExpMatchArrayCallForImportScan(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const callee = stripRegExpInferenceWrapper(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (method === "exec") return isStaticRegExpExpressionForInference(ctx, callee.expression);
    if (method === "match" && call.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, call.arguments[0]!);
    }
    return false;
  }
  // `re[Symbol.match](s)` (#2161) — symbol-protocol dual of `s.match(re)`.
  if (ts.isElementAccessExpression(callee)) {
    if (isSymbolMatchKeyForInference(callee.argumentExpression) && call.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, callee.expression);
    }
  }
  return false;
}

export function isStandaloneRegExpMatchArrayValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripRegExpInferenceWrapper(expr);
  if (ts.isCallExpression(unwrapped)) return isStaticRegExpMatchArrayCallForImportScan(ctx, unwrapped);
  if (!ts.isIdentifier(unwrapped)) return false;
  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
  const initializer = decl?.initializer ? stripRegExpInferenceWrapper(decl.initializer) : undefined;
  return initializer !== undefined && ts.isCallExpression(initializer)
    ? isStaticRegExpMatchArrayCallForImportScan(ctx, initializer)
    : false;
}

function inferLetConstInitializerWasmType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!initializer) return null;
  // (#4376) Keep the authoritative pre-hoisted slot type in lockstep with
  // compileVariableStatement. A buffer-backed typed array is represented by a
  // shared-backing `$__ta_view`, not the checker-inferred plain vector. Nested
  // functions record their capture signatures before declaration lowering, so
  // missing this override made reifying a closure cast the real view value to
  // an unrelated vector type and trap during Deno core bootstrap.
  const taViewType = inferTaViewType(ctx, initializer);
  if (taViewType !== null) return taViewType;
  const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, initializer);
  if (standaloneRegExpMatchArrayType !== null) return standaloneRegExpMatchArrayType;

  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) {
    return null;
  }

  const methodName = unwrapped.expression.name.text;
  if (methodName !== "subarray" && methodName !== "slice") return null;

  const receiver = unwrapped.expression.expression;
  let receiverType: ValType | undefined;
  if (ts.isIdentifier(receiver)) {
    const localIdx = fctx.localMap.get(receiver.text);
    if (localIdx !== undefined) receiverType = getLocalType(fctx, localIdx);
    else {
      const globalIdx = ctx.moduleGlobals.get(receiver.text);
      if (globalIdx !== undefined) receiverType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    }
  }
  receiverType ??= resolveWasmType(ctx, ctx.checker.getTypeAtLocation(receiver));
  if (!isVecStructType(ctx, receiverType)) return null;
  // (#2357/#47) Standalone `subarray` produces a `$__subview` that shares the
  // parent's backing array (true aliasing). Resolving the binding to the subview
  // type here is what makes element access pick the windowed lowering at COMPILE
  // time (so plain-array `a[i]` stays zero-cost). `slice` still returns an
  // independent copy (a plain vec). The receiver may itself be a subview (nested
  // subarray) — its element kind is recovered from the base vec.
  if (methodName === "subarray" && (ctx.standalone || ctx.wasi)) {
    const recvIdx = (receiverType as { typeIdx: number }).typeIdx;
    // elemKind from the receiver's struct name: `__vec_<elem>` (plain typed array)
    // or `__subview_<elem>` (nested subarray over a subview).
    const recvName = ctx.typeIdxToStructName.get(recvIdx);
    const elemKind = recvName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
    if (elemKind !== undefined && elemKind !== recvName) {
      const svIdx = getOrRegisterSubviewType(ctx, elemKind);
      return { kind: "ref_null", typeIdx: svIdx };
    }
  }
  return { kind: "ref_null", typeIdx: receiverType.typeIdx };
}

/**
 * (#3123) When `varType` names a fnctor-subclass class (`class C extends F`,
 * F a top-level plain function), return the compiled class name; else
 * undefined. Class-expression synthetic names resolve through
 * `classExprNameMap` like the method-call ladder does.
 */
function fnctorSubclassNameOfType(ctx: CodegenContext, varType: ts.Type): string | undefined {
  let clsName = varType.getSymbol()?.name;
  if (clsName !== undefined && !ctx.classSet.has(clsName)) {
    clsName = ctx.classExprNameMap.get(clsName) ?? clsName;
  }
  if (clsName === undefined || !ctx.classSet.has(clsName)) return undefined;
  return fnctorAncestorOfClass(ctx, clsName) !== undefined ? clsName : undefined;
}

/**
 * (#3123) True when the let-binding `decl` (named `name`, declared as class
 * `clsName`) is re-assigned somewhere in its containing FUNCTION with a RHS
 * whose declared type is NOT that class — i.e. the slot can hold a foreign
 * (usually host-object) value at runtime. Oracle-based (#1930): the RHS type
 * name comes from `ctx.oracle.declaredNameOf`. Name-matched but scoped to the
 * SAME function (nested function bodies are not descended), so an inner
 * function's same-named binding cannot false-positive; same-function shadows
 * are already excluded by the pre-hoist caller (`localMap.has(name)` skip).
 */
function bindingHasForeignReassignment(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  name: string,
  clsName: string,
): boolean {
  const declFunc = getContainingFunctionForTdz(decl);
  const funcBody = declFunc && "body" in declFunc ? (declFunc as { body?: ts.Node }).body : undefined;
  const scope = funcBody ?? decl.getSourceFile();
  let foreign = false;
  const visit = (node: ts.Node): void => {
    if (foreign) return;
    // Do not descend into nested functions — their own `name` bindings are a
    // different variable (and a capture-reassignment of the outer binding is
    // out of this analysis' scope; the static-dispatch skip must not widen on
    // it because dynamic dispatch only covers the kind-export surface).
    if (
      node !== scope &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.left !== decl.name
    ) {
      let rhsName = ctx.oracle.declaredNameOf(node.right);
      if (rhsName !== undefined && !ctx.classSet.has(rhsName)) {
        rhsName = ctx.classExprNameMap.get(rhsName) ?? rhsName;
      }
      if (rhsName !== clsName) {
        foreign = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  if (scope) forEachChild(scope, visit);
  return foreign;
}

function walkStmtForLetConst(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Hoist `let`/`const`/`using` (not var — var is already hoisted).
    // `using`/`await using` declarations have the same TDZ semantics as
    // let/const per the explicit-resource-management spec — pre-decl access
    // must throw ReferenceError. (#1177)
    const TDZ_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;
    if (!(list.flags & TDZ_FLAGS)) return;
    for (const decl of list.declarations) {
      // #1210: skip declarations matched by detectStringBuilders — their
      // storage is replaced by a synthetic buffer triple at compile time.
      if (fctx.pendingStringBuilders?.has(decl)) continue;
      // #1886 Slice B: skip linear-backed `new Uint8Array(...)` bindings — their
      // storage is a synthetic (ptr,len) i32 pair set up at the declaration site
      // (see tryEmitLinearU8New), and the name is intentionally kept out of
      // localMap so reads route through `fctx.linearU8Buffers`. Pre-allocating a
      // GC `(ref null …)` local here would leave a dangling uninitialised local
      // (which the function finalizer then treats as a live value).
      if (
        ctx.linearUint8 &&
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isNewExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression) &&
        decl.initializer.expression.text === "Uint8Array"
      ) {
        const sym = ctx.checker.getSymbolAtLocation(decl.name);
        if (sym && ctx.linearUint8.safeBindings.has(sym) && isLinearU8RepresentableNew(ctx, decl.initializer)) {
          continue;
        }
      }
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        if (fctx.localMap.has(name)) continue;
        // #2641: do NOT skip names that collide with a module global. A
        // function-body let/const that shadows a same-named module variable
        // MUST get its own Wasm local (proper lexical shadowing). Previously
        // this `continue` suppressed the shadow, so every read/write of the
        // local fell through to the module global of the same name — invalid
        // Wasm with mismatched types (string-tree value → class-struct global,
        // the #2641 symptom) and a silent miscompilation (module var clobbered)
        // with matching types. This walker runs ONLY for real function bodies
        // (free functions and, after #2641, class methods/ctors); __module_init
        // does NOT run it, so top-level let/const still become module globals.
        const varType = ctx.checker.getTypeAtLocation(decl);
        // #1120: pre-allocate as i32 if collectI32CoercedLocals tagged this
        // local — keeps the hoisted slot in sync with what compileVariableStatement
        // will use, avoiding a slot-type mismatch on first assignment.
        const isI32Coerced =
          fctx.i32CoercedLocals?.has(name) === true && (varType.flags & ts.TypeFlags.NumberLike) !== 0;
        // (#1239) If the initializer is an object literal carrying get/set
        // accessor declarations, the variable holds a JS host object
        // (externref) — never the inferred wasmGC struct type. Tag here
        // BEFORE allocating the slot so the hoisted local type matches
        // what compileObjectLiteralWithAccessors will emit, and so
        // resolveStructNameForExpr lookups against this var bail out
        // immediately even from accesses earlier in compilation order.
        const initIsAccessorLiteral =
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          decl.initializer.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p));
        // (#2804) A spread-containing object literal in a NON-SPECIFIC context
        // (no concrete contextual struct type — e.g. `const b = { ...a, z: 3 }`)
        // is built as a host `$Object` (externref) by the literals.ts routing,
        // NOT the closed struct TS infers for the variable. This pre-hoist
        // allocator is the AUTHORITATIVE slot-typer for let/const (it runs
        // before compileVariableStatement), so the externref override MUST be
        // applied here too — otherwise the slot is the inferred struct and the
        // initializer's externref is ref.cast to it at runtime (cast fails →
        // `b.x` reads NaN/null). Mirrors statements/variables.ts; inlined to
        // avoid an index↔literals import cycle.
        let initIsHostSpreadLiteral = false;
        if (
          !initIsAccessorLiteral &&
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          decl.initializer.properties.some((p) => ts.isSpreadAssignment(p))
        ) {
          const spreadCtxType = ctx.checker.getContextualType(decl.initializer);
          initIsHostSpreadLiteral =
            !spreadCtxType ||
            (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
            (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
            (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
            spreadCtxType.getProperties().length === 0;
        }
        // (#802 Slice A) A proto-receiver object literal is promoted to an open
        // `$Object` (externref) by compileObjectLiteral. This pre-hoist allocator
        // is the AUTHORITATIVE let/const slot-typer, so the externref override
        // MUST be applied here too — otherwise the slot is the inferred struct and
        // the promoted `$Object` externref is ref.cast to it at runtime (cast
        // fails → the receiver goes null and `o.x`/inherited reads return NaN).
        // Registers the name in externrefAccessorVars so reads route through the
        // dynamic `__extern_get` path. Standalone-only (gc/host keeps its existing
        // closed-struct + host-sidecar path unchanged).
        const initIsProtoReceiverLiteral =
          ctx.standalone &&
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          ctx.dynamicProtoLiteralNodes.has(decl.initializer);
        // (#4376) Keep the authoritative pre-hoisted slot in lockstep with
        // compileVariableStatement/compileObjectLiteral for a binding whose
        // object later receives out-of-shape or runtime-keyed writes. Without
        // this override a hoisted nested function records the capture as the
        // literal's inferred closed struct, while the declaration correctly
        // builds and stores an open `$Object` externref. Reifying that function
        // then casts the externref capture back to the unrelated struct and
        // traps (Deno's `registerErrorClass` capturing `errorConstructors`).
        const initIsGrowableObjectLiteral =
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          ctx.growableObjectLiteralVars.has(name);
        const initIsOrdinaryToPrimitiveObjectLiteral = ctx.ordinaryToPrimitiveObjectDeclarations.has(decl);
        const initForcesExternref =
          initIsAccessorLiteral ||
          initIsHostSpreadLiteral ||
          initIsGrowableObjectLiteral ||
          initIsOrdinaryToPrimitiveObjectLiteral ||
          initIsProtoReceiverLiteral;
        if (initForcesExternref) {
          ctx.externrefAccessorVars.add(name);
        }
        const mixedAssignmentCarrier = bindingHasMixedAssignmentCarrier(ctx, decl);
        // (#4121) Mirror of the declaration cascade in statements/variables.ts:
        // a positive unboxing proof outranks the mixed-assignment demotion, and
        // resolves to `f64` HERE so the pre-hoisted slot and the declaration
        // agree (the `isI32Coerced` arm below is not licensed by that proof).
        const mixedCarrierProvenF64 = mixedAssignmentCarrier
          ? numericProofOverridesMixedCarrier(usageInferredLocalType(ctx, decl))
          : null;
        const carrierForcesExternref = initForcesExternref || (mixedAssignmentCarrier && !mixedCarrierProvenF64);
        let wasmType: ValType = carrierForcesExternref
          ? { kind: "externref" }
          : mixedCarrierProvenF64
            ? mixedCarrierProvenF64
            : isI32Coerced
              ? { kind: "i32" }
              : isNullablePrimitiveType(varType)
                ? { kind: "externref" }
                : (inferLetConstInitializerWasmType(ctx, fctx, decl.initializer) ??
                  usageInferredLocalType(ctx, decl) ??
                  resolveWasmType(ctx, varType));
        // (#3123) A let-binding declared as a FNCTOR-SUBCLASS class instance
        // (`class C extends F`, F a top-level plain function) that is
        // REASSIGNED with another static type can hold a HOST object at
        // runtime (`iterator = iterator.drop(0)` — the Iterator-helper
        // wrapper minted by F's live prototype methods). A `(ref $C)` slot
        // would NULL that host value through the guarded cast — widen the
        // slot to externref and record the name so the method-call ladder
        // dispatches on it dynamically. Host lane only (standalone has no
        // host objects to hold). Typed use sites still recover the struct
        // through their own guarded casts, so a never-host value is
        // unaffected beyond the extra cast.
        if (
          (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
          !ctx.standalone &&
          !ctx.wasi &&
          (list.flags & ts.NodeFlags.Let) !== 0
        ) {
          const fnctorCls = fnctorSubclassNameOfType(ctx, varType);
          if (fnctorCls !== undefined && bindingHasForeignReassignment(ctx, decl, name, fnctorCls)) {
            wasmType = { kind: "externref" };
            (fctx.fnctorWidenedLocals ??= new Set()).add(name);
          }
        }
        // (#2660 S3b) A provably-monomorphic `let/const x = new F(...)` of an
        // approved fnctor gets the reserved struct slot instead of externref.
        // This allocator is the AUTHORITATIVE let/const slot-typer, so the
        // retype must land here; compileVariableStatement applies the same
        // (cached) verdict so the two agree. See fnctor-typed-bindings.ts.
        if (wasmType.kind === "externref") {
          wasmType = resolveFnctorTypedBindingType(ctx, decl) ?? wasmType;
        }
        const valueSlot = allocLocal(fctx, name, wasmType);
        // (#2814) Record the pre-hoisted slot for THIS declaration so
        // compileVariableStatement can reuse it when saveBlockScopedShadows later
        // deletes the block-let's own slot (the duplicate-local desync — Bug C).
        // Recorded only here, i.e. only for names the pre-pass actually allocated
        // (absent from localMap ⇒ no outer/param/var shadow). Genuine shadows are
        // skipped above (the `localMap.has(name)` continue) and never recorded.
        if (!fctx.preHoistedLetConstSlots) fctx.preHoistedLetConstSlots = new Map();
        const preHoistRecord: { valueSlot: number; flagSlot?: number } = { valueSlot };
        fctx.preHoistedLetConstSlots.set(decl, preHoistRecord);
        // Only add TDZ flag if static analysis can't prove all accesses are safe
        if (needsTdzFlag(ctx, decl)) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
          fctx.tdzFlagLocals.set(name, flagIdx);
          preHoistRecord.flagSlot = flagIdx;
        }
      }
      if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        // A nested function declaration is hoisted before statement-position
        // destructuring runs. Publish the pattern's binding locals now, just as
        // we do for identifier let/const declarations, so capture signatures
        // cannot be inferred from a missing or same-name stale slot. The shared
        // helper and the later destructuring path both reuse existing locals
        // and TDZ flags, so this does not allocate a second binding.
        ensureLetConstBindingPatternTdzFlags(ctx, fctx, decl.name);
      }
    }
    return;
  }
  // Recurse into block-like structures (but NOT into nested functions)
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForLetConst(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForLetConst(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForLetConst(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    // Do NOT pre-allocate for-loop let/const initializer variables here.
    // compileForStatement handles their allocation with correct types (e.g. i32
    // for integer loop counters). Pre-allocating here would create duplicate
    // locals: one f64 from the pre-pass, one i32 from codegen — see #954.
    // The loop body may still declare let/const variables, so recurse into it.
    walkStmtForLetConst(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForLetConst(ctx, fctx, s);
    }
  }
}

/**
 * Check if a function body references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
export function cacheStringLiterals(ctx: CodegenContext, fctx: FunctionContext): void {
  // Build a set of funcIdx values that correspond to string literal thunks
  const strFuncIdxSet = new Set<number>();
  for (const [, importName] of ctx.stringLiteralMap) {
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) strFuncIdxSet.add(funcIdx);
  }
  if (strFuncIdxSet.size === 0) return;

  // Collect all unique string-thunk funcIdx values used in the body
  const usedFuncIdxs = new Set<number>();
  collectStringCalls(fctx.body, strFuncIdxSet, usedFuncIdxs);
  if (usedFuncIdxs.size === 0) return;

  // Allocate a local for each unique string thunk and build the mapping
  const cacheMap = new Map<number, number>(); // funcIdx → local index
  for (const funcIdx of usedFuncIdxs) {
    const localIdx = allocLocal(fctx, `__cached_str_${funcIdx}`, {
      kind: "externref",
    });
    cacheMap.set(funcIdx, localIdx);
  }

  // Build the cache-loading preamble (call + local.set for each)
  const preamble: Instr[] = [];
  for (const [funcIdx, localIdx] of cacheMap) {
    preamble.push({ op: "call", funcIdx });
    preamble.push({ op: "local.set", index: localIdx });
  }

  // Replace all matching call instructions in the body with local.get
  replaceStringCalls(fctx.body, cacheMap);

  // Prepend the preamble at the start of the body
  fctx.body.unshift(...preamble);
}

/** Recursively scan instructions to find call instructions targeting string thunks. */
function collectStringCalls(instrs: Instr[], strFuncIdxSet: Set<number>, found: Set<number>): void {
  for (const instr of instrs) {
    if ((instr.op === "call" || instr.op === "return_call") && strFuncIdxSet.has(instr.funcIdx)) {
      found.add(instr.funcIdx);
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
    } else if (instr.op === "if") {
      collectStringCalls(instr.then, strFuncIdxSet, found);
      if (instr.else) collectStringCalls(instr.else, strFuncIdxSet, found);
    } else if (instr.op === "try") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
      for (const c of instr.catches) {
        collectStringCalls(c.body, strFuncIdxSet, found);
      }
      if (instr.catchAll) collectStringCalls(instr.catchAll, strFuncIdxSet, found);
    }
  }
}

/** Recursively replace call instructions matching the cache map with local.get. */
function replaceStringCalls(instrs: Instr[], cacheMap: Map<number, number>): void {
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if ((instr.op === "call" || instr.op === "return_call") && cacheMap.has(instr.funcIdx)) {
      // Replace in-place: swap the call with a local.get
      const localIdx = cacheMap.get(instr.funcIdx)!;
      (instrs as any)[i] = { op: "local.get", index: localIdx };
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
      replaceStringCalls(instr.body, cacheMap);
    } else if (instr.op === "if") {
      replaceStringCalls(instr.then, cacheMap);
      if (instr.else) replaceStringCalls(instr.else, cacheMap);
    } else if (instr.op === "try") {
      replaceStringCalls(instr.body, cacheMap);
      for (const c of instr.catches) {
        replaceStringCalls(c.body, cacheMap);
      }
      if (instr.catchAll) replaceStringCalls(instr.catchAll, cacheMap);
    }
  }
}

/**
 * Unwrap Generator<T> return type to get the yield element type T.
 * Falls back to externref if the type cannot be unwrapped.
 */
export function unwrapGeneratorYieldType(type: ts.Type, ctx: CodegenContext): ValType {
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Generator") {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Also check Iterator and IterableIterator
  if (symbol && (symbol.name === "Iterator" || symbol.name === "IterableIterator")) {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Fallback: assume number yield type (most common case)
  return { kind: "f64" };
}

/**
 * Ensure the stack top is an i32 suitable for use as a condition.
 * Handles: f64 (truthy != 0), externref (JS truthiness via __is_truthy), null (push 0).
 */
export function ensureI32Condition(fctx: FunctionContext, condType: ValType | null, ctx?: CodegenContext): void {
  if (ctx) {
    // #1917 — the canonical ToBoolean cascade is now the single coercion engine.
    // (Behaviour-neutral: the engine's rows are transcribed from this body.)
    emitToBoolean(ctx, condType, fctx.body);
    return;
  }
  // No ctx available (a few legacy callers) — keep the ctx-free subset inline:
  // the engine's helper-call arms (__is_truthy / __any_unbox_bool / __str_flatten)
  // need ctx, so without it fall back to the same non-null / scalar handling the
  // old body used in that case.
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (condType.kind === "externref" || condType.kind === "ref" || condType.kind === "ref_null") {
    // Fallback: non-null → true (no ctx → no helper imports available).
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "i64") {
    fctx.body.push({ op: "i64.eqz" });
    fctx.body.push({ op: "i32.eqz" });
  }
  // i32 is already valid as-is
}

export { popBody, pushBody } from "./context/bodies.js";
export { createCodegenContext } from "./context/create-context.js";
export { reportError } from "./context/errors.js";
export { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
export { attachSourcePos, getSourcePos } from "./context/source-pos.js";
export type {
  ClosureInfo,
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  ExternClassInfo,
  FunctionContext,
  InlinableFunctionInfo,
  OptionalParamInfo,
  RestParamInfo,
} from "./context/types.js";
export {
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  nextModuleGlobalIdx,
  // #808 — re-exported from registry/imports.ts so existing `from "./index.js"`
  // importers across the codebase keep resolving after the extraction.
  addStringImports,
  addUnionImports,
  addIteratorImports,
  addArrayIteratorImports,
  addGeneratorImports,
  addForInImports,
} from "./registry/imports.js";
export {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterBoundFnType,
  getOrRegisterRefCellType,
  getOrRegisterResizableAbType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
export { compileExpression, compileStatement } from "./shared.js";
