// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";

/** Full Number(value), including observable ToPrimitive(number), Symbol error
 * and BigInt conversion. This must never alias primitive numeric unboxing.
 * Represent it as a call so optimization retains arbitrary user effects.
 */
const DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "js.number.from-value",
  ref: irIntrinsicFuncRef("js.number.from-value"),
  params: Object.freeze([Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "externref" as const }) })]),
  results: Object.freeze([Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "f64" as const }) })]),
});
export function irNumberConversionCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "intrinsic" && ref.binding.symbol === IR_NUMBER_FROM_VALUE_FEATURE
    ? DECLARATION
    : undefined;
}

export const IR_NUMBER_FROM_VALUE_FEATURE = "js.number.from-value";
/**
 * (#7106 module-init lever B) The host-free provider: a defined function
 * codegen builds from legacy's own `Number(v)` emitter over a detached
 * template (`codegen/helpers/ir-number-from-value.ts`), so the full
 * ToNumeric protocol is legacy's, byte for byte. Host lanes have no provider
 * yet; the selector admits the call only where this one holds.
 */
export const IR_NUMBER_FROM_VALUE_NATIVE_FN = "__ir_number_from_value";
export const NUMBER_CONVERSION_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "native.js.number.from-value",
    feature: IR_NUMBER_FROM_VALUE_FEATURE,
    signature: Object.freeze({ version: 1, params: DECLARATION.params, result: DECLARATION.results[0]! }),
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: IR_NUMBER_FROM_VALUE_NATIVE_FN } as const),
  }),
]);
