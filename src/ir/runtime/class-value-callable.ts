// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeProviderDefinition, RuntimeFeature } from "./contracts/manifest.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import { runtimeProviderDataMismatch } from "./provider-data.js";

export const CLASS_VALUE_ALLOCATE = "class.value.allocate";
const external: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
export const CLASS_VALUE_ALLOCATION_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: CLASS_VALUE_ALLOCATE,
  ref: irIntrinsicFuncRef(CLASS_VALUE_ALLOCATE),
  params: Object.freeze([
    Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "funcref" as const }) }),
    Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "i32" as const }) }),
    external,
    external,
    external,
  ]),
  results: Object.freeze([external]),
});
export const CLASS_VALUE_ALLOCATION_PROVIDER: RuntimeProviderDefinition = Object.freeze({
  id: "native.class.value.allocate",
  feature: CLASS_VALUE_ALLOCATE,
  dependencies: Object.freeze([]),
  hostCapabilities: Object.freeze([]),
  supportedTargets: Object.freeze(["standalone"] as const),
  supportedBackends: Object.freeze(["wasmgc"] as const),
  implementation: Object.freeze({ kind: "runtime-callable", symbol: CLASS_VALUE_ALLOCATE } as const),
});
export function irClassValueAllocationDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "intrinsic" && ref.binding.symbol === CLASS_VALUE_ALLOCATE
    ? CLASS_VALUE_ALLOCATION_DECLARATION
    : undefined;
}
export function classValueAllocationProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return (provider.id === CLASS_VALUE_ALLOCATION_PROVIDER.id || provider.feature === CLASS_VALUE_ALLOCATE) &&
    runtimeProviderDataMismatch(CLASS_VALUE_ALLOCATION_PROVIDER, provider) !== undefined
    ? "class allocation provider differs from its canonical declaration"
    : undefined;
}
export function classValueAllocationPolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  return feature === CLASS_VALUE_ALLOCATE && (policy.backend !== "wasmgc" || policy.target !== "standalone")
    ? "class.value.allocate requires standalone WasmGC"
    : undefined;
}
