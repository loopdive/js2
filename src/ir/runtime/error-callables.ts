// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irRuntimeFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { RuntimeHostCapabilityValueType } from "./host-capabilities.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import { resolveRuntimeHostCapabilityFuncRecord, RUNTIME_HOST_CAPABILITY_RECORDS } from "./host-capabilities.js";
import type { RuntimeProviderDefinition, RuntimeFeature } from "./contracts/manifest.js";
import type { IntrinsicSignature } from "../core/intrinsic-contracts.js";
import { preparedIrDataMismatch } from "../program/data.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";

// Both native errors use the established message/result ABI, without adding a host capability.
const record = resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "error.reference.construct");
const types = (values: readonly RuntimeHostCapabilityValueType[]): readonly IrType[] =>
  Object.freeze(values.map((kind) => Object.freeze({ kind: "val" as const, val: Object.freeze({ kind }) })));
const params = types(record.params),
  results = types(record.results);
export type NativeErrorConstructorKind = "ReferenceError" | "TypeError";
export const NATIVE_ERROR_CONSTRUCTOR_KINDS = Object.freeze(["ReferenceError", "TypeError"] as const);
const declaration = (feature: RuntimeFeature, symbol: string): IrRuntimeCallableDeclaration =>
  Object.freeze({
    feature,
    ref: irRuntimeFuncRef(symbol),
    params,
    results,
  });
const reference = declaration("error.reference.construct", record.field);
const type = declaration("error.type.construct", "__new_TypeError");
const signature = (value: IrRuntimeCallableDeclaration): IntrinsicSignature =>
  Object.freeze({
    version: 1,
    params: value.params,
    result: value.results[0]!,
  });
export const REFERENCE_ERROR_SIGNATURE = signature(reference);
export const TYPE_ERROR_SIGNATURE = signature(type);
function nativeProvider(kind: NativeErrorConstructorKind): RuntimeProviderDefinition {
  const value = kind === "ReferenceError" ? reference : type;
  return Object.freeze({
    id: kind === "ReferenceError" ? "native.error.reference.construct" : "native.error.type.construct",
    feature: value.feature,
    signature: kind === "ReferenceError" ? REFERENCE_ERROR_SIGNATURE : TYPE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({
      kind: "runtime-callable",
      symbol: kind === "ReferenceError" ? "__new_ReferenceError" : "__new_TypeError",
    } as const),
  });
}
export const REFERENCE_ERROR_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "host.error.reference.construct",
    feature: reference.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze(["error.reference.construct"] as const),
    supportedTargets: Object.freeze(["host"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "host-callable", capability: "error.reference.construct" } as const),
  }),
  nativeProvider("ReferenceError"),
]);
export const TYPE_ERROR_RUNTIME_PROVIDER = nativeProvider("TypeError");
export function nativeErrorConstructorProvider(kind: NativeErrorConstructorKind): RuntimeProviderDefinition {
  if (kind !== "ReferenceError" && kind !== "TypeError") throw new Error("unknown native Error constructor kind");
  return kind === "ReferenceError" ? REFERENCE_ERROR_RUNTIME_PROVIDERS[1]! : TYPE_ERROR_RUNTIME_PROVIDER;
}
export function irErrorConstructorDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  const binding = ref.binding;
  return binding.kind !== "runtime"
    ? undefined
    : [reference, type].find(
        (value) => value.ref.binding.kind === "runtime" && value.ref.binding.symbol === binding.symbol,
      );
}
export function errorConstructorProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  const expected = [TYPE_ERROR_RUNTIME_PROVIDER, ...REFERENCE_ERROR_RUNTIME_PROVIDERS].find(
    (row) => row.id === provider.id,
  );
  return expected && preparedIrDataMismatch(provider, expected) !== undefined
    ? "error constructor provider differs from its canonical declaration"
    : undefined;
}
export function errorConstructorPolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  return feature === "error.type.construct" &&
    (policy.backend !== "wasmgc" || !["standalone", "wasi"].includes(policy.target))
    ? "TypeError constructor requires no-host WasmGC"
    : undefined;
}
