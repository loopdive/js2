// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef } from "./callable-bindings.js";
import type { IrFuncRef, IrType } from "./nodes.js";
import {
  resolveRuntimeHostCapabilityFuncRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityValueType,
} from "./runtime-host-capabilities.js";
import type { RuntimeFeature } from "./runtime-manifest.js";

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

/** Exact structural bindings select declarations; display names and prefixes never do. */
export function irRuntimeCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "runtime" && ref.binding.symbol === "__new_ReferenceError"
    ? REFERENCE_ERROR_DECLARATION
    : undefined;
}
