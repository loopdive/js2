// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { irVecElemSetSymbol } from "../core/vector-runtime.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeFeature, RuntimeProviderDefinition } from "./contracts/manifest.js";
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const I32: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });
const SYMBOL = irVecElemSetSymbol(F64);

/** Declaration only. The indexed intrinsic needs an independently checked append protocol. */
export const NUMERIC_APPEND_DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "js.vector.append.f64",
  ref: irIntrinsicFuncRef(SYMBOL),
  params: Object.freeze([Object.freeze({ kind: "vec", elementType: F64, nullable: true } as const), I32, F64]),
  results: Object.freeze([]),
});
export function irNumericAppendCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "intrinsic" && ref.binding.symbol === SYMBOL ? NUMERIC_APPEND_DECLARATION : undefined;
}
export const NUMERIC_APPEND_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "native.js.vector.append.f64",
    feature: NUMERIC_APPEND_DECLARATION.feature,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    supportedBackends: Object.freeze(["linear", "wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: SYMBOL } as const),
  }),
]);
export function numericAppendProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  const canonical = NUMERIC_APPEND_RUNTIME_PROVIDERS[0]!;
  if (provider.id !== canonical.id && provider.feature !== canonical.feature) return undefined;
  for (const field of ["id", "feature", "signature", "implementation"] as const)
    if (JSON.stringify(provider[field]) !== JSON.stringify(canonical[field]))
      return `numeric append provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (JSON.stringify([...provider[field]].sort()) !== JSON.stringify([...canonical[field]].sort()))
      return `numeric append provider ${field} mismatch`;
  return undefined;
}
export function numericAppendCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  if (feature !== NUMERIC_APPEND_DECLARATION.feature) return undefined;
  return (policy.backend === "linear" || policy.backend === "wasmgc") &&
    (policy.target === "standalone" || policy.target === "wasi")
    ? undefined
    : `${feature} requires native Linear or WasmGC standalone/WASI`;
}
