// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import ts from "typescript";

export type SourceReader = (path: string) => string;
export const liveSourceReader =
  (root: string): SourceReader =>
  (path) =>
    readFileSync(resolve(root, path), "utf8");

// Current source-qualified census, independently pinned before reconstruction.
// Overloads are records too: kind/name/occurrence and source order must agree.
// No discovery, sorting, name search, Git fallback or existence-based omission.
const preClockOwnerOrder: Readonly<Record<string, readonly string[]>> = {
  "src/ir/runtime/contracts/intrinsics.ts": [
    "var:PURE_MATH_RUNTIME_FEATURES#0",
    "var:NUMERIC_COERCION_RUNTIME_FEATURES#0",
    "var:NUMBER_BOUNDARY_RUNTIME_FEATURES#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_FEATURES#0",
    "var:EXTERN_BOUNDARY_RUNTIME_FEATURES#0",
    "var:INTRINSIC_RUNTIME_FEATURES#0",
    "type:PureMathRuntimeFeature#0",
    "type:NumericCoercionRuntimeFeature#0",
    "type:NumberBoundaryRuntimeFeature#0",
    "type:BooleanBoundaryRuntimeFeature#0",
    "type:ExternBoundaryRuntimeFeature#0",
    "type:RuntimeFeature#0",
    "var:PURE_MATH_HOST_CAPABILITIES#0",
    "type:HostCapability#0",
    "type:IntrinsicDefinition#0",
  ],
  "src/ir/core/intrinsic-contracts.ts": [
    "interface:IntrinsicSignature#0",
    "interface:IntrinsicSourceLocation#0",
    "interface:IntrinsicUse#0",
    "interface:IntrinsicDefinition#0",
    "type:IntrinsicVerificationCode#0",
    "interface:IntrinsicVerificationFailure#0",
  ],
  "src/ir/core/intrinsics.ts": [
    "var:F64_TYPE#0",
    "var:I32_TYPE#0",
    "var:U32_TYPE#0",
    "var:EXTERNREF_TYPE#0",
    "var:F64_TO_EXTERNREF_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_TO_F64_INTRINSIC_SIGNATURE#0",
    "var:I32_TO_EXTERNREF_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_TO_I32_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE#0",
    "var:REF_EXTERN_TYPE#0",
    "var:EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE#0",
    "var:EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE#0",
    "var:F64_TO_U32_INTRINSIC_SIGNATURE#0",
    "var:F64_UNARY_INTRINSIC_SIGNATURE#0",
    "var:F64_BINARY_INTRINSIC_SIGNATURE#0",
    "function:definition#0",
    "var:INTRINSIC_DEFINITIONS#0",
    "var:INTRINSIC_ID_SET#0",
    "function:isIntrinsicId#0",
  ],
  "src/ir/analysis/intrinsics.ts": [
    "class:IntrinsicEffectEvidence#0",
    "function:intrinsicEffectEvidence#0",
    "function:signatureMismatch#0",
    "function:verifyIntrinsicUse#0",
    "function:verifyIrIntrinsicSignature#0",
  ],
  "src/ir/core/async-intents.ts": [
    "var:ASYNC_RUNTIME_FEATURES#0",
    "var:ASYNC_OPTIONAL_RUNTIME_FEATURES#0",
    "type:AsyncRuntimeFeature#0",
    "var:ASYNC_RUNTIME_FEATURE_SET#0",
    "function:isAsyncRuntimeFeature#0",
  ],
  "src/ir/runtime/async-providers.ts": [
    "var:ASYNC_HOST_CAPABILITY_ID_SET#0",
    "function:isAsyncHostCapabilityId#0",
    "function:asAsyncHostAdapter#0",
    "var:ASYNC_HOST_CAPABILITY_RECORDS#0",
    "function:assertAsyncHostCapabilityRecord#0",
    "function:assertCanonicalAsyncHostCapabilityRecord#0",
    "function:resolveAsyncHostCapabilityRecord#0",
    "function:isPreparedAsyncHostCapabilityId#0",
    "function:asPreparedAsyncHostAdapter#0",
    "function:assertCanonicalPreparedAsyncHostCapabilityRecord#0",
    "var:ASYNC_HOST_ADAPTERS#0",
    "var:ASYNC_OPTIONAL_HOST_ADAPTERS#0",
    "function:capabilities#0",
    "var:HOST_TARGET#0",
    "var:STANDALONE_TARGET#0",
    "var:WASMGC_BACKEND#0",
    "var:NO_DEPENDENCIES#0",
    "var:NO_HOST_CAPABILITIES#0",
    "var:HOST_CAPABILITY_IMPLEMENTATION#0",
    "var:HOST_MANAGED_IMPLEMENTATION#0",
    "var:NATIVE_MANAGED_IMPLEMENTATION#0",
    "function:provider#0",
    "function:nativeProvider#0",
    "var:ASYNC_RUNTIME_PROVIDERS#0",
  ],
  "src/ir/runtime/manifest.ts": [
    "function:projectRuntimeBackendRequirements#0",
    "type:RuntimeManifestInvariantCode#0",
    "class:RuntimeManifestInvariantError#0",
    "var:ALL_TARGETS#0",
    "var:ALL_BACKENDS#0",
    "var:RUNTIME_FEATURE_SIGNATURES#0",
    "function:provider#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDERS#0",
    "function:numberBoundaryProvider#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDERS#0",
    "function:stringCompareProviderId#0",
    "var:STRING_COMPARE_FEATURE_SET#0",
    "function:isStringCompareFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDERS#0",
    "function:stringEqProviderId#0",
    "var:STRING_EQ_FEATURE_SET#0",
    "function:isStringEqFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDERS#0",
    "function:stringLenProviderId#0",
    "var:STRING_LEN_FEATURE_SET#0",
    "function:isStringLenFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatProviderId#0",
    "var:STRING_CONCAT_FEATURE_SET#0",
    "function:isStringConcatFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDERS#0",
    "function:stringCharCodeAtProviderId#0",
    "var:STRING_CHAR_CODE_AT_FEATURE_SET#0",
    "function:isStringCharCodeAtFeature#0",
    "function:stringConcatManyProviderId#0",
    "var:STRING_CONST_RUNTIME_PROVIDERS#0",
    "function:stringConstProviderId#0",
    "var:STRING_CONST_FEATURE_SET#0",
    "function:isStringConstFeature#0",
    "var:STRING_CONCAT_MANY_FEATURE_SET#0",
    "function:isStringConcatManyFeature#0",
    "function:stringConcatManyArityCap#0",
    "function:generatorNumberBoxProviderId#0",
    "var:GENERATOR_NUMBER_BOX_FEATURE_SET#0",
    "function:isGeneratorNumberBoxFeature#0",
    "function:booleanBoundaryProviderId#0",
    "var:BOOLEAN_BOUNDARY_FEATURE_SET#0",
    "function:isBooleanBoundaryFeature#0",
    "function:externIsUndefinedProviderId#0",
    "var:EXTERN_BOUNDARY_FEATURE_SET#0",
    "function:isExternBoundaryFeature#0",
    "function:numberBoundaryProviderId#0",
    "var:NUMBER_BOUNDARY_FEATURE_SET#0",
    "function:isNumberBoundaryFeature#0",
    "var:PROVIDERS_BY_FEATURE#0",
    "var:PURE_MATH_RUNTIME_PROVIDERS#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS#0",
    "function:hostCallbackWrapProviderId#0",
    "var:HOST_CALLBACK_WRAP_FEATURE_SET#0",
    "function:isHostCallbackWrapFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS#0",
    "function:functionPrototypeCallProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_FEATURE_SET#0",
    "function:isFunctionPrototypeCallFeature#0",
    "var:RUNTIME_PROVIDERS#0",
    "var:FEATURE_SET#0",
    "var:PROVIDER_ID_SET#0",
    "var:HOST_CAPABILITY_ID_SET#0",
    "var:TARGET_SET#0",
    "var:BACKEND_SET#0",
    "function:isRuntimeFeature#0",
    "function:compareStrings#0",
    "function:signatureEquals#0",
    "function:cloneProvider#0",
    "function:cycleKey#0",
    "function:useOrder#0",
    "function:stronglyConnectedComponents#0",
    "function:buildProviderComponents#0",
    "interface:RuntimeManifestBuilderOptions#0",
    "type:BuilderState#0",
    "class:RuntimeManifestBuilder#0",
  ],
  "src/ir/analysis/async-plan.ts": [
    "function:asAsyncStateId#0",
    "function:asAsyncHandlerId#0",
    "function:canonicalPromiseAbi#0",
    "type:IrAsyncPlanInvariantCode#0",
    "interface:IrAsyncPlanVerifyError#0",
    "class:IrAsyncPlanInvariantError#0",
    "interface:StateLiveness#0",
    "interface:StateEdge#0",
    "var:runtimeIntentOrder#0",
    "var:runtimeIntentRank#0",
    "function:isNonNegativeSafeInteger#0",
    "function:compareNumber#0",
    "function:sameValueSet#0",
    "function:describeValues#0",
    "function:terminatorUses#0",
    "function:stateUpdates#0",
    "function:updateMap#0",
    "function:stateEdges#0",
    "function:stateLiveness#0",
    "function:addPurityError#0",
    "function:verifyPureData#0",
    "function:addError#0",
    "type:AsyncValueChecker#0",
    "function:verifyResumeIncomingEdges#0",
    "function:verifySpillUpdates#0",
    "function:verifyCanonicalPromiseAbi#0",
    "function:irAsyncPlanNeedsNumberBridge#0",
    "function:requiredRuntimeIntents#0",
    "function:verifyIrAsyncPlan#0",
    "function:assertIrAsyncPlan#0",
    "function:clonePlanData#0",
    "function:canonicalPlanInput#0",
    "function:createIrAsyncPlan#0",
    "function:canonicalJson#0",
    "function:serializeIrAsyncPlan#0",
    "function:hashIrAsyncPlan#0",
  ],
  "src/ir/runtime/async-attachment.ts": [
    "var:preparedManifestByPlan#0",
    "function:runtimeAttachmentError#0",
    "function:sameOrderedStrings#0",
    "function:expectedAsyncProviders#0",
    "function:assertFrozenProvider#0",
    "function:freezePreparedIrAsyncStateBody#0",
    "function:isPreparedIrAsyncStateBodyFrozen#0",
    "function:sealPreparedIrAsyncStates#0",
    "function:assertPreparedIrAsyncRuntimeCurrent#0",
    "function:createPreparedIrAsyncRuntime#0",
    "function:sealPreparedIrAsyncRuntimeContainers#0",
    "function:preparedIrAsyncFrameCapabilityFailure#0",
  ],
  "src/ir/intrinsic-support.ts": [
    "function:projectStandaloneAsyncStateInstr#0",
    "function:mapArray#0",
    "function:valueTypesOf#0",
    "function:providerAttachment#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURE#0",
    "function:preparedGeneratorNumberBoxProvider#0",
    "var:STRING_COMPARE_RUNTIME_FEATURE#0",
    "function:preparedStringCompareProvider#0",
    "var:STRING_EQ_RUNTIME_FEATURE#0",
    "function:preparedStringEqProvider#0",
    "var:STRING_LEN_RUNTIME_FEATURE#0",
    "function:preparedStringLenProvider#0",
    "var:STRING_CONCAT_RUNTIME_FEATURE#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatFeatureFor#0",
    "function:preparedStringConcatProvider#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURE#0",
    "function:preparedStringCharCodeAtProvider#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURE#0",
    "function:preparedStringConcatManyProvider#0",
    "var:STRING_CONST_RUNTIME_FEATURE#0",
    "var:STRING_CONST_UTF16_RUNTIME_FEATURE#0",
    "function:stringConstFeatureFor#0",
    "function:preparedStringConstProvider#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURE#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE#0",
    "function:preparedHostCallbackWrapProvider#0",
    "function:preparedFunctionPrototypeCallProvider#0",
    "function:sameProvider#0",
    "function:attachProvidersToBuffer#0",
    "function:attachProviders#0",
    "interface:IrRuntimeManifestDemands#0",
    "interface:PrepareIrRuntimeManifestInput#0",
    "class:IrRuntimeFunctionPreparationError#0",
    "function:prepareIrRuntimeManifest#0",
    "function:prepareIrRuntimeManifest#1",
    "function:prepareIrRuntimeManifest#2",
  ],
  "src/ir/runtime/intrinsic-verification.ts": [
    "var:BACKEND_COMPOSITE_BY_INTRINSIC#0",
    "function:callableBindingKey#0",
    "var:ADMITTED_CALLABLE_TARGETS#0",
    "function:verifyIrIntrinsicInstruction#0",
  ],
  "src/ir/runtime/host-capabilities.ts": [
    "var:RUNTIME_HOST_CAPABILITY_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_EXPORT_ID_SET#0",
    "function:isRuntimeHostCapabilityId#0",
    "function:isRuntimeHostCapabilityFuncId#0",
    "function:isRuntimeHostCapabilityFuncFamilyId#0",
    "function:isRuntimeHostCapabilityGlobalId#0",
    "function:isRuntimeHostCapabilityExportId#0",
    "var:RUNTIME_HOST_CAPABILITY_VALUE_TYPES#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_GLOBAL_MODULE_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_KIND_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FIELD_SCHEME_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEME_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATION_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VAR_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_HOST_SELECTION_SET#0",
    "var:RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY#0",
    "interface:RuntimeHostCapabilityFuncOptions#0",
    "function:funcRecord#0",
    "function:freezeHostSelection#0",
    "function:record#0",
    "function:funcFamilyRecord#0",
    "function:exportRecord#0",
    "function:globalRecord#0",
    "var:RUNTIME_HOST_CAPABILITY_RECORDS#0",
    "var:RECORD_BY_ID#0",
    "var:CANONICAL_RECORDS#0",
    "function:compareCapabilityRecords#0",
    "function:describeRecord#0",
    "function:assertExactKeys#0",
    "function:assertValueTypes#0",
    "function:assertRuntimeHostCapabilityRecord#0",
    "function:assertHostSelection#0",
    "function:assertExportCapabilityRecord#0",
    "function:assertFuncFamilyCapabilityRecord#0",
    "function:assertGlobalCapabilityRecord#0",
    "function:assertCanonicalRuntimeHostCapabilityRecord#0",
    "function:asCallableRuntimeHostCapabilityRecord#0",
    "function:canonicalizeRuntimeHostCapabilityCatalog#0",
    "function:resolveRuntimeHostCapabilityRecord#0",
    "function:resolveRuntimeHostCapabilityFuncFamilyRecord#0",
    "function:resolveRuntimeHostCapabilityGlobalRecord#0",
    "function:resolveRuntimeHostCapabilityExportRecord#0",
    "function:resolveRuntimeHostCapabilityFuncRecord#0",
    "var:HOST_CALLBACK_WRAP_CAPABILITY_RECORD#0",
  ],
  "src/ir/runtime/callable-declarations.ts": [
    "interface:IrRuntimeCallableDeclaration#0",
    "function:semanticTypes#0",
    "var:referenceError#0",
    "var:REFERENCE_ERROR_DECLARATION#0",
    "var:REFERENCE_ERROR_SIGNATURE#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDERS#0",
    "function:irRuntimeCallableDeclaration#0",
  ],
  "src/ir/core/async-callables.ts": [
    "var:IR_NATIVE_PROMISE_DELAY_FN#0",
    "var:IR_ASYNC_PROMISE_ALL_NATIVE_FN#0",
    "var:IR_ASYNC_CLOCK_SNAPSHOT_FN#0",
    "var:IR_ASYNC_NUMBER_TO_STRING_FN#0",
    "var:IR_ASYNC_CONSOLE_LOG_STRING_FN#0",
    "var:IR_ASYNC_STRING_CONCAT_5_FN#0",
  ],
  "src/ir/runtime/native-async-callables.ts": [
    "var:F64#0",
    "var:EXTERNREF#0",
    "var:PROMISE#0",
    "var:STRING#0",
    "var:PROMISE_VECTOR#0",
    "function:declaration#0",
    "var:NATIVE_ASYNC_CALLABLE_DECLARATIONS#0",
    "function:irNativeAsyncCallableDeclaration#0",
    "function:irRuntimeCallableHasNoSlot#0",
    "var:PROMISE_DEPENDENCIES#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS#0",
    "function:nativeAsyncProviderMismatch#0",
    "function:nativeAsyncCallablePolicyMismatch#0",
    "class:IrNativeAsyncCallableError#0",
    "interface:IrNativeAsyncCallableDemand#0",
    "function:buffers#0",
    "function:nativeAsyncCallableValueTypes#0",
    "function:nativeAsyncCallMismatch#0",
    "function:collectNativeAsyncCallableDemands#0",
    "function:assertNativeAsyncCallableDemands#0",
    "function:assertNativeAsyncRuntimeCallables#0",
  ],
  "src/ir/runtime/contracts/manifest.ts": [
    "type:RuntimeFeature#0",
    "type:HostCapabilityId#0",
    "var:RUNTIME_BACKEND_REQUIREMENTS#0",
    "type:RuntimeBackendRequirement#0",
    "var:PURE_MATH_RUNTIME_PROVIDER_IDS#0",
    "type:MathRuntimeProviderId#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDER_IDS#0",
    "type:NumericCoercionRuntimeProviderId#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:NumberBoundaryRuntimeProviderId#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:BooleanBoundaryRuntimeProviderId#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:ExternBoundaryRuntimeProviderId#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURES#0",
    "type:GeneratorNumberBoxRuntimeFeature#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS#0",
    "type:GeneratorNumberBoxRuntimeProviderId#0",
    "var:STRING_COMPARE_RUNTIME_FEATURES#0",
    "type:StringCompareRuntimeFeature#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDER_IDS#0",
    "type:StringCompareRuntimeProviderId#0",
    "var:STRING_EQ_RUNTIME_FEATURES#0",
    "type:StringEqRuntimeFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDER_IDS#0",
    "type:StringEqRuntimeProviderId#0",
    "var:STRING_LEN_RUNTIME_FEATURES#0",
    "type:StringLenRuntimeFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDER_IDS#0",
    "type:StringLenRuntimeProviderId#0",
    "var:STRING_CONCAT_RUNTIME_FEATURES#0",
    "type:StringConcatRuntimeFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatRuntimeProviderId#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURES#0",
    "type:StringCharCodeAtRuntimeFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS#0",
    "type:StringCharCodeAtRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURES#0",
    "type:StringConcatManyRuntimeFeature#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatManyRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_NATIVE_ARITY#0",
    "var:STRING_CONST_RUNTIME_FEATURES#0",
    "type:StringConstRuntimeFeature#0",
    "var:STRING_CONST_RUNTIME_PROVIDER_IDS#0",
    "type:StringConstRuntimeProviderId#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURES#0",
    "type:HostCallbackWrapRuntimeFeature#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS#0",
    "type:HostCallbackWrapRuntimeProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES#0",
    "type:FunctionPrototypeCallRuntimeFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS#0",
    "type:FunctionPrototypeCallRuntimeProviderId#0",
    "var:REFERENCE_ERROR_RUNTIME_FEATURES#0",
    "type:ReferenceErrorRuntimeFeature#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDER_IDS#0",
    "type:ReferenceErrorRuntimeProviderId#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES#0",
    "type:NativeAsyncCallableRuntimeFeature#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS#0",
    "type:NativeAsyncCallableRuntimeProviderId#0",
    "type:RuntimeProviderId#0",
    "type:RuntimeProviderImplementation#0",
    "type:MathRuntimeProviderImplementation#0",
    "type:IntrinsicRuntimeProviderImplementation#0",
    "interface:RuntimeProviderDefinition#0",
    "type:RuntimeProviderPlan#0",
    "interface:RuntimeProviderComponent#0",
    "interface:FrozenRuntimeManifest#0",
  ],
};

const currentOwnerOrder: Readonly<Record<string, readonly string[]>> = {
  ...preClockOwnerOrder,
  "src/ir/core/vector-runtime.ts": [
    "var:IR_VEC_ELEM_SET_PREFIX#0",
    "var:IR_VEC_NEW_SIZED_PREFIX#0",
    "var:IR_HOLEY_ARRAY_NEW#0",
    "var:IR_HOLEY_ARRAY_ELEM_SET#0",
    "type:IrVectorRuntimeElementKind#0",
    "function:irVectorRuntimeElementKind#0",
    "function:requireRuntimeElementKind#0",
    "function:irVecElemSetSymbol#0",
    "function:irVecNewSizedSymbol#0",
    "function:parseIrVectorRuntimeElement#0",
  ],
  "src/ir/vector-runtime.ts": [],
  "src/ir/runtime/vector-callables.ts": [
    "var:EXTERNREF#0",
    "var:SYMBOL#0",
    "var:VECTOR_CALLABLE_DECLARATION#0",
    "function:irVectorCallableDeclaration#0",
    "var:VECTOR_CALLABLE_RUNTIME_PROVIDERS#0",
    "function:vectorProviderMismatch#0",
    "function:vectorCallablePolicyMismatch#0",
    "class:IrVectorCallableError#0",
    "type:IrVectorCallableDemand#0",
    "function:buffers#0",
    "function:collectVectorCallableDemands#0",
    "function:assertVectorCallableDemands#0",
  ],
  "src/ir/runtime/contracts/manifest.ts": [
    "type:RuntimeFeature#0",
    "type:HostCapabilityId#0",
    "var:RUNTIME_BACKEND_REQUIREMENTS#0",
    "type:RuntimeBackendRequirement#0",
    "var:PURE_MATH_RUNTIME_PROVIDER_IDS#0",
    "type:MathRuntimeProviderId#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDER_IDS#0",
    "type:NumericCoercionRuntimeProviderId#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:NumberBoundaryRuntimeProviderId#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:BooleanBoundaryRuntimeProviderId#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:ExternBoundaryRuntimeProviderId#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURES#0",
    "type:GeneratorNumberBoxRuntimeFeature#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS#0",
    "type:GeneratorNumberBoxRuntimeProviderId#0",
    "var:STRING_COMPARE_RUNTIME_FEATURES#0",
    "type:StringCompareRuntimeFeature#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDER_IDS#0",
    "type:StringCompareRuntimeProviderId#0",
    "var:STRING_EQ_RUNTIME_FEATURES#0",
    "type:StringEqRuntimeFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDER_IDS#0",
    "type:StringEqRuntimeProviderId#0",
    "var:STRING_LEN_RUNTIME_FEATURES#0",
    "type:StringLenRuntimeFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDER_IDS#0",
    "type:StringLenRuntimeProviderId#0",
    "var:STRING_CONCAT_RUNTIME_FEATURES#0",
    "type:StringConcatRuntimeFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatRuntimeProviderId#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURES#0",
    "type:StringCharCodeAtRuntimeFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS#0",
    "type:StringCharCodeAtRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURES#0",
    "type:StringConcatManyRuntimeFeature#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatManyRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_NATIVE_ARITY#0",
    "var:STRING_CONST_RUNTIME_FEATURES#0",
    "type:StringConstRuntimeFeature#0",
    "var:STRING_CONST_RUNTIME_PROVIDER_IDS#0",
    "type:StringConstRuntimeProviderId#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURES#0",
    "type:HostCallbackWrapRuntimeFeature#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS#0",
    "type:HostCallbackWrapRuntimeProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES#0",
    "type:FunctionPrototypeCallRuntimeFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS#0",
    "type:FunctionPrototypeCallRuntimeProviderId#0",
    "var:REFERENCE_ERROR_RUNTIME_FEATURES#0",
    "type:ReferenceErrorRuntimeFeature#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDER_IDS#0",
    "type:ReferenceErrorRuntimeProviderId#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES#0",
    "type:NativeAsyncCallableRuntimeFeature#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS#0",
    "type:NativeAsyncCallableRuntimeProviderId#0",
    "var:VECTOR_CALLABLE_RUNTIME_FEATURES#0",
    "type:VectorCallableRuntimeFeature#0",
    "var:VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS#0",
    "type:VectorCallableRuntimeProviderId#0",
    "type:RuntimeProviderId#0",
    "type:RuntimeProviderImplementation#0",
    "type:MathRuntimeProviderImplementation#0",
    "type:IntrinsicRuntimeProviderImplementation#0",
    "interface:RuntimeProviderDefinition#0",
    "type:RuntimeProviderPlan#0",
    "interface:RuntimeProviderComponent#0",
    "interface:FrozenRuntimeManifest#0",
  ],
  "src/ir/program-runtime-abi.ts": [
    "type:RuntimeCallableInput#0",
    "function:preparedIrRuntimeAbiAnchor#0",
    "function:preparedIrRuntimeCallableBindingId#0",
    "function:assertPreparedIrRuntimeCallableDeclaration#0",
    "function:prepareIrProgramRuntimeCallables#0",
  ],
  "src/ir/runtime-program-manifest.ts": [
    "type:ProducerInput#0",
    "function:locatedFailure#0",
    "function:invariant#0",
    "function:checkFunctionPopulation#0",
    "function:demandFeatures#0",
    "function:mergeDemands#0",
    "interface:PrepareWholeProgramRuntimeManifestInput#0",
    "type:PreparedWholeProgramRuntimeManifest#0",
    "function:prepareWholeProgramRuntimeManifest#0",
  ],
  "src/ir/program-runtime-validation.ts": [
    "function:assertPreparedIrSemanticRuntimeSeparation#0",
    "function:assertClockProjection#0",
    "function:assertPreparedIrRuntimeProjection#0",
  ],
};

export function currentDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  return orderedDeclarations(path, read, currentOwnerOrder);
}

function preClockDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  return orderedDeclarations(path, read, preClockOwnerOrder);
}

export interface HistoricalDeclaration {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly file: ts.SourceFile;
  readonly node: ts.Statement;
  readonly doc: string;
  readonly text: string;
}

function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error("historical reconstruction: " + detail);
}

export function parseLive(path: string, read: SourceReader): ts.SourceFile {
  const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  requireCondition(
    !(file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length,
    "syntax in " + path,
  );
  return file;
}

function identity(node: ts.Statement): { name: string; kind: string } {
  if (ts.isVariableStatement(node)) {
    requireCondition(node.declarationList.declarations.length === 1, "multiple variable bindings");
    const binding = node.declarationList.declarations[0]!.name;
    requireCondition(ts.isIdentifier(binding), "non-identifier binding");
    return { name: binding.text, kind: "var" };
  }
  const kind = ts.isFunctionDeclaration(node)
    ? "function"
    : ts.isInterfaceDeclaration(node)
      ? "interface"
      : ts.isTypeAliasDeclaration(node)
        ? "type"
        : ts.isClassDeclaration(node)
          ? "class"
          : undefined;
  requireCondition(
    kind && "name" in node && node.name && ts.isIdentifier(node.name as ts.Node),
    "unexpected declaration syntax",
  );
  return { name: (node.name as ts.Identifier).text, kind };
}

export function declarationDoc(node: ts.Statement): string {
  const docs = (node as ts.Statement & { jsDoc?: readonly ts.JSDoc[] }).jsDoc;
  requireCondition(!docs || docs.length <= 1, "unexpected multiple declaration documentation blocks");
  return docs?.at(-1)?.getText() ?? "";
}

function orderedDeclarations(
  path: string,
  read: SourceReader,
  orders: Readonly<Record<string, readonly string[]>>,
): HistoricalDeclaration[] {
  const file = parseLive(path, read),
    occurrences = new Map<string, number>();
  const records = file.statements
    .filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map((node) => {
      const { name, kind } = identity(node),
        key = kind + ":" + name;
      const ordinal = occurrences.get(key) ?? 0;
      occurrences.set(key, ordinal + 1);
      return { path, name, kind, ordinal, node, file, doc: declarationDoc(node), text: node.getText(file) };
    });
  const expected = orders[path];
  requireCondition(expected, "unreviewed current owner " + path);
  requireCondition(
    JSON.stringify(records.map((r) => r.kind + ":" + r.name + "#" + r.ordinal)) === JSON.stringify(expected),
    "current declaration order/identity in " + path,
  );
  return records;
}

const runtimeContract = "src/ir/runtime/contracts/intrinsics.ts";
const coreContract = "src/ir/core/intrinsic-contracts.ts";
const coreIntrinsics = "src/ir/core/intrinsics.ts";
const analysisIntrinsics = "src/ir/analysis/intrinsics.ts";

function modulePath(from: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\.js$/, ".ts")));
}

export function assertNamedForward(
  from: string,
  to: string,
  name: string,
  typeOnly: boolean,
  read: SourceReader,
): void {
  const file = parseLive(from, read);
  const matches: { target: string; original: string; typeOnly: boolean }[] = [];
  for (const node of file.statements) {
    if (ts.isImportDeclaration(node)) continue;
    if (!ts.isExportDeclaration(node)) {
      requireCondition(identity(node).name !== name, from + " locally replaces " + name);
      continue;
    }
    requireCondition(node.exportClause && ts.isNamedExports(node.exportClause), "non-explicit forwarding in " + from);
    requireCondition(
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier),
      "missing forwarding target in " + from,
    );
    for (const entry of node.exportClause.elements)
      if (entry.name.text === name)
        matches.push({
          target: modulePath(from, node.moduleSpecifier.text),
          original: entry.propertyName?.text ?? entry.name.text,
          typeOnly: node.isTypeOnly || entry.isTypeOnly,
        });
  }
  requireCondition(
    JSON.stringify(matches) === JSON.stringify([{ target: to, original: name, typeOnly }]),
    "exact forwarding " + from + "#" + name + " -> " + to,
  );
}

function exactImports(
  file: ts.SourceFile,
  expected: readonly { target: string; bindings: readonly string[] }[],
): ts.ImportDeclaration[] {
  const imports = file.statements.filter(ts.isImportDeclaration);
  const actual = imports.map((node) => {
    const clause = node.importClause;
    requireCondition(
      clause?.isTypeOnly &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.attributes,
      "unexpected type import in " + file.fileName,
    );
    return {
      target: node.moduleSpecifier.text,
      bindings: clause.namedBindings.elements.map((entry) => {
        requireCondition(!entry.isTypeOnly, "unexpected per-binding modifier");
        return entry.propertyName ? entry.propertyName.text + " as " + entry.name.text : entry.name.text;
      }),
    };
  });
  requireCondition(JSON.stringify(actual) === JSON.stringify(expected), "exact imports in " + file.fileName);
  return imports;
}

export function assertIntrinsicSpecialization(read: SourceReader): void {
  const runtime = preClockDeclarations(runtimeContract, read),
    file = runtime[0]!.file;
  exactImports(file, [
    { target: "../../core/intrinsic-contracts.js", bindings: ["IntrinsicDefinition as CoreIntrinsicDefinition"] },
  ]);
  const exports = file.statements.filter(ts.isExportDeclaration);
  requireCondition(exports.length === 1, "unexpected runtime contract exports");
  const names = [
    "IntrinsicSignature",
    "IntrinsicSourceLocation",
    "IntrinsicUse",
    "IntrinsicVerificationCode",
    "IntrinsicVerificationFailure",
  ];
  const forward = exports[0]!;
  requireCondition(
    forward.isTypeOnly &&
      forward.exportClause &&
      ts.isNamedExports(forward.exportClause) &&
      ts.isStringLiteral(forward.moduleSpecifier!) &&
      forward.moduleSpecifier.text === "../../core/intrinsic-contracts.js" &&
      JSON.stringify(
        forward.exportClause.elements.map((entry) => [entry.name.text, entry.propertyName?.text, entry.isTypeOnly]),
      ) === JSON.stringify(names.map((name) => [name, undefined, false])),
    "runtime core-contract forwarding",
  );
  const alias = runtime[14]!;
  requireCondition(
    alias.doc === "" && alias.text === "export type IntrinsicDefinition = CoreIntrinsicDefinition<RuntimeFeature>;",
    "exact runtime specialization",
  );
}

export function historicalIntrinsicDeclarations(read: SourceReader): HistoricalDeclaration[] {
  assertIntrinsicSpecialization(read);
  const runtime = preClockDeclarations(runtimeContract, read),
    core = preClockDeclarations(coreContract, read);
  exactImports(core[0]!.file, [
    { target: "./intrinsic-vocabulary.js", bindings: ["IntrinsicId", "IntrinsicSignatureVersion"] },
    { target: "./types.js", bindings: ["IrType"] },
  ]);
  requireCondition(!core[0]!.file.statements.some(ts.isExportDeclaration), "unexpected core contract export");
  const definition = core[3]!,
    node = definition.node;
  requireCondition(
    ts.isInterfaceDeclaration(node) &&
      node.typeParameters?.length === 1 &&
      node.typeParameters[0]!.getText() === "Feature extends string" &&
      node.members.length === 3 &&
      !node.heritageClauses &&
      node.modifiers?.length === 1 &&
      node.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword,
    "exact generic IntrinsicDefinition<Feature extends string>",
  );
  const memberTexts = [
    "readonly id: IntrinsicId;",
    "readonly signature: IntrinsicSignature;",
    "readonly feature: Feature;",
  ];
  requireCondition(
    JSON.stringify(node.members.map((member) => member.getText())) === JSON.stringify(memberTexts),
    "mandatory readonly intrinsic definition members",
  );
  const feature = node.members[2] as ts.PropertySignature;
  requireCondition(feature.type, "missing feature type");
  // Only the approved generic parameter and feature-type tokens are removed.
  const start = node.getStart();
  const text =
    definition.text.slice(0, node.name.end - start) +
    definition.text.slice(node.typeParameters.end + 1 - start, feature.type.getStart() - start) +
    "RuntimeFeature" +
    definition.text.slice(feature.type.end - start);
  return [...runtime.slice(0, 14), ...core.map((row, index) => (index === 3 ? { ...row, text } : row))];
}

export const receiptRows = (records: readonly HistoricalDeclaration[]): string[][] =>
  records.map(({ name, doc, text }) => [name, doc, text]);

export function historicalIntrinsicSource(read: SourceReader): string {
  const rows = acceptedHistoricalDeclarations(runtimeContract, read);
  const file = parseLive(coreContract, read);
  // Validate first, then rebase the two live imports; no synthetic dependencies.
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((node) =>
      node
        .getText(file)
        .replace('"./intrinsic-vocabulary.js"', '"../../core/intrinsic-vocabulary.js"')
        .replace('"./types.js"', '"../../core/types.js"'),
    );
  return imports.join("\n") + "\n\n" + rows.map((r) => (r.doc ? r.doc + "\n" : "") + r.text).join("\n\n") + "\n";
}

function normalizeIntrinsicImplementations(read: SourceReader): HistoricalDeclaration[] {
  const rows = preClockDeclarations(coreIntrinsics, read);
  const definition = rows[16]!,
    node = definition.node;
  requireCondition(
    ts.isFunctionDeclaration(node) &&
      node.body &&
      !node.asteriskToken &&
      !node.modifiers &&
      !node.typeParameters &&
      node.parameters.length === 3 &&
      node.parameters[0]!.getText() === "id: IntrinsicId" &&
      node.parameters[1]!.getText() === "signature: IntrinsicSignature" &&
      node.parameters[2]!.getText() === "feature: IntrinsicId = id" &&
      node.type?.getText() === "IntrinsicDefinition<IntrinsicId>",
    "exact live definition signature",
  );
  // Historical layout is one line. Body/default expression/documentation stay live.
  const text =
    "function definition(" +
    node.parameters
      .slice(0, 2)
      .map((p) => p.getText())
      .join(", ") +
    ", feature: RuntimeFeature = " +
    node.parameters[2]!.initializer!.getText() +
    "): IntrinsicDefinition " +
    node.body.getText();
  const table = rows[17]!;
  requireCondition(ts.isVariableStatement(table.node), "missing canonical intrinsic table");
  const tableDecl = table.node.declarationList.declarations[0]!;
  requireCondition(
    tableDecl.type?.getText() === "Readonly<Record<IntrinsicId, IntrinsicDefinition<IntrinsicId>>>" &&
      tableDecl.initializer,
    "exact canonical table annotation",
  );
  const tableText =
    table.text.slice(0, tableDecl.type.getStart() - table.node.getStart()) +
    "Readonly<Record<IntrinsicId, IntrinsicDefinition>>" +
    table.text.slice(tableDecl.type.end - table.node.getStart());
  const facade = parseLive("src/ir/intrinsics.ts", read);
  const aliases = facade.statements.filter((entry) => !ts.isImportDeclaration(entry) && !ts.isExportDeclaration(entry));
  requireCondition(
    aliases.length === 1 &&
      aliases[0]!.getText() ===
        "export const INTRINSIC_DEFINITIONS: Readonly<Record<IntrinsicId, IntrinsicDefinition>> = canonicalIntrinsicDefinitions;" &&
      declarationDoc(aliases[0]!) === "/** Historical runtime-feature view of the single canonical semantic table. */",
    "live canonical table compatibility alias",
  );
  const tableImports = facade.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (entry) =>
        entry.importClause?.namedBindings &&
        ts.isNamedImports(entry.importClause.namedBindings) &&
        entry.importClause.namedBindings.elements.some(
          (binding) => binding.name.text === "canonicalIntrinsicDefinitions",
        ),
    );
  requireCondition(
    tableImports.length === 1 &&
      tableImports[0]!.getText() ===
        'import { INTRINSIC_DEFINITIONS as canonicalIntrinsicDefinitions } from "./core/intrinsics.js";',
    "canonical table alias import",
  );
  return rows.map((row, index) => (index === 16 ? { ...row, text } : index === 17 ? { ...row, text: tableText } : row));
}

export function historicalIntrinsicVerifier(read: SourceReader): HistoricalDeclaration {
  const semantic = preClockDeclarations(analysisIntrinsics, read)[4]!;
  const combined = preClockDeclarations("src/ir/runtime/intrinsic-verification.ts", read)[3]!;
  const a = semantic.node,
    b = combined.node;
  requireCondition(
    ts.isFunctionDeclaration(a) && a.body && ts.isFunctionDeclaration(b) && b.body,
    "missing split verifier bodies",
  );
  requireCondition(
    a.body.statements.length === 7 &&
      b.body.statements.length === 4 &&
      a.body.statements.at(-1)!.getText() === "return errors;" &&
      b.body.statements[0]!.getText() === "const errors = [...verifyIrIntrinsicSignature(instr, typeOf)];" &&
      b.body.statements.at(-1)!.getText() === "return errors;",
    "exact semantic prefix and provider suffix",
  );
  const parameters = ["instr: IrInstrIntrinsic", "typeOf: ReadonlyMap<IrValueId, IrType>"];
  requireCondition(
    JSON.stringify(a.parameters.map((p) => p.getText())) === JSON.stringify(parameters) &&
      JSON.stringify(b.parameters.map((p) => p.getText())) === JSON.stringify(parameters) &&
      a.type?.getText() === "readonly string[]" &&
      b.type?.getText() === "readonly string[]" &&
      !a.typeParameters &&
      !b.typeParameters &&
      !a.asteriskToken &&
      a.modifiers?.length === 1 &&
      a.modifiers[0]!.kind === ts.SyntaxKind.ExportKeyword,
    "split verifier parameter forwarding",
  );
  requireCondition(
    semantic.doc === "/** Verify the closed semantic signature before runtime provider authentication. */" &&
      combined.doc === "/** Verify the closed semantic signature and any post-freeze provider binding. */",
    "explicit split verifier documentation",
  );
  const first = b.body.statements[0]!,
    last = a.body.statements.at(-1)!;
  const prefix = a.getSourceFile().text.slice(a.body.statements[0]!.getFullStart(), last.getFullStart());
  const text =
    combined.text.slice(0, first.getFullStart() - b.getStart()) +
    prefix +
    combined.text.slice(first.end - b.getStart());
  // The original tuple included this exact documentation as well as the body.
  return { ...combined, text };
}

const manifestOwner = "src/ir/runtime/manifest.ts";
const callableOwner = "src/ir/runtime/callable-declarations.ts";
const manifestContract = "src/ir/runtime/contracts/manifest.ts";
const nativeCallables = "src/ir/runtime/native-async-callables.ts";
const coreCallables = "src/ir/core/async-callables.ts";
const supportOwner = "src/ir/intrinsic-support.ts";
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rowIdentity = (row: HistoricalDeclaration): string => row.kind + ":" + row.name + "#" + row.ordinal;

// Historical order is literal and independent of the current owner census.
// In particular, we do not sort relocated rows back into a passing receipt.
const callableHistoricalOrder = [
  "interface:IrRuntimeCallableDeclaration#0",
  "function:semanticTypes#0",
  "var:referenceError#0",
  "var:REFERENCE_ERROR_DECLARATION#0",
  "function:irRuntimeCallableDeclaration#0",
];
const manifestHistoricalOrder = [
  "function:projectRuntimeBackendRequirements#0",
  "type:RuntimeManifestInvariantCode#0",
  "class:RuntimeManifestInvariantError#0",
  "var:ALL_TARGETS#0",
  "var:ALL_BACKENDS#0",
  "var:REFERENCE_ERROR_DECLARATION#0",
  "var:REFERENCE_ERROR_SIGNATURE#0",
  "var:RUNTIME_FEATURE_SIGNATURES#0",
  "function:provider#0",
  "var:NUMERIC_COERCION_RUNTIME_PROVIDERS#0",
  "function:numberBoundaryProvider#0",
  "var:NUMBER_BOUNDARY_RUNTIME_PROVIDERS#0",
  "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS#0",
  "var:EXTERN_BOUNDARY_RUNTIME_PROVIDERS#0",
  "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS#0",
  "var:STRING_COMPARE_RUNTIME_PROVIDERS#0",
  "function:stringCompareProviderId#0",
  "var:STRING_COMPARE_FEATURE_SET#0",
  "function:isStringCompareFeature#0",
  "var:STRING_EQ_RUNTIME_PROVIDERS#0",
  "function:stringEqProviderId#0",
  "var:STRING_EQ_FEATURE_SET#0",
  "function:isStringEqFeature#0",
  "var:STRING_LEN_RUNTIME_PROVIDERS#0",
  "function:stringLenProviderId#0",
  "var:STRING_LEN_FEATURE_SET#0",
  "function:isStringLenFeature#0",
  "var:STRING_CONCAT_RUNTIME_PROVIDERS#0",
  "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
  "function:stringConcatProviderId#0",
  "var:STRING_CONCAT_FEATURE_SET#0",
  "function:isStringConcatFeature#0",
  "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS#0",
  "var:STRING_CONCAT_MANY_RUNTIME_PROVIDERS#0",
  "function:stringCharCodeAtProviderId#0",
  "var:STRING_CHAR_CODE_AT_FEATURE_SET#0",
  "function:isStringCharCodeAtFeature#0",
  "function:stringConcatManyProviderId#0",
  "var:STRING_CONST_RUNTIME_PROVIDERS#0",
  "function:stringConstProviderId#0",
  "var:STRING_CONST_FEATURE_SET#0",
  "function:isStringConstFeature#0",
  "var:STRING_CONCAT_MANY_FEATURE_SET#0",
  "function:isStringConcatManyFeature#0",
  "function:stringConcatManyArityCap#0",
  "function:generatorNumberBoxProviderId#0",
  "var:GENERATOR_NUMBER_BOX_FEATURE_SET#0",
  "function:isGeneratorNumberBoxFeature#0",
  "function:booleanBoundaryProviderId#0",
  "var:BOOLEAN_BOUNDARY_FEATURE_SET#0",
  "function:isBooleanBoundaryFeature#0",
  "function:externIsUndefinedProviderId#0",
  "var:EXTERN_BOUNDARY_FEATURE_SET#0",
  "function:isExternBoundaryFeature#0",
  "function:numberBoundaryProviderId#0",
  "var:NUMBER_BOUNDARY_FEATURE_SET#0",
  "function:isNumberBoundaryFeature#0",
  "var:PROVIDERS_BY_FEATURE#0",
  "var:PURE_MATH_RUNTIME_PROVIDERS#0",
  "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS#0",
  "function:hostCallbackWrapProviderId#0",
  "var:HOST_CALLBACK_WRAP_FEATURE_SET#0",
  "function:isHostCallbackWrapFeature#0",
  "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS#0",
  "function:functionPrototypeCallProviderId#0",
  "var:FUNCTION_PROTOTYPE_CALL_FEATURE_SET#0",
  "function:isFunctionPrototypeCallFeature#0",
  "var:REFERENCE_ERROR_RUNTIME_PROVIDERS#0",
  "var:RUNTIME_PROVIDERS#0",
  "var:FEATURE_SET#0",
  "var:PROVIDER_ID_SET#0",
  "var:HOST_CAPABILITY_ID_SET#0",
  "var:TARGET_SET#0",
  "var:BACKEND_SET#0",
  "function:isRuntimeFeature#0",
  "function:compareStrings#0",
  "function:signatureEquals#0",
  "function:cloneProvider#0",
  "function:cycleKey#0",
  "function:useOrder#0",
  "function:stronglyConnectedComponents#0",
  "function:buildProviderComponents#0",
  "interface:RuntimeManifestBuilderOptions#0",
  "type:BuilderState#0",
  "class:RuntimeManifestBuilder#0",
];
const contractHistoricalOrder = [
  "type:RuntimeFeature#0",
  "type:HostCapabilityId#0",
  "var:RUNTIME_BACKEND_REQUIREMENTS#0",
  "type:RuntimeBackendRequirement#0",
  "var:PURE_MATH_RUNTIME_PROVIDER_IDS#0",
  "type:MathRuntimeProviderId#0",
  "var:NUMERIC_COERCION_RUNTIME_PROVIDER_IDS#0",
  "type:NumericCoercionRuntimeProviderId#0",
  "var:NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
  "type:NumberBoundaryRuntimeProviderId#0",
  "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
  "type:BooleanBoundaryRuntimeProviderId#0",
  "var:EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
  "type:ExternBoundaryRuntimeProviderId#0",
  "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURES#0",
  "type:GeneratorNumberBoxRuntimeFeature#0",
  "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS#0",
  "type:GeneratorNumberBoxRuntimeProviderId#0",
  "var:STRING_COMPARE_RUNTIME_FEATURES#0",
  "type:StringCompareRuntimeFeature#0",
  "var:STRING_COMPARE_RUNTIME_PROVIDER_IDS#0",
  "type:StringCompareRuntimeProviderId#0",
  "var:STRING_EQ_RUNTIME_FEATURES#0",
  "type:StringEqRuntimeFeature#0",
  "var:STRING_EQ_RUNTIME_PROVIDER_IDS#0",
  "type:StringEqRuntimeProviderId#0",
  "var:STRING_LEN_RUNTIME_FEATURES#0",
  "type:StringLenRuntimeFeature#0",
  "var:STRING_LEN_RUNTIME_PROVIDER_IDS#0",
  "type:StringLenRuntimeProviderId#0",
  "var:STRING_CONCAT_RUNTIME_FEATURES#0",
  "type:StringConcatRuntimeFeature#0",
  "var:STRING_CONCAT_RUNTIME_PROVIDER_IDS#0",
  "type:StringConcatRuntimeProviderId#0",
  "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURES#0",
  "type:StringCharCodeAtRuntimeFeature#0",
  "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS#0",
  "type:StringCharCodeAtRuntimeProviderId#0",
  "var:STRING_CONCAT_MANY_RUNTIME_FEATURES#0",
  "type:StringConcatManyRuntimeFeature#0",
  "var:STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS#0",
  "type:StringConcatManyRuntimeProviderId#0",
  "var:STRING_CONCAT_MANY_NATIVE_ARITY#0",
  "var:STRING_CONST_RUNTIME_FEATURES#0",
  "type:StringConstRuntimeFeature#0",
  "var:STRING_CONST_RUNTIME_PROVIDER_IDS#0",
  "type:StringConstRuntimeProviderId#0",
  "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURES#0",
  "type:HostCallbackWrapRuntimeFeature#0",
  "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS#0",
  "type:HostCallbackWrapRuntimeProviderId#0",
  "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES#0",
  "type:FunctionPrototypeCallRuntimeFeature#0",
  "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS#0",
  "type:FunctionPrototypeCallRuntimeProviderId#0",
  "var:REFERENCE_ERROR_RUNTIME_FEATURES#0",
  "type:ReferenceErrorRuntimeFeature#0",
  "var:REFERENCE_ERROR_RUNTIME_PROVIDER_IDS#0",
  "type:ReferenceErrorRuntimeProviderId#0",
  "type:RuntimeProviderId#0",
  "type:RuntimeProviderImplementation#0",
  "type:MathRuntimeProviderImplementation#0",
  "type:IntrinsicRuntimeProviderImplementation#0",
  "interface:RuntimeProviderDefinition#0",
  "type:RuntimeProviderPlan#0",
  "interface:RuntimeProviderComponent#0",
  "interface:FrozenRuntimeManifest#0",
];

// Separate, reviewed pre-clock/vector extension receipts. These authenticate
// current additions; none replaces or reseeds an original historical receipt.
const callableLinkHashes: Readonly<Record<string, string>> = {
  "src/ir/core/async-callables.ts": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  "src/ir/runtime/native-async-callables.ts": "6871491fd77d56840414a99d1cb5e1b622265d43d00b943e896d8969dae2b008",
  "src/ir/runtime/contracts/manifest.ts": "7e55c050bd822d481168bd07799232a48c44637383b167fac9d18c5cafde5bf2",
  "src/ir/runtime/callable-declarations.ts": "55414b92dc201e4c3dcb96680c958c623bad080bdc1166e54445801e9cc21848",
  "src/ir/runtime/manifest.ts": "ca335a662070a87e09ec2210d6fbb53253bbcabcc8a0934b8decedc2c58ba4ec",
  "src/ir/intrinsic-support.ts": "97a41b6f178862e784cfdf2f786a2d680e3c7ec69516bc94ebedea89e726faaf",
};
const callableNewOwnerHashes: Readonly<Record<string, string>> = {
  [coreCallables]: "a4cae0470f317879797776fd6d5e49b397f745a58d55cee9b7540cc99baa8719",
  [nativeCallables]: "2cf5e287e52d47bba78bcd2bef0cc953a29a5bffbad7093ac93d6aa65a9f3b14",
};
const callableAddedContractHashes: Readonly<Record<string, string>> = {
  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES: "7aa989d05c108ca5a2b63ebd0203510649ec0ff9156535f8c027583e5c218d09",
  NativeAsyncCallableRuntimeFeature: "28b29833755cddb83272fa74f6c51fe2d399f1bf783cadf5dda637fa72dcf886",
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS: "34ffd8280076976862fea5fd6b98382f13940a2da13fccedf32938fadd3c63dd",
  NativeAsyncCallableRuntimeProviderId: "aad797a790b160eb0b448c6a12228bf33bdba84b5b4d000ddbff34749a0a8df3",
};

// Each source-qualified edit includes immediate unchanged neighbors. Moving a
// guard later cannot be normalized away. Whole methods/initializers stay live.
// The independent digest pins the exact approved delta and its inverse.
const callableInverseEdits = [
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:RUNTIME_PROVIDERS#0",
    before:
      "    ...REFERENCE_ERROR_RUNTIME_PROVIDERS,\n    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n    ...ASYNC_RUNTIME_PROVIDERS,",
    after: "    ...REFERENCE_ERROR_RUNTIME_PROVIDERS,\n    ...ASYNC_RUNTIME_PROVIDERS,",
    hash: "b14949f198656483dd3518d73aed5ca97df29b72dc8cb74eb2f604dbdf90503a",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:FEATURE_SET#0",
    before:
      "  ...PURE_MATH_RUNTIME_FEATURES,\n  ...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  ...ASYNC_RUNTIME_FEATURES,",
    after: "  ...PURE_MATH_RUNTIME_FEATURES,\n  ...ASYNC_RUNTIME_FEATURES,",
    hash: "64d28de0e5c539f133f5d897ada6a023ad3335a268be5db70bdcc1b69ae1a935",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:PROVIDER_ID_SET#0",
    before:
      "  ...PURE_MATH_RUNTIME_PROVIDER_IDS,\n  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...ASYNC_RUNTIME_PROVIDER_IDS,",
    after: "  ...PURE_MATH_RUNTIME_PROVIDER_IDS,\n  ...ASYNC_RUNTIME_PROVIDER_IDS,",
    hash: "f283e2026fe91b7df9a10d57c3d25421692980e1e425b10b915f2fa9017f8ffc",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      "  resolveProvider(feature: ReferenceErrorRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {",
    after:
      "  resolveProvider(feature: ReferenceErrorRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {",
    hash: "2c8c9c9a333c4558c1b906584af6862cc1d33288081f8e7f2d65a9705bf8654f",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      '  #indexProviders(): ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]> {\n    const ids = new Set<RuntimeProviderId>();\n    const byFeature = new Map<RuntimeFeature, RuntimeProviderDefinition[]>();\n    for (const provider of this.#providers) {\n      const nativeMismatch = nativeAsyncProviderMismatch(provider);\n      if (nativeMismatch)\n        throw new RuntimeManifestInvariantError(\n          "provider-signature-mismatch",\n          nativeMismatch,\n          provider.feature,\n          provider.feature,\n        );\n      if (!PROVIDER_ID_SET.has(provider.id)) {',
    after:
      "  #indexProviders(): ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]> {\n    const ids = new Set<RuntimeProviderId>();\n    const byFeature = new Map<RuntimeFeature, RuntimeProviderDefinition[]>();\n    for (const provider of this.#providers) {\n      if (!PROVIDER_ID_SET.has(provider.id)) {",
    hash: "d38dca253bf660d38a26ba66b861e845f01f65c20759084b0253b0a680819b4d",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      '  #selectProvider(\n    feature: RuntimeFeature,\n    providers: ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]>,\n  ): RuntimeProviderDefinition {\n    const candidates = providers.get(feature) ?? [];\n    const nativePolicyMismatch = NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)\n      ? nativeAsyncCallablePolicyMismatch(feature, this.#policy)\n      : undefined;\n    if (nativePolicyMismatch)\n      throw new RuntimeManifestInvariantError("provider-target-unavailable", nativePolicyMismatch);\n    if (candidates.length === 0) {',
    after:
      "  #selectProvider(\n    feature: RuntimeFeature,\n    providers: ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]>,\n  ): RuntimeProviderDefinition {\n    const candidates = providers.get(feature) ?? [];\n    if (candidates.length === 0) {",
    hash: "081666a7617d5f27e55aa601a213cb60cb44c6e5f9f0beddee3099c8d284cfc1",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "interface:PrepareIrRuntimeManifestInput#0",
    before:
      "  readonly includeEmpty?: true;\n  /** Explicit complete whole-program scan. Omission retains historical automatic demand behavior. */\n  readonly builtinDemands?: readonly IrNativeAsyncCallableDemand[];\n}",
    after: "  readonly includeEmpty?: true;\n}",
    hash: "757b271067116df484afc873393abc49a3454b569f9bcae8e33ad8287017716c",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      "export function prepareIrRuntimeManifest(input: PrepareIrRuntimeManifestInput): PreparedIrRuntimeManifest | undefined {\n  if (input.builtinDemands) assertNativeAsyncCallableDemands(input.functions, input.builtinDemands);\n  const uses: Array<{",
    after:
      "export function prepareIrRuntimeManifest(input: PrepareIrRuntimeManifestInput): PreparedIrRuntimeManifest | undefined {\n  const uses: Array<{",
    hash: "ce886ca90f7b3857d8b97f8d6368050e503508bcbf39493bb26a9fbe49972684",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      '              const declaration = irRuntimeCallableDeclaration(instr.kind === "call" ? instr.target : instr.liftedFunc);\n              if (declaration?.feature === "error.reference.construct") runtimeCallFeatures.add(declaration.feature);\n            }\n            if (instr.kind !== "intrinsic") return;',
    after:
      '              const declaration = irRuntimeCallableDeclaration(instr.kind === "call" ? instr.target : instr.liftedFunc);\n              if (declaration) runtimeCallFeatures.add(declaration.feature);\n            }\n            if (instr.kind !== "intrinsic") return;',
    hash: "fb4a2a831e26d9ab9cba242f302af153b5ef9bd1ff00dc3ec06339d53fbb087d",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      '      throw new IrRuntimeFunctionPreparationError(fn.unitId, error);\n    }\n  }\n  for (const demand of input.builtinDemands ?? [])\n    for (const use of demand.uses) {\n      const mismatch = nativeAsyncCallablePolicyMismatch(use.feature, input.policy);\n      if (mismatch)\n        throw new RuntimeManifestInvariantError("provider-target-unavailable", mismatch, use.feature, use.feature);\n      runtimeCallFeatures.add(use.feature);\n    }\n  if (\n    !input.includeEmpty &&',
    after:
      "      throw new IrRuntimeFunctionPreparationError(fn.unitId, error);\n    }\n  }\n  if (\n    !input.includeEmpty &&",
    hash: "7b4c6a964ff22bc1de4124a0b8a3d648fbf29ae7fefadf756986ff8a4bf28a77",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      "      input.functions.map((fn) => {\n        try {\n          const attached = attachAsyncRuntime(attachProviders(fn, providers, manifest.hostCapabilityRecords));\n          if (input.builtinDemands) assertNativeAsyncRuntimeCallables(attached);\n          return attached;\n        } catch (error) {",
    after:
      "      input.functions.map((fn) => {\n        try {\n          return attachAsyncRuntime(attachProviders(fn, providers, manifest.hostCapabilityRecords));\n        } catch (error) {",
    hash: "5ec33e50f9f87909e260e706ae5d763492e202b82c97788a836644a9b3af28e6",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    identity: "type:RuntimeFeature#0",
    before:
      "  | FunctionPrototypeCallRuntimeFeature\n  | NativeAsyncCallableRuntimeFeature\n  | ReferenceErrorRuntimeFeature;",
    after: "  | FunctionPrototypeCallRuntimeFeature\n  | ReferenceErrorRuntimeFeature;",
    hash: "a481434c02d63e6ca1c39173f8b715e299b134292dce87d97f2042cbd3a00ebb",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    identity: "type:RuntimeProviderId#0",
    before:
      "  | ReferenceErrorRuntimeProviderId\n  | NativeAsyncCallableRuntimeProviderId\n  | AsyncRuntimeProviderId;",
    after: "  | ReferenceErrorRuntimeProviderId\n  | AsyncRuntimeProviderId;",
    hash: "50a0abaddaf9e3a6762b7db90ac419396aca0b450630fb1880d65f7d1edfae3f",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    identity: "type:RuntimeProviderImplementation#0",
    before:
      'export type RuntimeProviderImplementation =\n  | {\n      /** Authenticated standalone constant projection; never a callable or frame service. */\n      readonly kind: "standalone-clock-zero";\n    }\n  | {\n      readonly kind: "backend-op";',
    after: 'export type RuntimeProviderImplementation =\n  | {\n      readonly kind: "backend-op";',
    hash: "225222e21fb105edbd9b78929a5474937e4d1266dad152a0ba89b5b6719770c4",
  },
  {
    path: "src/ir/runtime/callable-declarations.ts",
    identity: "function:irRuntimeCallableDeclaration#0",
    before:
      'export function irRuntimeCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {\n  return ref.binding.kind === "runtime" && ref.binding.symbol === "__new_ReferenceError"\n    ? REFERENCE_ERROR_DECLARATION\n    : irNativeAsyncCallableDeclaration(ref);\n}',
    after:
      'export function irRuntimeCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {\n  return ref.binding.kind === "runtime" && ref.binding.symbol === "__new_ReferenceError"\n    ? REFERENCE_ERROR_DECLARATION\n    : undefined;\n}',
    hash: "7af8eaffb068d46dc90f215bfa0f785a58ca72715ad7f0fabdd6f414f570adc5",
  },
] as const;

function assertHistoricalOrder(
  rows: readonly HistoricalDeclaration[],
  expected: readonly string[],
  path: string,
): void {
  requireCondition(JSON.stringify(rows.map(rowIdentity)) === JSON.stringify(expected), "historical order " + path);
}

function assertPreClockCallableExtension(read: SourceReader): void {
  for (const [path, expected] of Object.entries(callableLinkHashes)) {
    const file = parseLive(path, read);
    const links = file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
    requireCondition(
      digest(links.map((node) => node.getText(file))) === expected,
      "checked callable import/export delta " + path,
    );
  }
  for (const [path, expected] of Object.entries(callableNewOwnerHashes))
    requireCondition(
      digest(receiptRows(preClockDeclarations(path, read))) === expected,
      "checked callable new-owner delta " + path,
    );
  const contractRows = preClockDeclarations(manifestContract, read);
  for (const [name, expected] of Object.entries(callableAddedContractHashes)) {
    const row = contractRows.find((entry) => entry.name === name)!;
    requireCondition(digest([row.name, row.doc, row.text]) === expected, "checked callable added declaration " + name);
  }
  const callableRows = preClockDeclarations(callableOwner, read);
  const signature = callableRows[4]!;
  const relocatedProviders = callableRows[5]!;
  requireCondition(
    digest([relocatedProviders.name, relocatedProviders.doc, relocatedProviders.text]) ===
      "913033d9064a8771ca2a8c32bfa99e6e6752f06399699c3e233c6b0360c1c9a7",
    "checked relocated ReferenceError providers",
  );
  requireCondition(
    digest([signature.name, signature.doc, signature.text]) ===
      "0437e6a6c3bef7ac01912347bc16f62026afc7015df2211224e0f44efe098fb3",
    "checked ReferenceError signature export/documentation delta",
  );
  assertNamedForward(manifestOwner, callableOwner, "REFERENCE_ERROR_RUNTIME_PROVIDERS", false, read);
}

// Reparse changed text, retaining live leading comments except a specifically
// checked documentation inverse. Consumers must never inspect a stale row.node.
function reparseDeclaration(row: HistoricalDeclaration, text: string, doc = row.doc): HistoricalDeclaration {
  let leading = row.file.text.slice(row.node.getFullStart(), row.node.getStart());
  if (doc !== row.doc) {
    requireCondition(row.doc && leading.split(row.doc).length === 2, "exact removed documentation " + row.name);
    leading = leading.replace(row.doc, doc);
  }
  const file = parseLive(row.path, () => leading + text);
  requireCondition(file.statements.length === 1, "single reconstructed declaration " + row.name);
  const node = file.statements[0]!;
  const id = identity(node);
  requireCondition(id.name === row.name && id.kind === row.kind, "reconstructed declaration identity " + row.name);
  requireCondition(declarationDoc(node) === doc, "reconstructed documentation " + row.name);
  return { ...row, file, node, doc, text: node.getText(file) };
}

function inverseCallableEdits(rows: readonly HistoricalDeclaration[]): HistoricalDeclaration[] {
  return rows.map((row) => {
    let text = row.text;
    for (const edit of callableInverseEdits) {
      if (row.path !== edit.path || rowIdentity(row) !== edit.identity) continue;
      requireCondition(
        digest([edit.path, edit.identity, edit.before, edit.after]) === edit.hash,
        "pinned callable delta " + edit.identity,
      );
      const at = text.indexOf(edit.before);
      requireCondition(
        at >= 0 && text.indexOf(edit.before, at + 1) < 0,
        "exact callable delta/neighbors " + edit.identity,
      );
      const live = text.slice(at, at + edit.before.length);
      requireCondition(
        digest([row.path, rowIdentity(row), live, edit.after]) === edit.hash,
        "live callable delta " + edit.identity,
      );
      text = text.slice(0, at) + edit.after + text.slice(at + live.length);
    }
    return text === row.text ? row : reparseDeclaration(row, text);
  });
}

function historicalCallableDeclarations(read: SourceReader): HistoricalDeclaration[] {
  assertPreClockCallableExtension(read);
  const rows = inverseCallableEdits(preClockDeclarations(callableOwner, read));
  // Exactly two separately authenticated relocated declarations at positions 4/5.
  const result = [...rows.slice(0, 4), rows[6]!];
  assertHistoricalOrder(result, callableHistoricalOrder, callableOwner);
  requireCondition(
    digest(receiptRows(result)) === "ae60c2163949338107ad8f0ba7c2d3e7e2e9e7e469e79ebda871a9f2b7b0700d",
    "unchanged historical callable declaration receipt",
  );
  return result;
}

function historicalManifestDeclarations(read: SourceReader): HistoricalDeclaration[] {
  const callableRows = preClockDeclarations(callableOwner, read);
  // Authenticates the whole old lookup branch, binding and returned declaration,
  // as well as the current native fallback, before restoring the old alias.
  historicalCallableDeclarations(read);
  const signature = callableRows[4]!;
  requireCondition(
    signature.text.startsWith("export const REFERENCE_ERROR_SIGNATURE:"),
    "ReferenceError signature modifier",
  );
  const historicalSignature = reparseDeclaration(signature, signature.text.slice("export ".length), "");
  const aliasText =
    'const REFERENCE_ERROR_DECLARATION = irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError"))!;';
  const aliasFile = parseLive(manifestOwner, () => aliasText);
  const alias: HistoricalDeclaration = {
    path: manifestOwner,
    name: "REFERENCE_ERROR_DECLARATION",
    kind: "var",
    ordinal: 0,
    file: aliasFile,
    node: aliasFile.statements[0]!,
    doc: "",
    text: aliasText,
  };
  const rows = inverseCallableEdits(preClockDeclarations(manifestOwner, read));
  const result = [
    ...rows.slice(0, 5),
    alias,
    historicalSignature,
    ...rows.slice(5, 65),
    callableRows[5]!,
    ...rows.slice(65),
  ];
  assertHistoricalOrder(result, manifestHistoricalOrder, manifestOwner);
  return result;
}

function historicalManifestContractDeclarations(read: SourceReader): HistoricalDeclaration[] {
  assertPreClockCallableExtension(read);
  const rows = inverseCallableEdits(preClockDeclarations(manifestContract, read));
  // Four reviewed declarations between ReferenceErrorRuntimeProviderId and
  // RuntimeProviderId; no name-based filtering of an unfamiliar population.
  const result = [...rows.slice(0, 59), ...rows.slice(63)];
  assertHistoricalOrder(result, contractHistoricalOrder, manifestContract);
  return result;
}

function preClockRuntimeDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  switch (path) {
    case "src/ir/async-runtime-providers.ts":
      return [
        ...preClockDeclarations("src/ir/core/async-intents.ts", read).slice(3),
        ...preClockDeclarations("src/ir/runtime/async-providers.ts", read),
      ];
    case "src/ir/runtime-manifest.ts":
      return historicalManifestDeclarations(read);
    case "src/ir/runtime/callable-declarations.ts":
      return historicalCallableDeclarations(read);
    case "src/ir/runtime/contracts/manifest.ts":
      return historicalManifestContractDeclarations(read);
    case "src/ir/async-plan.ts": {
      const semantic = preClockDeclarations("src/ir/analysis/async-plan.ts", read);
      const runtime = preClockDeclarations("src/ir/runtime/async-attachment.ts", read);
      return [
        ...semantic.slice(0, 3),
        ...runtime.slice(0, 11),
        ...semantic.slice(3, 26),
        runtime[11]!,
        ...semantic.slice(26),
      ];
    }
    case "src/ir/intrinsics.ts":
      return [
        ...normalizeIntrinsicImplementations(read),
        ...preClockDeclarations(analysisIntrinsics, read).slice(0, 4),
      ];
    case "src/ir/intrinsic-support.ts": {
      historicalCallableDeclarations(read);
      const retained = inverseCallableEdits(preClockDeclarations(path, read));
      const runtime = preClockDeclarations("src/ir/runtime/intrinsic-verification.ts", read);
      return [...runtime.slice(0, 3), retained[0]!, historicalIntrinsicVerifier(read), ...retained.slice(1)];
    }
    default:
      throw new Error("unreviewed historical runtime owner " + path);
  }
}

type CheckedStageEdit = {
  readonly path: string;
  readonly identity: string;
  readonly before: string;
  readonly after: string;
  readonly hash: string;
};
type CheckedLinkEdit = {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly hash: string;
};

// Final → pre-vector clock → pre-clock callable. These are explicit versions,
// not presence-based selection. Runtime reconstruction never reads snapshots.
const preVectorClockOrder: Readonly<Record<string, readonly string[]>> = {
  "src/ir/intrinsic-support.ts": [
    "function:projectStandaloneAsyncStateInstr#0",
    "function:mapArray#0",
    "function:valueTypesOf#0",
    "function:providerAttachment#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURE#0",
    "function:preparedGeneratorNumberBoxProvider#0",
    "var:STRING_COMPARE_RUNTIME_FEATURE#0",
    "function:preparedStringCompareProvider#0",
    "var:STRING_EQ_RUNTIME_FEATURE#0",
    "function:preparedStringEqProvider#0",
    "var:STRING_LEN_RUNTIME_FEATURE#0",
    "function:preparedStringLenProvider#0",
    "var:STRING_CONCAT_RUNTIME_FEATURE#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatFeatureFor#0",
    "function:preparedStringConcatProvider#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURE#0",
    "function:preparedStringCharCodeAtProvider#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURE#0",
    "function:preparedStringConcatManyProvider#0",
    "var:STRING_CONST_RUNTIME_FEATURE#0",
    "var:STRING_CONST_UTF16_RUNTIME_FEATURE#0",
    "function:stringConstFeatureFor#0",
    "function:preparedStringConstProvider#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURE#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE#0",
    "function:preparedHostCallbackWrapProvider#0",
    "function:preparedFunctionPrototypeCallProvider#0",
    "function:sameProvider#0",
    "function:attachProvidersToBuffer#0",
    "function:attachProviders#0",
    "interface:IrRuntimeManifestDemands#0",
    "interface:PrepareIrRuntimeManifestInput#0",
    "class:IrRuntimeFunctionPreparationError#0",
    "function:prepareIrRuntimeManifest#0",
    "function:prepareIrRuntimeManifest#1",
    "function:prepareIrRuntimeManifest#2",
  ],
  "src/ir/runtime/callable-declarations.ts": [
    "interface:IrRuntimeCallableDeclaration#0",
    "function:semanticTypes#0",
    "var:referenceError#0",
    "var:REFERENCE_ERROR_DECLARATION#0",
    "var:REFERENCE_ERROR_SIGNATURE#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDERS#0",
    "function:irRuntimeCallableDeclaration#0",
  ],
  "src/ir/runtime/contracts/manifest.ts": [
    "type:RuntimeFeature#0",
    "type:HostCapabilityId#0",
    "var:RUNTIME_BACKEND_REQUIREMENTS#0",
    "type:RuntimeBackendRequirement#0",
    "var:PURE_MATH_RUNTIME_PROVIDER_IDS#0",
    "type:MathRuntimeProviderId#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDER_IDS#0",
    "type:NumericCoercionRuntimeProviderId#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:NumberBoundaryRuntimeProviderId#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:BooleanBoundaryRuntimeProviderId#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS#0",
    "type:ExternBoundaryRuntimeProviderId#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_FEATURES#0",
    "type:GeneratorNumberBoxRuntimeFeature#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS#0",
    "type:GeneratorNumberBoxRuntimeProviderId#0",
    "var:STRING_COMPARE_RUNTIME_FEATURES#0",
    "type:StringCompareRuntimeFeature#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDER_IDS#0",
    "type:StringCompareRuntimeProviderId#0",
    "var:STRING_EQ_RUNTIME_FEATURES#0",
    "type:StringEqRuntimeFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDER_IDS#0",
    "type:StringEqRuntimeProviderId#0",
    "var:STRING_LEN_RUNTIME_FEATURES#0",
    "type:StringLenRuntimeFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDER_IDS#0",
    "type:StringLenRuntimeProviderId#0",
    "var:STRING_CONCAT_RUNTIME_FEATURES#0",
    "type:StringConcatRuntimeFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatRuntimeProviderId#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_FEATURES#0",
    "type:StringCharCodeAtRuntimeFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS#0",
    "type:StringCharCodeAtRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_RUNTIME_FEATURES#0",
    "type:StringConcatManyRuntimeFeature#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS#0",
    "type:StringConcatManyRuntimeProviderId#0",
    "var:STRING_CONCAT_MANY_NATIVE_ARITY#0",
    "var:STRING_CONST_RUNTIME_FEATURES#0",
    "type:StringConstRuntimeFeature#0",
    "var:STRING_CONST_RUNTIME_PROVIDER_IDS#0",
    "type:StringConstRuntimeProviderId#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_FEATURES#0",
    "type:HostCallbackWrapRuntimeFeature#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS#0",
    "type:HostCallbackWrapRuntimeProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES#0",
    "type:FunctionPrototypeCallRuntimeFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS#0",
    "type:FunctionPrototypeCallRuntimeProviderId#0",
    "var:REFERENCE_ERROR_RUNTIME_FEATURES#0",
    "type:ReferenceErrorRuntimeFeature#0",
    "var:REFERENCE_ERROR_RUNTIME_PROVIDER_IDS#0",
    "type:ReferenceErrorRuntimeProviderId#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES#0",
    "type:NativeAsyncCallableRuntimeFeature#0",
    "var:NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS#0",
    "type:NativeAsyncCallableRuntimeProviderId#0",
    "type:RuntimeProviderId#0",
    "type:RuntimeProviderImplementation#0",
    "type:MathRuntimeProviderImplementation#0",
    "type:IntrinsicRuntimeProviderImplementation#0",
    "interface:RuntimeProviderDefinition#0",
    "type:RuntimeProviderPlan#0",
    "interface:RuntimeProviderComponent#0",
    "interface:FrozenRuntimeManifest#0",
  ],
  "src/ir/runtime/manifest.ts": [
    "function:projectRuntimeBackendRequirements#0",
    "type:RuntimeManifestInvariantCode#0",
    "class:RuntimeManifestInvariantError#0",
    "var:ALL_TARGETS#0",
    "var:ALL_BACKENDS#0",
    "var:RUNTIME_FEATURE_SIGNATURES#0",
    "function:provider#0",
    "var:NUMERIC_COERCION_RUNTIME_PROVIDERS#0",
    "function:numberBoundaryProvider#0",
    "var:NUMBER_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:EXTERN_BOUNDARY_RUNTIME_PROVIDERS#0",
    "var:GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS#0",
    "var:STRING_COMPARE_RUNTIME_PROVIDERS#0",
    "function:stringCompareProviderId#0",
    "var:STRING_COMPARE_FEATURE_SET#0",
    "function:isStringCompareFeature#0",
    "var:STRING_EQ_RUNTIME_PROVIDERS#0",
    "function:stringEqProviderId#0",
    "var:STRING_EQ_FEATURE_SET#0",
    "function:isStringEqFeature#0",
    "var:STRING_LEN_RUNTIME_PROVIDERS#0",
    "function:stringLenProviderId#0",
    "var:STRING_LEN_FEATURE_SET#0",
    "function:isStringLenFeature#0",
    "var:STRING_CONCAT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_OWNED_RUNTIME_FEATURE#0",
    "function:stringConcatProviderId#0",
    "var:STRING_CONCAT_FEATURE_SET#0",
    "function:isStringConcatFeature#0",
    "var:STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS#0",
    "var:STRING_CONCAT_MANY_RUNTIME_PROVIDERS#0",
    "function:stringCharCodeAtProviderId#0",
    "var:STRING_CHAR_CODE_AT_FEATURE_SET#0",
    "function:isStringCharCodeAtFeature#0",
    "function:stringConcatManyProviderId#0",
    "var:STRING_CONST_RUNTIME_PROVIDERS#0",
    "function:stringConstProviderId#0",
    "var:STRING_CONST_FEATURE_SET#0",
    "function:isStringConstFeature#0",
    "var:STRING_CONCAT_MANY_FEATURE_SET#0",
    "function:isStringConcatManyFeature#0",
    "function:stringConcatManyArityCap#0",
    "function:generatorNumberBoxProviderId#0",
    "var:GENERATOR_NUMBER_BOX_FEATURE_SET#0",
    "function:isGeneratorNumberBoxFeature#0",
    "function:booleanBoundaryProviderId#0",
    "var:BOOLEAN_BOUNDARY_FEATURE_SET#0",
    "function:isBooleanBoundaryFeature#0",
    "function:externIsUndefinedProviderId#0",
    "var:EXTERN_BOUNDARY_FEATURE_SET#0",
    "function:isExternBoundaryFeature#0",
    "function:numberBoundaryProviderId#0",
    "var:NUMBER_BOUNDARY_FEATURE_SET#0",
    "function:isNumberBoundaryFeature#0",
    "var:PROVIDERS_BY_FEATURE#0",
    "var:PURE_MATH_RUNTIME_PROVIDERS#0",
    "var:HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS#0",
    "function:hostCallbackWrapProviderId#0",
    "var:HOST_CALLBACK_WRAP_FEATURE_SET#0",
    "function:isHostCallbackWrapFeature#0",
    "var:FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS#0",
    "function:functionPrototypeCallProviderId#0",
    "var:FUNCTION_PROTOTYPE_CALL_FEATURE_SET#0",
    "function:isFunctionPrototypeCallFeature#0",
    "var:RUNTIME_PROVIDERS#0",
    "var:FEATURE_SET#0",
    "var:PROVIDER_ID_SET#0",
    "var:HOST_CAPABILITY_ID_SET#0",
    "var:TARGET_SET#0",
    "var:BACKEND_SET#0",
    "function:isRuntimeFeature#0",
    "function:compareStrings#0",
    "function:signatureEquals#0",
    "function:cloneProvider#0",
    "function:cycleKey#0",
    "function:useOrder#0",
    "function:stronglyConnectedComponents#0",
    "function:buildProviderComponents#0",
    "interface:RuntimeManifestBuilderOptions#0",
    "type:BuilderState#0",
    "class:RuntimeManifestBuilder#0",
  ],
};
const currentExtensionLinkHashes: Readonly<Record<string, string>> = {
  "src/ir/core/vector-runtime.ts": "98fa929945d2e25415b57a33b20a77cbec8e80891adcbf6338e65f0b3516b47b",
  "src/ir/vector-runtime.ts": "3d15a9cfb25081658ccc2af4f60ff55efe6a1212474595ef6d20ae28046d0861",
  "src/ir/runtime/vector-callables.ts": "09a8877a6ab57a9a8e7d9a9d13de082903597c0051ba90a9c45e9b3386c76390",
  "src/ir/runtime/callable-declarations.ts": "ad13a23e7cf0ea369495cc6407bf38712feff01ea8094b3085a7efbb43463a0a",
  "src/ir/runtime/contracts/manifest.ts": "7e55c050bd822d481168bd07799232a48c44637383b167fac9d18c5cafde5bf2",
  "src/ir/runtime/manifest.ts": "11d524ad0bc84e177288859496d67dc59e5c81812c0b46114ca54b55348952ad",
  "src/ir/intrinsic-support.ts": "0e4762c59e13e08a4f63732a136a8b8fbe8a10a7abc604ea9eb0e4c68d09c766",
  "src/ir/program-runtime-abi.ts": "24dd026a4382e1690aeb37d5ee51c4f853fcc17e1e522bb166d2e263515293be",
  "src/ir/runtime-program-manifest.ts": "92dc201f332753672a82ecbe6d6cd92f4b0f300eea384435cd097e3d8cd739bd",
  "src/ir/program-runtime-validation.ts": "24853caafadb01f892f780f961d47c43ac4dd099dd20dd8412a26f4997bd2c07",
};
const currentExtensionOwnerHashes: Readonly<Record<string, string>> = {
  "src/ir/core/vector-runtime.ts": "1e63fd06b1a73b26bf62d01c307ff90126a004c6d8ef5647077e6093a8c8f265",
  "src/ir/runtime/vector-callables.ts": "cc477b3bcaae45a597627cbabc3385b08b9917cd3648587332e3d4c29e494cad",
  "src/ir/program-runtime-validation.ts": "d2c6f52d4c2e422194f9eb09148211ed84d2d8a5eed27c78eeb736fc4841b34b",
  "src/ir/program-runtime-abi.ts": "4635b1c5316f3f86aee1cdaf7028619470eb8bb7e235e236adabc3c4b1c395cc",
  "src/ir/runtime-program-manifest.ts": "f3ebcef521b16cf6ec03c6747e4119af764dadc8a21d0ec5870270c48336e02d",
};
const addedVectorHashes: Readonly<Record<string, string>> = {
  "var:VECTOR_CALLABLE_RUNTIME_FEATURES#0": "4452ab37f6dfab698ad983ea4ea62384c677ad098c9d23d9fefd997314921644",
  "type:VectorCallableRuntimeFeature#0": "4f26bcc84cfabe01a20fb2880066a58cdf98130228891ceacc6a360cedc403d9",
  "var:VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS#0": "dc03d84fbce2c8839b28210370ae29dc660c300b9ccd5f13919e0230748590fc",
  "type:VectorCallableRuntimeProviderId#0": "e7f0e5ef0992b1a5b6631bc8cbf67e88f09fe7bed030c4a66432bc437403c228",
};
const preVectorClockHashes: Readonly<Record<string, string>> = {
  "src/ir/intrinsic-support.ts": "ea6102cebd8b3880b33551e4e10b05b5074f26c9b2ceafa24143b255c4684e45",
  "src/ir/runtime/callable-declarations.ts": "a09d682c8aa6d046b347a8552f6fed68afe56930d1bf6b573df70f6088798c78",
  "src/ir/runtime/contracts/manifest.ts": "2fa8f496b3dc53e80b5c203750c97dc045586ac0d6769fb0cfe30d33f32e99af",
  "src/ir/runtime/manifest.ts": "26c6ecb419a8665a66d8e7dd4ddd23c91ce9b78f0d098a15d97402c0ddee6ffd",
};
const preClockCallableHashes: Readonly<Record<string, string>> = {
  "src/ir/intrinsic-support.ts": "3dc9caa8e370963fd8da1bd5c9c0eac41aa754d5e0ce19e227ef99d7e7ccbf60",
  "src/ir/runtime/callable-declarations.ts": "a09d682c8aa6d046b347a8552f6fed68afe56930d1bf6b573df70f6088798c78",
  "src/ir/runtime/contracts/manifest.ts": "2fa8f496b3dc53e80b5c203750c97dc045586ac0d6769fb0cfe30d33f32e99af",
  "src/ir/runtime/manifest.ts": "26c6ecb419a8665a66d8e7dd4ddd23c91ce9b78f0d098a15d97402c0ddee6ffd",
};
const vectorInverseEdits: readonly CheckedStageEdit[] = [
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "interface:PrepareIrRuntimeManifestInput#0",
    before:
      "  readonly builtinDemands?: readonly IrNativeAsyncCallableDemand[];\n  /** Separate complete vector-callable occurrence census; omission preserves legacy selection. */\n  readonly vectorDemands?: readonly IrVectorCallableDemand[];\n}",
    after: "  readonly builtinDemands?: readonly IrNativeAsyncCallableDemand[];\n}",
    hash: "db796b6d4a87f3495d0a624ada60a8ddf6eb1cb1406dd5d50acb3b923883057b",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      "  if (input.builtinDemands) assertNativeAsyncCallableDemands(input.functions, input.builtinDemands);\n  if (input.vectorDemands) assertVectorCallableDemands(input.functions, input.vectorDemands);\n  const uses: Array<{",
    after:
      "  if (input.builtinDemands) assertNativeAsyncCallableDemands(input.functions, input.builtinDemands);\n  const uses: Array<{",
    hash: "38c626c6a1bf29bfbaf7b90c7e5540b3d355473e2402d927f518a72ce45043ef",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      '      runtimeCallFeatures.add(use.feature);\n    }\n  for (const demand of input.vectorDemands ?? [])\n    for (const use of demand.uses) {\n      const mismatch = vectorCallablePolicyMismatch(use.feature, input.policy);\n      if (mismatch)\n        throw new RuntimeManifestInvariantError("provider-target-unavailable", mismatch, use.feature, use.feature);\n      runtimeCallFeatures.add(use.feature);\n    }\n  if (\n    !input.includeEmpty &&',
    after: "      runtimeCallFeatures.add(use.feature);\n    }\n  if (\n    !input.includeEmpty &&",
    hash: "bf1e3bdc03f20d95cdcc7fc307fbe4fe356c4e9ab62a33994800d7516e7e856e",
  },
  {
    path: "src/ir/runtime/callable-declarations.ts",
    identity: "function:irRuntimeCallableDeclaration#0",
    before:
      "    ? REFERENCE_ERROR_DECLARATION\n    : (irNativeAsyncCallableDeclaration(ref) ?? irVectorCallableDeclaration(ref));",
    after: "    ? REFERENCE_ERROR_DECLARATION\n    : irNativeAsyncCallableDeclaration(ref);",
    hash: "2718ca211c53e56cb5700315210d750d0d8ca2d7eb9cf571dd74ac8e912fe520",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    identity: "type:RuntimeFeature#0",
    before:
      "  | NativeAsyncCallableRuntimeFeature\n  | VectorCallableRuntimeFeature\n  | ReferenceErrorRuntimeFeature;",
    after: "  | NativeAsyncCallableRuntimeFeature\n  | ReferenceErrorRuntimeFeature;",
    hash: "2efc315caa3a029a4a6744518137f1bc01af3ea57593153d4a2100f2ef87c6d8",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    identity: "type:RuntimeProviderId#0",
    before:
      "  | NativeAsyncCallableRuntimeProviderId\n  | VectorCallableRuntimeProviderId\n  | AsyncRuntimeProviderId;",
    after: "  | NativeAsyncCallableRuntimeProviderId\n  | AsyncRuntimeProviderId;",
    hash: "9c4c9086f78d186e39485c200fd46000c29656fd465f7e56af36e76093638882",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:RUNTIME_PROVIDERS#0",
    before:
      "    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n    ...VECTOR_CALLABLE_RUNTIME_PROVIDERS,\n    ...ASYNC_RUNTIME_PROVIDERS,",
    after: "    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n    ...ASYNC_RUNTIME_PROVIDERS,",
    hash: "082c611063dfb62b6c9f5ff9f44790f4178b699112f33b8ba5e6a9ab0224563c",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:FEATURE_SET#0",
    before:
      "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  ...VECTOR_CALLABLE_RUNTIME_FEATURES,\n  ...ASYNC_RUNTIME_FEATURES,",
    after: "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  ...ASYNC_RUNTIME_FEATURES,",
    hash: "9dd7b980404681c516210667e8bf77610639b29a35970589489480585c4c5bd5",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "var:PROVIDER_ID_SET#0",
    before:
      "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...ASYNC_RUNTIME_PROVIDER_IDS,",
    after: "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...ASYNC_RUNTIME_PROVIDER_IDS,",
    hash: "783a45c1c2044022e336b394842e99c4397274702c74af34098411f49f9da819",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      "  resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: VectorCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {",
    after:
      "  resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {",
    hash: "f9612920f1f39c663153baf561bc60001cd4b76a47f9114b2aeedb9868004b81",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      "    for (const provider of this.#providers) {\n      const nativeMismatch = nativeAsyncProviderMismatch(provider) ?? vectorProviderMismatch(provider);\n      if (nativeMismatch)",
    after:
      "    for (const provider of this.#providers) {\n      const nativeMismatch = nativeAsyncProviderMismatch(provider);\n      if (nativeMismatch)",
    hash: "f419b9ea1c3ca689cd1a3cc75b2b3c4a78c1a07874f754711468ba479464265b",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    identity: "class:RuntimeManifestBuilder#0",
    before:
      "    const nativePolicyMismatch = NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)\n      ? nativeAsyncCallablePolicyMismatch(feature, this.#policy)\n      : vectorCallablePolicyMismatch(feature, this.#policy);\n    if (nativePolicyMismatch)",
    after:
      "    const nativePolicyMismatch = NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)\n      ? nativeAsyncCallablePolicyMismatch(feature, this.#policy)\n      : undefined;\n    if (nativePolicyMismatch)",
    hash: "56d4eedaa82a90712636301b7307e95e0a71561217fc80124b74102bdad74a63",
  },
];
const clockInverseEdits: readonly CheckedStageEdit[] = [
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:projectStandaloneAsyncStateInstr#0",
    before:
      "function projectStandaloneAsyncStateInstr(instr: IrInstr): IrInstr {\n  const nested = mapNestedBuffers(instr, (buffer) => mapArray(buffer, projectStandaloneAsyncStateInstr));",
    after:
      "function projectStandaloneAsyncStateInstr(instr: IrInstr): IrInstr {\n  const nested = mapNestedBuffers(instr, (buffer) => buffer.map(projectStandaloneAsyncStateInstr));",
    hash: "49a709fbc63959f20aef551915b323a537ad06f86588c703e4cc9d63055e26e9",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:projectStandaloneAsyncStateInstr#0",
    before:
      '    throw new Error("standalone async clock snapshot has a malformed semantic call");\n  }\n  if (Object.hasOwn(nested, "alloc")) {\n    throw new Error("standalone async clock snapshot cannot carry allocation metadata");\n  }\n  return {',
    after: '    throw new Error("standalone async clock snapshot has a malformed semantic call");\n  }\n  return {',
    hash: "8310b5352dd4ff95089c9d2f613272f2b5c7b9a1808f803432f970898f131a59",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:projectStandaloneAsyncStateInstr#0",
    before: '    resultType: nested.resultType,\n    ...(Object.hasOwn(nested, "site") ? { site: nested.site } : {}),',
    after: "    resultType: nested.resultType,\n    ...(nested.site ? { site: nested.site } : {}),",
    hash: "a6d7a2e78ce2c4cc8f31f2efb60b6065a72145a1f3dc03d85051e75736253b45",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:attachProviders#0",
    before:
      "  capabilityRecords: readonly RuntimeHostCapabilityRecord[],\n  projectClocks = false,\n): IrFunction {\n  const blocks = mapArray(fn.blocks, (block) => {",
    after:
      "  capabilityRecords: readonly RuntimeHostCapabilityRecord[],\n): IrFunction {\n  const blocks = mapArray(fn.blocks, (block) => {",
    hash: "910934c7e1003dd983015ac4b8d16d0fad34c441e041577da6d25fb97be8a18f",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:attachProviders#0",
    before:
      "  const blocks = mapArray(fn.blocks, (block) => {\n    const attached = attachProvidersToBuffer(block.instrs, providers, capabilityRecords);\n    const instrs = projectClocks ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached;\n    return instrs === block.instrs ? block : { ...block, instrs };",
    after:
      "  const blocks = mapArray(fn.blocks, (block) => {\n    const instrs = attachProvidersToBuffer(block.instrs, providers, capabilityRecords);\n    return instrs === block.instrs ? block : { ...block, instrs };",
    hash: "328beda09d8cbeea577a99835f373d38a45e7fe9746c519afc23ebff87554dca",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      '  const manifest = builder.freeze();\n  // The explicit whole-program demand vector is the compatibility boundary.\n  // Authenticate the selected frozen row by contents, not catalogue object identity.\n  const projectClocks =\n    input.builtinDemands?.some((demand) => demand.uses.some((use) => use.feature === "async.native.clock-zero")) ??\n    false;\n  if (projectClocks) {\n    const clockProviders = manifest.providers.filter(\n      (provider) =>\n        provider.feature === "async.native.clock-zero" ||\n        provider.id === "native.async.clock-zero" ||\n        provider.implementation.kind === "standalone-clock-zero",\n    );\n    const mismatch = nativeAsyncCallablePolicyMismatch("async.native.clock-zero", manifest.policy);\n    if (mismatch) throw new Error(mismatch);\n    if (clockProviders.length !== 1 || nativeAsyncProviderMismatch(clockProviders[0]!) !== undefined)\n      throw new Error("standalone async clock snapshot requires the unique canonical frozen clock provider");\n  }\n  const providers = new Map<IrInstrIntrinsic["id"], RuntimeProviderPlan>();',
    after:
      '  const manifest = builder.freeze();\n  const providers = new Map<IrInstrIntrinsic["id"], RuntimeProviderPlan>();',
    hash: "26c010ead0d401e4613c076e3eacea7aad7e0149d1d580b2039b12af314eab30",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      "        const attached = attachProvidersToBuffer(state.body, providers, manifest.hostCapabilityRecords);\n        const body = nativeProjection ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached;\n        return body === state.body ? state : Object.freeze({ ...state, body });",
    after:
      "        const attached = attachProvidersToBuffer(state.body, providers, manifest.hostCapabilityRecords);\n        const body = nativeProjection ? attached.map(projectStandaloneAsyncStateInstr) : attached;\n        return body === state.body ? state : Object.freeze({ ...state, body });",
    hash: "a857bcfefda20a920b2275caa52c7a5a6913998f5795370b41aa20108e37c4a6",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    identity: "function:prepareIrRuntimeManifest#2",
    before:
      "        try {\n          const attached = attachAsyncRuntime(\n            attachProviders(fn, providers, manifest.hostCapabilityRecords, projectClocks),\n          );\n          if (input.builtinDemands)",
    after:
      "        try {\n          const attached = attachAsyncRuntime(attachProviders(fn, providers, manifest.hostCapabilityRecords));\n          if (input.builtinDemands)",
    hash: "a1fa1e40a88859eaab1daa6610aa2e960b01241a7801bbc7432155655151167d",
  },
];
const vectorLinkEdits: readonly CheckedLinkEdit[] = [
  {
    path: "src/ir/intrinsic-support.ts",
    before:
      'import {\n  assertVectorCallableDemands,\n  vectorCallablePolicyMismatch,\n  type IrVectorCallableDemand,\n} from "./runtime/vector-callables.js";',
    after: "",
    hash: "46942c6158a8d8d5d8c4b1bfb0614181fc592bd7e152d71d93120e8a202edb3b",
  },
  {
    path: "src/ir/runtime/callable-declarations.ts",
    before: 'import { irVectorCallableDeclaration } from "./vector-callables.js";',
    after: "",
    hash: "7e81678f468465abd4097b975769f2c8d389cddaeec7fa3c24f1361d6887996e",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    before:
      'import {\n  NUMBER_BOUNDARY_POLICY_DISABLED,\n  BOOLEAN_BOUNDARY_POLICY_DISABLED,\n  EXTERN_IS_UNDEFINED_POLICY_DISABLED,\n  GENERATOR_NUMBER_BOX_POLICY_DISABLED,\n  STRING_COMPARE_POLICY_DISABLED,\n  STRING_EQ_POLICY_DISABLED,\n  STRING_LEN_POLICY_DISABLED,\n  STRING_CONCAT_POLICY_DISABLED,\n  STRING_CHAR_CODE_AT_POLICY_DISABLED,\n  STRING_CONCAT_MANY_POLICY_DISABLED,\n  STRING_CONST_POLICY_DISABLED,\n  HOST_CALLBACK_WRAP_POLICY_DISABLED,\n  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,\n  type RuntimeTarget,\n  type RuntimeBackend,\n  type NumberBoundaryPolicy,\n  type BooleanBoundaryPolicy,\n  type ExternIsUndefinedPolicy,\n  type GeneratorNumberBoxPolicy,\n  type StringComparePolicy,\n  type StringEqPolicy,\n  type StringLenPolicy,\n  type StringConcatPolicy,\n  type StringCharCodeAtPolicy,\n  type StringConcatManyPolicy,\n  type StringConstPolicy,\n  type HostCallbackWrapPolicy,\n  type FunctionPrototypeCallPolicy,\n  type RuntimeManifestPolicy,\n  type FrozenRuntimeManifestPolicy,\n} from "../../runtime/contracts/provider-policy.js";',
    after:
      'import {\n  NUMBER_BOUNDARY_POLICY_DISABLED,\n  BOOLEAN_BOUNDARY_POLICY_DISABLED,\n  EXTERN_IS_UNDEFINED_POLICY_DISABLED,\n  GENERATOR_NUMBER_BOX_POLICY_DISABLED,\n  STRING_COMPARE_POLICY_DISABLED,\n  STRING_EQ_POLICY_DISABLED,\n  STRING_LEN_POLICY_DISABLED,\n  STRING_CONCAT_POLICY_DISABLED,\n  STRING_CHAR_CODE_AT_POLICY_DISABLED,\n  STRING_CONCAT_MANY_POLICY_DISABLED,\n  STRING_CONST_POLICY_DISABLED,\n  HOST_CALLBACK_WRAP_POLICY_DISABLED,\n  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,\n} from "../../runtime/contracts/provider-policy.js";\nimport type {\n  RuntimeTarget,\n  RuntimeBackend,\n  NumberBoundaryPolicy,\n  BooleanBoundaryPolicy,\n  ExternIsUndefinedPolicy,\n  GeneratorNumberBoxPolicy,\n  StringComparePolicy,\n  StringEqPolicy,\n  StringLenPolicy,\n  StringConcatPolicy,\n  StringCharCodeAtPolicy,\n  StringConcatManyPolicy,\n  StringConstPolicy,\n  HostCallbackWrapPolicy,\n  FunctionPrototypeCallPolicy,\n  RuntimeManifestPolicy,\n  FrozenRuntimeManifestPolicy,\n} from "../../runtime/contracts/provider-policy.js";',
    hash: "d7fef0f593cd1a145b564e516d1460829b5e1f2959e93db75be167ff38e35cd6",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    before:
      'import {\n  RUNTIME_BACKEND_REQUIREMENTS,\n  PURE_MATH_RUNTIME_PROVIDER_IDS,\n  NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,\n  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,\n  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,\n  STRING_COMPARE_RUNTIME_FEATURES,\n  STRING_COMPARE_RUNTIME_PROVIDER_IDS,\n  STRING_EQ_RUNTIME_FEATURES,\n  STRING_EQ_RUNTIME_PROVIDER_IDS,\n  STRING_LEN_RUNTIME_FEATURES,\n  STRING_LEN_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_RUNTIME_FEATURES,\n  STRING_CONCAT_RUNTIME_PROVIDER_IDS,\n  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,\n  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_RUNTIME_FEATURES,\n  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_NATIVE_ARITY,\n  STRING_CONST_RUNTIME_FEATURES,\n  STRING_CONST_RUNTIME_PROVIDER_IDS,\n  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,\n  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,\n  REFERENCE_ERROR_RUNTIME_FEATURES,\n  REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,\n  VECTOR_CALLABLE_RUNTIME_FEATURES,\n  VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,\n  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  type RuntimeFeature,\n  type HostCapabilityId,\n  type RuntimeBackendRequirement,\n  type NumberBoundaryRuntimeProviderId,\n  type BooleanBoundaryRuntimeProviderId,\n  type ExternBoundaryRuntimeProviderId,\n  type GeneratorNumberBoxRuntimeFeature,\n  type GeneratorNumberBoxRuntimeProviderId,\n  type StringCompareRuntimeFeature,\n  type StringCompareRuntimeProviderId,\n  type StringEqRuntimeFeature,\n  type StringEqRuntimeProviderId,\n  type StringLenRuntimeFeature,\n  type StringLenRuntimeProviderId,\n  type StringConcatRuntimeFeature,\n  type StringConcatRuntimeProviderId,\n  type StringCharCodeAtRuntimeFeature,\n  type StringCharCodeAtRuntimeProviderId,\n  type StringConcatManyRuntimeFeature,\n  type StringConcatManyRuntimeProviderId,\n  type StringConstRuntimeFeature,\n  type StringConstRuntimeProviderId,\n  type HostCallbackWrapRuntimeFeature,\n  type HostCallbackWrapRuntimeProviderId,\n  type FunctionPrototypeCallRuntimeFeature,\n  type FunctionPrototypeCallRuntimeProviderId,\n  type ReferenceErrorRuntimeFeature,\n  type NativeAsyncCallableRuntimeFeature,\n  type VectorCallableRuntimeFeature,\n  type RuntimeProviderId,\n  type RuntimeProviderImplementation,\n  type RuntimeProviderDefinition,\n  type RuntimeProviderPlan,\n  type RuntimeProviderComponent,\n  type FrozenRuntimeManifest,\n} from "./contracts/manifest.js";',
    after:
      'import {\n  RUNTIME_BACKEND_REQUIREMENTS,\n  PURE_MATH_RUNTIME_PROVIDER_IDS,\n  NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,\n  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,\n  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,\n  STRING_COMPARE_RUNTIME_FEATURES,\n  STRING_COMPARE_RUNTIME_PROVIDER_IDS,\n  STRING_EQ_RUNTIME_FEATURES,\n  STRING_EQ_RUNTIME_PROVIDER_IDS,\n  STRING_LEN_RUNTIME_FEATURES,\n  STRING_LEN_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_RUNTIME_FEATURES,\n  STRING_CONCAT_RUNTIME_PROVIDER_IDS,\n  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,\n  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_RUNTIME_FEATURES,\n  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_NATIVE_ARITY,\n  STRING_CONST_RUNTIME_FEATURES,\n  STRING_CONST_RUNTIME_PROVIDER_IDS,\n  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,\n  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,\n  REFERENCE_ERROR_RUNTIME_FEATURES,\n  REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,\n} from "./contracts/manifest.js";\nimport type {\n  RuntimeFeature,\n  HostCapabilityId,\n  RuntimeBackendRequirement,\n  NumberBoundaryRuntimeProviderId,\n  BooleanBoundaryRuntimeProviderId,\n  ExternBoundaryRuntimeProviderId,\n  GeneratorNumberBoxRuntimeFeature,\n  GeneratorNumberBoxRuntimeProviderId,\n  StringCompareRuntimeFeature,\n  StringCompareRuntimeProviderId,\n  StringEqRuntimeFeature,\n  StringEqRuntimeProviderId,\n  StringLenRuntimeFeature,\n  StringLenRuntimeProviderId,\n  StringConcatRuntimeFeature,\n  StringConcatRuntimeProviderId,\n  StringCharCodeAtRuntimeFeature,\n  StringCharCodeAtRuntimeProviderId,\n  StringConcatManyRuntimeFeature,\n  StringConcatManyRuntimeProviderId,\n  StringConstRuntimeFeature,\n  StringConstRuntimeProviderId,\n  HostCallbackWrapRuntimeFeature,\n  HostCallbackWrapRuntimeProviderId,\n  FunctionPrototypeCallRuntimeFeature,\n  FunctionPrototypeCallRuntimeProviderId,\n  ReferenceErrorRuntimeFeature,\n  RuntimeProviderId,\n  RuntimeProviderImplementation,\n  RuntimeProviderDefinition,\n  RuntimeProviderPlan,\n  RuntimeProviderComponent,\n  FrozenRuntimeManifest,\n} from "./contracts/manifest.js";',
    hash: "6b98bf14fa909b8e9981513faa210cfcf65fb00dd2f1c0228948726d40286b2f",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    before:
      'import {\n  VECTOR_CALLABLE_RUNTIME_PROVIDERS,\n  vectorProviderMismatch,\n  vectorCallablePolicyMismatch,\n} from "./vector-callables.js";',
    after: "",
    hash: "8912b5dc75a2bf31de61c5fc0afe356251629593e2fe3780c8b983c32d03af0c",
  },
  {
    path: "src/ir/runtime/manifest.ts",
    before:
      'import {\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n  nativeAsyncProviderMismatch,\n  nativeAsyncCallablePolicyMismatch,\n} from "./native-async-callables.js";',
    after:
      'import {\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n  nativeAsyncProviderMismatch,\n  nativeAsyncCallablePolicyMismatch,\n} from "./native-async-callables.js";\nimport {\n  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  type NativeAsyncCallableRuntimeFeature,\n} from "./contracts/manifest.js";',
    hash: "560689449cc0dfec3f02f6f429e00a357c8e23262109fc99c430b99cba5412e2",
  },
];
const clockLinkEdits: readonly CheckedLinkEdit[] = [
  {
    path: "src/ir/intrinsic-support.ts",
    before:
      'import {\n  assertNativeAsyncCallableDemands,\n  assertNativeAsyncRuntimeCallables,\n  nativeAsyncCallablePolicyMismatch,\n  nativeAsyncProviderMismatch,\n  type IrNativeAsyncCallableDemand,\n} from "./runtime/native-async-callables.js";',
    after:
      'import {\n  assertNativeAsyncCallableDemands,\n  assertNativeAsyncRuntimeCallables,\n  nativeAsyncCallablePolicyMismatch,\n  type IrNativeAsyncCallableDemand,\n} from "./runtime/native-async-callables.js";',
    hash: "f9bed445b96971a5e2632aa315db4004a268584884cdce3388fa966727d4e637",
  },
];

function assertCurrentClockVectorExtensions(read: SourceReader): void {
  for (const [path, expected] of Object.entries(currentExtensionLinkHashes)) {
    const file = parseLive(path, read);
    const links = file.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
    // All ten reviewed owners have this complete link block before their
    // declarations. Hashing links alone cannot detect movement across a body.
    requireCondition(
      links.every((node, index) => file.statements[index] === node),
      "current clock/vector link placement " + path,
    );
    requireCondition(
      digest(links.map((node) => node.getText(file))) === expected,
      "current clock/vector links " + path,
    );
  }
  const projection = currentDeclarations(supportOwner, read).find(
    (row) => rowIdentity(row) === "function:projectStandaloneAsyncStateInstr#0",
  )!;
  requireCondition(
    projection.file.text.slice(projection.node.getFullStart(), projection.node.getStart()).trim() ===
      "/** Project the semantic standalone clock intent without adding a helper call. */",
    "current clock projection complete leading documentation",
  );
  for (const [path, expected] of Object.entries(currentExtensionOwnerHashes))
    requireCondition(
      digest(receiptRows(currentDeclarations(path, read))) === expected,
      "current clock/vector owner receipt " + path,
    );
  const vectorRows = currentDeclarations(manifestContract, read);
  for (const [key, expected] of Object.entries(addedVectorHashes)) {
    const row = vectorRows.find((entry) => rowIdentity(entry) === key)!;
    requireCondition(digest([row.name, row.doc, row.text]) === expected, "current vector declaration " + key);
  }
  const facade = "src/ir/vector-runtime.ts";
  requireCondition(currentDeclarations(facade, read).length === 0, "vector facade must not acquire implementation");
  for (const name of [
    "IR_VEC_ELEM_SET_PREFIX",
    "IR_VEC_NEW_SIZED_PREFIX",
    "IR_HOLEY_ARRAY_NEW",
    "IR_HOLEY_ARRAY_ELEM_SET",
    "irVectorRuntimeElementKind",
    "irVecElemSetSymbol",
    "irVecNewSizedSymbol",
    "parseIrVectorRuntimeElement",
  ])
    assertNamedForward(facade, "src/ir/core/vector-runtime.ts", name, false, read);
  assertNamedForward(facade, "src/ir/core/vector-runtime.ts", "IrVectorRuntimeElementKind", true, read);
}

function inverseStage(
  read: SourceReader,
  inputOrder: Readonly<Record<string, readonly string[]>>,
  edits: readonly CheckedStageEdit[],
  links: readonly CheckedLinkEdit[],
  removeVectorDeclarations: boolean,
  expectedHashes: Readonly<Record<string, string>>,
): SourceReader {
  const sources = new Map<string, string>();
  for (const path of [supportOwner, callableOwner, manifestContract, manifestOwner]) {
    const rows = orderedDeclarations(path, read, inputOrder);
    let source = read(path);
    // Traverse original positions backwards only to preserve offsets, never
    // sort declarations or repair an unexpected incoming order.
    for (const row of [...rows].reverse()) {
      if (removeVectorDeclarations && path === manifestContract && Object.hasOwn(addedVectorHashes, rowIdentity(row))) {
        source = source.slice(0, row.node.getFullStart()) + source.slice(row.node.end);
        continue;
      }
      let text = row.text;
      for (const edit of edits) {
        if (edit.path !== path || edit.identity !== rowIdentity(row)) continue;
        requireCondition(
          digest([path, edit.identity, edit.before, edit.after]) === edit.hash,
          "pinned clock/vector delta " + edit.identity,
        );
        const at = text.indexOf(edit.before);
        requireCondition(
          at >= 0 && text.indexOf(edit.before, at + 1) < 0,
          "exact clock/vector delta/neighbors " + edit.identity,
        );
        const live = text.slice(at, at + edit.before.length);
        requireCondition(
          digest([path, rowIdentity(row), live, edit.after]) === edit.hash,
          "live clock/vector delta " + edit.identity,
        );
        text = text.slice(0, at) + edit.after + text.slice(at + live.length);
      }
      if (text !== row.text) {
        reparseDeclaration(row, text);
        source = source.slice(0, row.node.getStart()) + text + source.slice(row.node.end);
      }
    }
    for (const edit of links) {
      if (edit.path !== path) continue;
      requireCondition(
        digest([path, edit.before, edit.after]) === edit.hash,
        "pinned clock/vector link inverse " + path,
      );
      const file = parseLive(path, () => source);
      const matches = file.statements.filter(
        (node) => ts.isImportDeclaration(node) && node.getText(file) === edit.before,
      );
      requireCondition(matches.length === 1, "exact clock/vector import inverse " + path);
      const node = matches[0]!;
      requireCondition(
        digest([path, node.getText(file), edit.after]) === edit.hash,
        "live clock/vector import delta " + path,
      );
      source = source.slice(0, node.getStart()) + edit.after + source.slice(node.end);
    }
    const intermediate = orderedDeclarations(path, () => source, preVectorClockOrder);
    requireCondition(
      digest(receiptRows(intermediate)) === expectedHashes[path],
      "checked intermediate declaration receipt " + path,
    );
    sources.set(path, source);
  }
  // Only the four literal reconstructed owners are redirected; other mandatory
  // current modules remain live. This is not an existence/fallback mechanism.
  return (path) => (sources.has(path) ? sources.get(path)! : read(path));
}

export function callableSourceView(
  read: SourceReader,
  version: "pre-vector-clock" | "pre-clock-callable",
): SourceReader {
  assertCurrentClockVectorExtensions(read);
  const preVectorClock = inverseStage(
    read,
    currentOwnerOrder,
    vectorInverseEdits,
    vectorLinkEdits,
    true,
    preVectorClockHashes,
  );
  if (version === "pre-vector-clock") return preVectorClock;
  requireCondition(version === "pre-clock-callable", "unreviewed callable source version");
  const preClock = inverseStage(
    preVectorClock,
    preVectorClockOrder,
    clockInverseEdits,
    clockLinkEdits,
    false,
    preClockCallableHashes,
  );
  assertPreClockCallableExtension(preClock);
  return preClock;
}

export function assertCallableExtension(read: SourceReader): void {
  callableSourceView(read, "pre-clock-callable");
}

export function historicalRuntimeDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  const source = [supportOwner, callableOwner, manifestContract, "src/ir/runtime-manifest.ts"].includes(path)
    ? callableSourceView(read, "pre-clock-callable")
    : read;
  return preClockRuntimeDeclarations(path, source);
}

// Original receipts, not newly measured baselines. A live-source mutation must
// fail the accepted reconstruction before any fixture can use its output.
const historicalHashes: Readonly<Record<string, string>> = {
  [callableOwner]: "ae60c2163949338107ad8f0ba7c2d3e7e2e9e7e469e79ebda871a9f2b7b0700d",
  [manifestContract]: "e7d1bd5d610126b6dcf945ca5584114b21a779b2803139c357f146cb7a16841e",
  [runtimeContract]: "3e3c8fd145f03837dce98ce6b364fabddb88cc98bcc9281304a8a48da009b3f9",
  "src/ir/async-runtime-providers.ts": "e6c4a6e91bf4878715ef9b508342a42f7bd692c7bb8ca32fb33568be13635045",
  "src/ir/runtime-manifest.ts": "3abe53cac71f94ed08ab1c9de8f44bfcc6ca0c254f7d6963bb50e8b572a6f478",
  "src/ir/intrinsics.ts": "eee3f92b352fb705c5addda7f396ce665c329ab53e501cfe1f6d7e0fbd93291f",
  "src/ir/async-plan.ts": "a7aada275dcd9af1111649c58a4fcce678cd018d6b458f431edcf9eb6e61ab77",
  "src/ir/intrinsic-support.ts": "eea4525b21f65d7334af27e6ee195dbbb7ca39b9dd57d5781345b80d60d2e8d7",
};

export function acceptedHistoricalDeclarations(path: string, read: SourceReader): HistoricalDeclaration[] {
  const records =
    path === runtimeContract ? historicalIntrinsicDeclarations(read) : historicalRuntimeDeclarations(path, read);
  requireCondition(
    createHash("sha256")
      .update(JSON.stringify(receiptRows(records)))
      .digest("hex") === historicalHashes[path],
    "unchanged historical declaration receipt " + path,
  );
  return records;
}
