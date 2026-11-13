// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-backend IR legality verifier (#1850).
//
// `verifyIrFunction` answers "is this a valid IR function?". This pass answers
// the emit-boundary question: "is this valid IR legal for the selected backend
// emitter?". Keeping the check before lowering gives unsupported backend
// surfaces a localized diagnostic instead of a late raw-emitter throw or
// malformed Wasm/bytecode.

import type { CompileTargetProfile } from "../../target-profile.js";
import type { IrBackendKind } from "../analysis/backend-legality.js";
export type { IrBackendKind, IrBackendLegalityError, IrBackendFnctorResolver } from "../analysis/backend-legality.js";
export { verifyIrBackendLegality } from "../analysis/backend-legality.js";

/** Source/target features whose availability is known before IR construction. */
export type IrBackendTargetCapability =
  | "host-date-snapshot"
  | "host-regexp-constructor"
  | "host-object-define-property"
  | "standalone-function-prototype-call"
  | "native-regexp"
  | "native-function-methods"
  | "standalone-wrapper-instanceof"
  | "primitive-wrapper-to-primitive"
  | "legacy-numeric-array-global"
  | "number-to-string"
  | "native-json-codec"
  | "native-object-tostring-tag"
  | "native-dynamic-construct"
  | "native-string-carrier-coercion"
  | "native-arguments-length"
  | "native-current-this"
  | "native-own-property-test"
  | "host-dynamic-method-call"
  | "native-own-property-introspection"
  | "native-array-is-array"
  | "native-number-conversion"
  | "prepared-dynamic-helper-abi"
  | "native-dynamic-member-read"
  | "planned-closure-direct-call"
  | "native-dynamic-loose-equality"
  | "dynamic-method-call-wrapper"
  | "native-global-function-call"
  | "native-object-statics";

/**
 * The target facts needed by pre-claim capability checks. Keep this smaller
 * than CodegenContext so the selector and non-Wasm backends can share the
 * legality decision without depending on legacy codegen state.
 */
export interface IrBackendTargetProfile {
  readonly backend: IrBackendKind;
  readonly target: "gc" | "linear" | "standalone" | "wasi";
  readonly allowHostImports: boolean;
  /** Legacy fast-array storage has a distinct ABI not yet represented in IR. */
  readonly fast?: boolean;
  /**
   * (#7338) A JS environment under the native-first policy, projected as
   * standalone. Read only by a capability measured on the host-free target
   * alone, so that the JS environment's output does not move with it. Retired
   * with that capability's split: when the JS environment adopts the statics
   * table and `object-create-call.ts` folds into it.
   */
  readonly nativeRegimeInJs?: true;
}

/**
 * Exact IR projection of the compiler's normalized target policy (#4396).
 *
 * `allowHostImports` means ambient JavaScript capability imports, not JS value
 * interop. A JS value bridge may remain enabled when this is false.
 */
export function projectIrBackendTargetProfile(
  profile: CompileTargetProfile,
  options: { readonly fast?: boolean } = {},
): IrBackendTargetProfile {
  // (#5385) The IR asks a SEMANTIC question here ("which provider regime lowers
  // this?"), not an environment one. A JS-environment build under the
  // native-first policy lowers with the standalone regime and never receives
  // an implicit host semantic import, so it projects exactly like standalone.
  const nativeRegimeInJs = profile.nativeRegime && profile.target === "gc";
  return Object.freeze({
    backend: profile.backend,
    target: nativeRegimeInJs ? "standalone" : profile.target,
    allowHostImports:
      profile.environment === "javascript" && profile.capabilityPolicy === "ambient-js" && !nativeRegimeInJs,
    fast: options.fast,
    ...(nativeRegimeInJs ? { nativeRegimeInJs: true as const } : {}),
  });
}

/**
 * A compile's {@link supportsIrBackendTargetCapability}, over its projected
 * target profile: the one question selection, lowering and the IR-first gate
 * ask of a compile.
 */
export function irBackendCapabilityQuery(compile: {
  readonly targetProfile: CompileTargetProfile;
  readonly fast?: boolean;
}): (capability: IrBackendTargetCapability) => boolean {
  const profile = projectIrBackendTargetProfile(compile.targetProfile, { fast: compile.fast });
  return (capability) => supportsIrBackendTargetCapability(profile, capability);
}

/**
 * Answer predictable target/provider questions before build/lower.
 *
 * This is deliberately separate from verifyIrBackendLegality: a false result
 * is an expected source/target capability exit, while a later legality error
 * after this function returned true is an Invariant (the backend promise was
 * contradicted).
 */
export function supportsIrBackendTargetCapability(
  profile: IrBackendTargetProfile,
  capability: IrBackendTargetCapability,
): boolean {
  switch (capability) {
    case "host-date-snapshot":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "host-regexp-constructor":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "host-object-define-property":
      return profile.backend === "wasmgc" && profile.target === "gc" && profile.allowHostImports;
    case "standalone-function-prototype-call":
    // (#3791, #7106 lever R) The in-module RegExp: construction from a static
    // pattern (`ensureIrRegExpLiteralHelper`) and the `$NativeRegExp` carrier helpers.
    case "native-regexp":
    // (#3793) Fnctor array methods and retained function-object method wrappers
    // through legacy's closed dispatcher.
    case "native-function-methods":
      return profile.backend === "wasmgc" && profile.target === "standalone" && !profile.allowHostImports;
    case "standalone-wrapper-instanceof":
      // The IR producer consumes the fast lane's native `$AnyValue` object
      // payload as anyref. Non-fast standalone carries dynamic values as
      // externref and needs an explicit extern→any conversion node first.
      return (
        profile.backend === "wasmgc" &&
        profile.target === "standalone" &&
        !profile.allowHostImports &&
        profile.fast === true
      );
    case "primitive-wrapper-to-primitive":
      // #4208 S4 / #7106 — a fresh wrapper operand crosses the wrapper object's
      // externref through the canonical `__to_primitive` runtime boundary,
      // then boxes that primitive into the dynamic carrier. That boundary is
      // representation-exact only for the non-fast externref carrier today.
      // Host gc and host-free standalone/WASI both provide the wrapper ctor +
      // OrdinaryToPrimitive runtime family; strict-no-host gc does not.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.allowHostImports || profile.target === "standalone" || profile.target === "wasi")
      );
    case "legacy-numeric-array-global":
      return profile.backend === "wasmgc" && profile.fast !== true;
    case "native-current-this":
    // (#7106 S3c) the `__current_this` receiver ladder and the per-function
    // prototype chain walk on the host-free lanes.
    case "native-own-property-test":
    // (#7106 propertyHelper, #7283) the stored `Object.getOwnPropertyDescriptor`
    // / `Object.getOwnPropertyNames` aliases reach the object runtime's native
    // `__getOwnPropertyDescriptor` / `__getOwnPropertyNames`.
    case "native-own-property-introspection":
      // (#7106 S1g) legacy's uncurried-alias arm is active on the host-free
      // lanes (`uncurriedBuiltinAliasArmActive`); the IR mirrors that lane.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-array-is-array":
      // (#7272) the stored `Array.isArray` alias reaches the object runtime's
      // native `__extern_is_array` — the provider legacy's `Array.isArray`
      // arm uses on standalone only (WASI keeps its inline `ref.test` chain).
      return profile.backend === "wasmgc" && profile.fast !== true && profile.target === "standalone";
    case "native-object-statics":
      // (#7338) The `Object` statics table (`ir/object-statics.ts`): the
      // native object runtime's helpers and a member read that answers for an
      // open `$Object`, measured on host-free standalone only.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        profile.target === "standalone" &&
        profile.nativeRegimeInJs !== true
      );
    case "host-dynamic-method-call":
      // (#7117) `recv.m(…)` on a dynamic receiver through the generic
      // `__ir_dyn_method_call_N` → `__extern_method_call`. The host lane binds
      // the real JS call; the native object runtime dispatches open-`$Object`
      // methods only and answers `undefined` for primitive / vec / Map / …
      // receivers, where legacy dispatches by brand.
      return profile.backend === "wasmgc" && profile.allowHostImports;
    case "native-dynamic-member-read":
    // (#7113, #7177) A property / element read on the boxed-any carrier in
    // a planned member closure. WASI's IR read has no string or vec
    // receiver arm and answers `undefined` (`.length`, `[i]`), so only the
    // standalone regime (native gc projects as standalone) is admitted.
    // (#7267) `JSON.parse(s)` also requires it: its value graph is read back
    // through this read, which answers NaN for it on WASI.
    case "planned-closure-direct-call":
      // (#7113) A direct call to a module function from a planned member
      // closure: WASI mints no AST-site call plan for it and withdraws
      // ("direct call … has no exact AST-site plan").
      return profile.backend === "wasmgc" && profile.fast !== true && profile.target === "standalone";
    case "prepared-dynamic-helper-abi":
      // (#7113, #7193) A planned member closure inside a prepared
      // `<module-init>` component binds the carrier's `String` / `in` helpers
      // by Program ABI identity (`prepared-dynamic-support.ts` names the exact
      // physical symbols). The native-first gc lane projects as standalone.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-dynamic-loose-equality":
      // (#7113, #7178, #7193) A loose `==` / `!=` on the carrier in that
      // closure. Unsound on EVERY lane: no carrier loose-equality helper
      // ToPrimitives an object operand (`{ valueOf() { return 2 } } == 2`
      // traps; `[2] != "2"` differs from node — #7194). WASI stays admitted
      // only to keep main's output, and only against a string other side
      // (`carrierLooseEqualityAdmissible`, new shapes); standalone is refused.
      return profile.backend === "wasmgc" && profile.fast !== true && profile.target === "wasi";
    case "dynamic-method-call-wrapper":
    // (#7106 Stage 4, #7119) `recv.m(…)` on a dynamic receiver through the
    // per-(method, arity) `__ir_dyn_mcall_<m>_<n>` wrapper: the call's
    // [[Get]], then legacy's own any-receiver brand dispatch (host-free
    // lanes; the native `__extern_method_call` serves open `$Object` only).
    case "native-global-function-call":
    // (#7253) `parseInt` / `parseFloat` / `escape` / `unescape` / `isNaN` of
    // typed operands through legacy's own host-free providers (the native
    // parse scanners, `__escape` / `__unescape`); the escape result recovers
    // its native string through `native-string-carrier-coercion`'s ladder.
    case "native-number-conversion":
      // (#7106 module-init lever B) `Number(v)` through the host-free
      // `js.number.from-value` provider (legacy's emitter over a template).
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-arguments-length":
      // (#7106 S1e) the `__argc`/`__extras_argv` protocol wrapper on the
      // host-free lanes (`__ir_arguments_length`).
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-string-carrier-coercion":
      // (#7106 S1c) the checked externref → $AnyString recovery ladder legacy
      // emits on the native-string host-free lanes (`__ir_string_carrier`).
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-dynamic-construct":
      // (#7106 S3a) `new <value>(…)` through the ordinary-[[Construct]] driver
      // (`__native_construct_<N>`), which legacy reserves only on the host-free
      // lanes (`tryCompileNativeConstructFromValue`, `noJsHost`).
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-object-tostring-tag":
      // (#7106 S1c) `Object.prototype.toString.call(v)` through the standalone
      // runtime classifier `__object_proto_to_string_runtime`, which legacy
      // registers only on the host-free lanes (`ensureObjectProtoToStringRuntimeHelper`).
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "native-json-codec":
      // (#7106 S1b) `JSON.stringify(v)` through the native JSON codec
      // (`__json_stringify_root`, `anyref -> ref $AnyString`): a native-strings
      // lane with the non-fast externref dynamic carrier, which
      // `any.convert_extern` turns into the codec's anyref operand. (#7267)
      // `JSON.parse(s)` calls the same codec's `__json_parse_text`.
      return (
        profile.backend === "wasmgc" &&
        profile.fast !== true &&
        (profile.target === "standalone" || profile.target === "wasi")
      );
    case "number-to-string":
      // (#4467) §7.1.17 Number::toString as a callable provider. Both wasmgc
      // lanes own one: host binds `env.number_toString`, whose externref IS
      // the host string carrier; native/standalone bind the #3912 native
      // formatter behind a thunk that restores the `(ref $AnyString)` carrier.
      // The other backends have no number formatter bound yet, so a numeric
      // template substitution must stay unclaimed there rather than reach a
      // resolver with no provider.
      return profile.backend === "wasmgc";
  }
}
