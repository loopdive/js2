// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const PARAMS = Object.freeze([F64, F64]);
const RESULTS = Object.freeze([F64]);
const DECLARATIONS: readonly IrRuntimeCallableDeclaration[] = Object.freeze([
  Object.freeze({
    feature: "js.number.remainder",
    ref: irIntrinsicFuncRef("__fmod"),
    params: PARAMS,
    results: RESULTS,
  }),
  Object.freeze({
    feature: "js.number.remainder.early-magnitude",
    ref: irIntrinsicFuncRef("__fmod_early_magnitude"),
    params: PARAMS,
    results: RESULTS,
  }),
]);

/** Two exact intrinsic bindings; compatibility names cannot select a remainder helper. */
export function irNumberRemainderCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic") return undefined;
  const symbol = ref.binding.symbol;
  return DECLARATIONS.find(
    (declaration) => declaration.ref.binding.kind === "intrinsic" && declaration.ref.binding.symbol === symbol,
  );
}

/** Pure f64 Wasm bodies require neither host capabilities nor backend-specific carriers. */
export const NUMBER_REMAINDER_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  DECLARATIONS.map((declaration, index) => {
    if (declaration.ref.binding.kind !== "intrinsic")
      throw new Error("number remainder declaration requires an intrinsic binding");
    return Object.freeze({
      id: index === 0 ? "backend.js.number.remainder" : "backend.js.number.remainder.early-magnitude",
      feature: declaration.feature,
      signature: Object.freeze({ version: 1, params: PARAMS, result: F64 }),
      dependencies: Object.freeze([]),
      hostCapabilities: Object.freeze([]),
      supportedTargets: Object.freeze(["host", "standalone", "strict-no-host", "wasi"] as const),
      supportedBackends: Object.freeze(["linear", "wasmgc"] as const),
      implementation: Object.freeze({
        kind: "runtime-callable",
        symbol: declaration.ref.binding.symbol,
      } as const),
    });
  }),
);

/** Compare the finite data records directly; custom serializers are never evidence. */
function sameData(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (actual === null || typeof actual !== "object" || Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Reflect.ownKeys(expected);
  if (keys.length !== Reflect.ownKeys(actual).length) return false;
  return keys.every((key) => {
    const left = Object.getOwnPropertyDescriptor(expected, key);
    const right = Object.getOwnPropertyDescriptor(actual, key);
    return (
      left !== undefined &&
      right !== undefined &&
      "value" in left &&
      "value" in right &&
      sameData(left.value, right.value)
    );
  });
}

/** Provider IDs and features are a closed pair, including the exact ABI and policy support. */
export function numberRemainderProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  const canonical = NUMBER_REMAINDER_RUNTIME_PROVIDERS.find(
    (entry) => entry.id === provider.id || entry.feature === provider.feature,
  );
  if (!canonical) return undefined;
  for (const field of ["id", "feature", "signature", "implementation"] as const)
    if (!sameData(canonical[field], provider[field])) return `number remainder callable provider ${field} mismatch`;
  for (const field of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (!sameData([...canonical[field]].sort(), [...provider[field]].sort()))
      return `number remainder callable provider ${field} mismatch`;
  return undefined;
}
