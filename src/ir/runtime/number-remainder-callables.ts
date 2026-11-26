// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import { canonicalProviderMismatch } from "./canonical-provider-mismatch.js";
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

/** Provider IDs and features are a closed pair, including the exact ABI and policy support. */
export function numberRemainderProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return canonicalProviderMismatch(NUMBER_REMAINDER_RUNTIME_PROVIDERS, provider, "number remainder callable");
}
