// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import {
  resolveRuntimeHostCapabilityFuncRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityValueType,
} from "./host-capabilities.js";
import type { RuntimeFeature, RuntimeProviderDefinition } from "./contracts/manifest.js";
import type { IntrinsicSignature } from "../core/intrinsic-contracts.js";
import { irNativeAsyncCallableDeclaration } from "./native-async-callables.js";
import { irVectorCallableDeclaration } from "./vector-callables.js";

/** Policy-independent callable contracts; physical providers are selected by the manifest. */
export interface IrRuntimeCallableDeclaration {
  readonly feature: RuntimeFeature;
  readonly ref: IrFuncRef;
  readonly params: readonly IrType[];
  readonly results: readonly IrType[];
}

function semanticTypes(types: readonly RuntimeHostCapabilityValueType[]): readonly IrType[] {
  return Object.freeze(types.map((kind) => Object.freeze({ kind: "val" as const, val: Object.freeze({ kind }) })));
}

// Derive the shared ABI from the central record, not from any call's operands
// or the allocating legacy runtime resolver.
const referenceError = resolveRuntimeHostCapabilityFuncRecord(
  RUNTIME_HOST_CAPABILITY_RECORDS,
  "error.reference.construct",
);
const REFERENCE_ERROR_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "error.reference.construct",
  ref: irRuntimeFuncRef(referenceError.field),
  params: semanticTypes(referenceError.params),
  results: semanticTypes(referenceError.results),
});

/** ReferenceError remains the same single-result host-record-derived contract. */
export const REFERENCE_ERROR_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: 1,
  params: REFERENCE_ERROR_DECLARATION.params,
  result: REFERENCE_ERROR_DECLARATION.results[0]!,
});

/** TDZ constructor providers use target policy and the shared callable signature. */
export const REFERENCE_ERROR_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "host.error.reference.construct",
    feature: REFERENCE_ERROR_DECLARATION.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze(["error.reference.construct"] as const),
    supportedTargets: Object.freeze(["host"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "host-callable", capability: "error.reference.construct" } as const),
  }),
  Object.freeze({
    id: "native.error.reference.construct",
    feature: REFERENCE_ERROR_DECLARATION.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    // The existing native constructor builds a WasmGC Error struct and
    // converts it to externref. Its name does not establish a linear adapter.
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: "__new_ReferenceError" } as const),
  }),
]);

/** Exact structural bindings select declarations; display names and prefixes never do. */
export function irRuntimeCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "runtime" && ref.binding.symbol === "__new_ReferenceError"
    ? REFERENCE_ERROR_DECLARATION
    : (irNativeAsyncCallableDeclaration(ref) ?? irVectorCallableDeclaration(ref));
}
