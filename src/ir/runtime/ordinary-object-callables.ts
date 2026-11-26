// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";
import {
  ORDINARY_OBJECT_RUNTIME_FEATURES,
  ORDINARY_OBJECT_RUNTIME_PROVIDER_IDS,
  type OrdinaryObjectRuntimeFeature,
  type RuntimeFeature,
  type RuntimeProviderDefinition,
} from "./contracts/manifest.js";
import { canonicalProviderMismatch } from "./canonical-provider-mismatch.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const FLAGS: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });
const SELECTOR: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32" }) });

function declaration(
  feature: OrdinaryObjectRuntimeFeature,
  params: readonly IrType[],
  results: readonly IrType[],
): IrRuntimeCallableDeclaration {
  return Object.freeze({
    feature,
    ref: irIntrinsicFuncRef(feature),
    params: Object.freeze(params),
    results: Object.freeze(results),
  });
}

/**
 * Ordinary property semantics, separate from fixed-field object.new/get/set.
 * Keys are already canonical String/Symbol PropertyKeys. Get retains its
 * original receiver independently of the prototype-walk cursor.
 *
 * Descriptor words use the existing exact integer f64 encoding: W/E/C values
 * in bits 0..2, their presence in 3..5, value presence in 7, getter/setter
 * presence in 8/9. Accessor operations require explicit half-presence bits;
 * zero must never inherit the historical "both specified" fallback. The
 * attributes-only operation preserves the existing property's kind and value.
 * These declarations do not grant physical provider or receiver authority.
 */
const DECLARATIONS: Readonly<Record<OrdinaryObjectRuntimeFeature, IrRuntimeCallableDeclaration>> = Object.freeze({
  "js.object.create-default": declaration("js.object.create-default", [], [EXTERNAL]),
  "js.object.create-null": declaration("js.object.create-null", [], [EXTERNAL]),
  "js.object.create-with-prototype": declaration("js.object.create-with-prototype", [EXTERNAL], [EXTERNAL]),
  "js.object.define-data": declaration("js.object.define-data", [EXTERNAL, EXTERNAL, EXTERNAL, FLAGS], []),
  "js.object.define-accessor": declaration(
    "js.object.define-accessor",
    [EXTERNAL, EXTERNAL, EXTERNAL, EXTERNAL, FLAGS],
    [],
  ),
  "js.object.define-attributes": declaration("js.object.define-attributes", [EXTERNAL, EXTERNAL, FLAGS], []),
  "js.object.get": declaration("js.object.get", [EXTERNAL, EXTERNAL, EXTERNAL], [EXTERNAL]),
  "js.object.has": declaration("js.object.has", [EXTERNAL, EXTERNAL], [BOOLEAN]),
  // (#7354 O4) A TypeError the realm builds, its message a native string: the dynamic-value legalization's
  // RequireObjectCoercible.
  "js.object.create-type-error": declaration("js.object.create-type-error", [EXTERNAL], [EXTERNAL]),
  // (#7354 O3) OrdinarySet (§10.1.9.2): the original receiver beside the object whose chain it walks, as Get's.
  "js.object.set": declaration("js.object.set", [EXTERNAL, EXTERNAL, EXTERNAL, EXTERNAL], [BOOLEAN]),
  // (#7354 G1) Whether an object has [[ErrorData]] (`Object.prototype.toString`'s "Error" tag).
  "js.object.is-error": declaration("js.object.is-error", [EXTERNAL], [BOOLEAN]),
  // (#7354 G1) A new error of the Error constructor `selector` (its index in `NATIVE_ERROR_CONSTRUCTORS`), with the
  // already converted `message`, or none for null; and Error.prototype.toString of an object (§20.5.3.4).
  "js.object.create-error": declaration("js.object.create-error", [EXTERNAL, SELECTOR], [EXTERNAL]),
  "js.object.error-to-string": declaration("js.object.error-to-string", [EXTERNAL], [EXTERNAL]),
  // (#7354 F1b) A source function object's own properties, once, right after its closure is created: `length`,
  // `name` (a native string) and, for a constructor (the Boolean), `prototype` (`source-function-object-bodies.ts`).
  "js.object.init-function": declaration("js.object.init-function", [EXTERNAL, EXTERNAL, FLAGS, BOOLEAN], []),
  // (#7354 C2) Whether the second value is on the first's [[Prototype]] chain (OrdinaryHasInstance's walk).
  "js.object.inherits": declaration("js.object.inherits", [EXTERNAL, EXTERNAL], [BOOLEAN]),
  // (#7354 O1) The realm's half of the `Object` statics, after the caller's kind tests and ToPropertyKey: an object
  // (ordinary or function), a canonical key, and the descriptor object ToPropertyDescriptor reads, then
  // DefinePropertyOrThrow (`Object.defineProperty`); ObjectDefineProperties over an object's own enumerable properties
  // (`Object.defineProperties`, `Object.create`'s second argument); FromPropertyDescriptor of an own property, or
  // `undefined` (`Object.getOwnPropertyDescriptor`).
  "js.object.descriptor-define": declaration("js.object.descriptor-define", [EXTERNAL, EXTERNAL, EXTERNAL], []),
  "js.object.descriptors-define": declaration("js.object.descriptors-define", [EXTERNAL, EXTERNAL], []),
  "js.object.own-descriptor": declaration("js.object.own-descriptor", [EXTERNAL, EXTERNAL], [EXTERNAL]),
  // (#7354 P1, G1) The built-in function object the realm holds for `selector` (its index in
  // `NATIVE_VALUE_INTRINSICS`), and HasOwnProperty of a canonical key on an ordinary or function object, also
  // requiring the enumerable attribute when `selector` is 1.
  "js.object.intrinsic": declaration("js.object.intrinsic", [SELECTOR], [EXTERNAL]),
  "js.object.has-own": declaration("js.object.has-own", [EXTERNAL, EXTERNAL, SELECTOR], [BOOLEAN]),
});

/** Exact semantic binding only; neither display names nor runtime aliases qualify. */
export function irOrdinaryObjectCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic" || !Object.hasOwn(DECLARATIONS, ref.binding.symbol)) return undefined;
  return DECLARATIONS[ref.binding.symbol as OrdinaryObjectRuntimeFeature];
}

/** Symbolic obligations only. Backend resources and receiver coverage require separate acceptance. */
export const ORDINARY_OBJECT_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  ORDINARY_OBJECT_RUNTIME_FEATURES.map((feature, index) =>
    Object.freeze({
      id: ORDINARY_OBJECT_RUNTIME_PROVIDER_IDS[index]!,
      feature,
      dependencies: Object.freeze([]),
      hostCapabilities: Object.freeze([]),
      supportedTargets: Object.freeze(["standalone"] as const),
      supportedBackends: Object.freeze(["wasmgc"] as const),
      implementation: Object.freeze({ kind: "runtime-callable", symbol: feature } as const),
    }),
  ),
);

export function ordinaryObjectProviderMismatch(provider: RuntimeProviderDefinition): string | undefined {
  return canonicalProviderMismatch(ORDINARY_OBJECT_RUNTIME_PROVIDERS, provider, "ordinary object callable");
}

export function ordinaryObjectCallablePolicyMismatch(
  feature: RuntimeFeature,
  policy: RuntimeManifestPolicy,
): string | undefined {
  if (!Object.hasOwn(DECLARATIONS, feature)) return undefined;
  return policy.backend === "wasmgc" && policy.target === "standalone"
    ? undefined
    : `${feature} requires standalone WasmGC`;
}
