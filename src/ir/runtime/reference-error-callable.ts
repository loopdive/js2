// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef } from "../core/callable-bindings.js";
import type { IntrinsicSignature } from "../core/intrinsic-contracts.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityValueType,
  resolveRuntimeHostCapabilityFuncRecord,
} from "./host-capabilities.js";

function semanticTypes(types: readonly RuntimeHostCapabilityValueType[]): readonly IrType[] {
  return Object.freeze(types.map((kind) => Object.freeze({ kind: "val" as const, val: Object.freeze({ kind }) })));
}

// Derive the shared ABI from the central record, not from any call's operands
// or the allocating legacy runtime resolver.
const referenceError = resolveRuntimeHostCapabilityFuncRecord(
  RUNTIME_HOST_CAPABILITY_RECORDS,
  "error.reference.construct",
);
export const REFERENCE_ERROR_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
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
    implementation: Object.freeze({
      kind: "host-callable",
      capability: "error.reference.construct",
    } as const),
  }),
  Object.freeze({
    id: "native.error.reference.construct",
    feature: REFERENCE_ERROR_DECLARATION.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    // Both native backends bind the reserved canonical opaque Error recipe.
    // Selection alone never supplies a constructor or exception resource.
    supportedBackends: Object.freeze(["wasmgc", "linear"] as const),
    implementation: Object.freeze({
      kind: "runtime-callable",
      symbol: "__new_ReferenceError",
    } as const),
  }),
]);

/** Selection binds the complete canonical descriptor, never only its ID. */
export function referenceErrorProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  if (
    provider.feature !== REFERENCE_ERROR_DECLARATION.feature &&
    !REFERENCE_ERROR_RUNTIME_PROVIDERS.some((candidate) => candidate.id === provider.id)
  )
    return undefined;
  const canonical = REFERENCE_ERROR_RUNTIME_PROVIDERS.find((candidate) => candidate.id === provider.id);
  if (!canonical) return "ReferenceError callable provider id mismatch";
  for (const field of ["feature", "signature", "implementation"] as const)
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `ReferenceError callable provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `ReferenceError callable provider ${field} mismatch`;
  return undefined;
}
