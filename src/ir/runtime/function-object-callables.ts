// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { arityCallableArity } from "../core/closure-invocation-callables.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import {
  FUNCTION_OBJECT_RUNTIME_FEATURES,
  FUNCTION_OBJECT_RUNTIME_PROVIDER_IDS,
  type FunctionObjectRuntimeFeature,
  type RuntimeFeature,
  type RuntimeProviderDefinition,
} from "./contracts/manifest.js";
import { canonicalProviderMismatch } from "./canonical-provider-mismatch.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const NUMBER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** `js.function.construct:N(callee, ...N)`, spelled like `js.closure.call:N`. */
export const IR_FUNCTION_CONSTRUCT_PREFIX = "js.function.construct:";
/** The `flags` word of `js.function.init`, an exact integer f64 like the descriptor words. */
export const FUNCTION_OBJECT_INIT_FLAGS = Object.freeze({ constructible: 1 });

function declaration(
  feature: FunctionObjectRuntimeFeature,
  symbol: string,
  params: readonly IrType[],
  results: readonly IrType[],
): IrRuntimeCallableDeclaration {
  return Object.freeze({
    feature,
    ref: irIntrinsicFuncRef(symbol),
    params: Object.freeze(params),
    results: Object.freeze(results),
  });
}
const fixed = (feature: FunctionObjectRuntimeFeature, params: readonly IrType[], results: readonly IrType[]) =>
  declaration(feature, feature, params, results);

/**
 * A source function object is its closure struct; its own properties live in the bag (#7354 C).
 *   - `is-callable(value)`: IsCallable (§7.2.3).
 *   - `init(closure, name, length, flags)`: OrdinaryFunctionCreate's `length`, SetFunctionName's `name`, and
 *     MakeConstructor when `flags` carries `constructible`; called once, where the closure becomes a value.
 *   - `has-instance(value, callee)`: OrdinaryHasInstance (§7.3.21), with instanceof's TypeError for a non-callable.
 *   - `this(strict)`: OrdinaryCallBindThis (§10.2.1.2) over the receiver the closure dispatcher installed.
 * These declarations do not grant physical provider or receiver authority.
 */
const DECLARATIONS: Readonly<
  Record<Exclude<FunctionObjectRuntimeFeature, "js.function.construct">, IrRuntimeCallableDeclaration>
> = Object.freeze({
  "js.function.is-callable": fixed("js.function.is-callable", [EXTERNAL], [BOOLEAN]),
  "js.function.init": fixed("js.function.init", [EXTERNAL, EXTERNAL, NUMBER, NUMBER], []),
  "js.function.has-instance": fixed("js.function.has-instance", [EXTERNAL, EXTERNAL], [BOOLEAN]),
  "js.function.this": fixed("js.function.this", [BOOLEAN], [EXTERNAL]),
});

/** Exact semantic binding only; `js.function.construct:N` is the one arity family. */
export function irFunctionObjectCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic") return undefined;
  const { symbol } = ref.binding;
  const arity = arityCallableArity(IR_FUNCTION_CONSTRUCT_PREFIX, symbol);
  if (arity !== undefined)
    return declaration("js.function.construct", symbol, Array(arity + 1).fill(EXTERNAL), [EXTERNAL]);
  return Object.hasOwn(DECLARATIONS, symbol) ? DECLARATIONS[symbol as keyof typeof DECLARATIONS] : undefined;
}

/** Symbolic obligations only. Backend resources and receiver coverage require separate acceptance. */
export const FUNCTION_OBJECT_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  FUNCTION_OBJECT_RUNTIME_FEATURES.map((feature, index) =>
    Object.freeze({
      id: FUNCTION_OBJECT_RUNTIME_PROVIDER_IDS[index]!,
      feature,
      dependencies: Object.freeze([]),
      hostCapabilities: Object.freeze([]),
      supportedTargets: Object.freeze(["standalone"] as const),
      supportedBackends: Object.freeze(["wasmgc"] as const),
      implementation: Object.freeze({ kind: "runtime-callable", symbol: feature } as const),
    }),
  ),
);

export function functionObjectProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return canonicalProviderMismatch(FUNCTION_OBJECT_RUNTIME_PROVIDERS, provider, "function object callable");
}

export function functionObjectCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  if (!FUNCTION_OBJECT_RUNTIME_FEATURES.some((entry) => entry === feature)) return undefined;
  return policy.backend === "wasmgc" && policy.target === "standalone"
    ? undefined
    : `${feature} requires standalone WasmGC`;
}
