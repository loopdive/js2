// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { INTRINSIC_DEFINITIONS } from "../core/intrinsics.js";
import { DYNAMIC_VALUE_RUNTIME_FEATURES, type DynamicValueRuntimeFeature } from "./contracts/intrinsics.js";
import {
  DYNAMIC_VALUE_RUNTIME_PROVIDER_IDS,
  type RuntimeFeature,
  type RuntimeProviderDefinition,
} from "./contracts/manifest.js";
import { canonicalProviderMismatch } from "./canonical-provider-mismatch.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";

/**
 * (#7354 D1) The physical function behind each dynamic-value operation. The
 * number and Boolean `typeof` tag tests (#7354 Ty) are the existing
 * primitive-carrier predicates the native value and Boolean resources already
 * define; the string test and read (#7354 Str2), equality, ToBoolean (#7354 T), the `undefined` value and (#7354 Fa)
 * the function test, (#7354 J) QuoteJSONString and the named abort are the dynamic-value resources' own functions.
 */
const SYMBOLS: Readonly<Record<DynamicValueRuntimeFeature, string>> = Object.freeze({
  "js.value.as_string": "__js_as_string",
  "js.value.is_boolean": "__typeof_boolean",
  "js.value.is_function": "__typeof_function",
  "js.value.is_number": "__typeof_number",
  "js.value.is_string": "__typeof_string",
  "js.value.json_quote": "__json_quote_string",
  "js.value.strict_eq": "__js_strict_eq",
  "js.value.to_boolean": "__is_truthy",
  "js.value.undefined": "__js_undefined",
  "js.value.unsupported": "__js_value_unsupported",
});

/** One native arm per operation: the dynamic value exists only on standalone WasmGC. */
export const DYNAMIC_VALUE_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  DYNAMIC_VALUE_RUNTIME_FEATURES.map((feature, index) =>
    Object.freeze({
      id: DYNAMIC_VALUE_RUNTIME_PROVIDER_IDS[index]!,
      feature,
      signature: INTRINSIC_DEFINITIONS[feature].signature,
      dependencies: Object.freeze([]),
      hostCapabilities: Object.freeze([]),
      supportedTargets: Object.freeze(["standalone"] as const),
      supportedBackends: Object.freeze(["wasmgc"] as const),
      implementation: Object.freeze({ kind: "runtime-callable", symbol: SYMBOLS[feature] } as const),
    }),
  ),
);

export function dynamicValueProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return canonicalProviderMismatch(DYNAMIC_VALUE_RUNTIME_PROVIDERS, provider, "dynamic value");
}

export function dynamicValuePolicyMismatch(feature: RuntimeFeature, policy: RuntimeManifestPolicy): string | undefined {
  if (!Object.hasOwn(SYMBOLS, feature)) return undefined;
  return policy.backend === "wasmgc" && policy.target === "standalone"
    ? undefined
    : `${feature} requires standalone WasmGC`;
}
