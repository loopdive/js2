// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef } from "./callable-bindings.js";
import type { IrType } from "./types.js";

export const REFERENCE_ERROR_HOST_RECORD = Object.freeze({
  capability: "error.reference.construct" as const,
  module: "env" as const,
  field: "__new_ReferenceError",
  kind: "func" as const,
  params: Object.freeze(["externref"] as const),
  results: Object.freeze(["externref"] as const),
});

function semanticTypes(types: readonly "externref"[]): readonly IrType[] {
  return Object.freeze(types.map((kind) => Object.freeze({ kind: "val" as const, val: Object.freeze({ kind }) })));
}

export const REFERENCE_ERROR_DECLARATION = Object.freeze({
  feature: "error.reference.construct",
  ref: irRuntimeFuncRef(REFERENCE_ERROR_HOST_RECORD.field),
  params: semanticTypes(REFERENCE_ERROR_HOST_RECORD.params),
  results: semanticTypes(REFERENCE_ERROR_HOST_RECORD.results),
});

/** ReferenceError remains the same single-result host-record-derived contract. */
export const REFERENCE_ERROR_SIGNATURE = Object.freeze({
  version: 1,
  params: REFERENCE_ERROR_DECLARATION.params,
  result: REFERENCE_ERROR_DECLARATION.results[0]!,
});

/** TDZ constructor providers use target policy and the shared callable signature. */
export const REFERENCE_ERROR_RUNTIME_PROVIDERS = Object.freeze([
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
