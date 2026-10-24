// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import {
  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,
  type RuntimeFeature,
  type RuntimeProviderDefinition,
} from "./contracts/manifest.js";
import { irClosureInvocationCallableDeclaration } from "./closure-invocation-callables.js";
import {
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  nativeAsyncProviderMismatch,
  nativeAsyncCallablePolicyMismatch,
  irNativeAsyncCallableDeclaration,
} from "./native-async-callables.js";
import {
  VECTOR_CALLABLE_RUNTIME_PROVIDERS,
  vectorProviderMismatch,
  vectorCallablePolicyMismatch,
  irVectorCallableDeclaration,
} from "./vector-callables.js";
import {
  irNumberRemainderCallableDeclaration,
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
  numberRemainderProviderMismatch,
} from "./number-remainder-callables.js";
import { irNumberConversionCallableDeclaration } from "./number-conversion-callable.js";
import {
  ORDINARY_OBJECT_RUNTIME_PROVIDERS,
  ordinaryObjectProviderMismatch,
  ordinaryObjectCallablePolicyMismatch,
  irOrdinaryObjectCallableDeclaration,
} from "./ordinary-object-callables.js";

import {
  irClassValueAllocationDeclaration,
  CLASS_VALUE_ALLOCATION_PROVIDER,
  classValueAllocationProviderMismatch,
  classValueAllocationPolicyMismatch,
} from "./class-value-callable.js";

import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";

/** Policy-independent callable contracts; physical providers are selected by the manifest. */
export interface IrRuntimeCallableDeclaration {
  readonly feature: RuntimeFeature;
  readonly ref: IrFuncRef;
  readonly params: readonly IrType[];
  readonly results: readonly IrType[];
}

export { REFERENCE_ERROR_SIGNATURE, REFERENCE_ERROR_RUNTIME_PROVIDERS } from "./error-callables.js";
import {
  irErrorConstructorDeclaration,
  TYPE_ERROR_RUNTIME_PROVIDER,
  errorConstructorProviderMismatch,
  errorConstructorPolicyMismatch,
} from "./error-callables.js";
/** Exact structural bindings select declarations; display names and prefixes never do. */
export function irRuntimeCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return (
    irErrorConstructorDeclaration(ref) ??
    irClassValueAllocationDeclaration(ref) ??
    irNativeAsyncCallableDeclaration(ref) ??
    irVectorCallableDeclaration(ref) ??
    irOrdinaryObjectCallableDeclaration(ref) ??
    irNumberConversionCallableDeclaration(ref) ??
    irNumberRemainderCallableDeclaration(ref) ??
    irClosureInvocationCallableDeclaration(ref)
  );
}

/** Canonical symbolic callable families; physical materialization remains a separate obligation. */
export const SEMANTIC_CALLABLE_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  CLASS_VALUE_ALLOCATION_PROVIDER,
  TYPE_ERROR_RUNTIME_PROVIDER,
  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  ...VECTOR_CALLABLE_RUNTIME_PROVIDERS,
  ...ORDINARY_OBJECT_RUNTIME_PROVIDERS,
  ...NUMBER_REMAINDER_RUNTIME_PROVIDERS,
]);

export function semanticCallableProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return (
    errorConstructorProviderMismatch(provider) ??
    classValueAllocationProviderMismatch(provider) ??
    nativeAsyncProviderMismatch(provider) ??
    vectorProviderMismatch(provider) ??
    ordinaryObjectProviderMismatch(provider) ??
    numberRemainderProviderMismatch(provider)
  );
}

export function semanticCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  return NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)
    ? nativeAsyncCallablePolicyMismatch(feature, policy)
    : (errorConstructorPolicyMismatch(feature, policy) ??
        classValueAllocationPolicyMismatch(feature, policy) ??
        vectorCallablePolicyMismatch(feature, policy) ??
        ordinaryObjectCallablePolicyMismatch(feature, policy));
}
