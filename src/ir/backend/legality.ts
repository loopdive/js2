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
  | "standalone-native-regexp-test-carrier"
  | "standalone-wrapper-instanceof"
  | "primitive-wrapper-loose-equality"
  | "legacy-numeric-array-global"
  | "number-to-string";

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
  });
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
      return profile.backend === "wasmgc" && profile.target === "standalone" && !profile.allowHostImports;
    case "standalone-native-regexp-test-carrier":
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
    case "primitive-wrapper-loose-equality":
      // #4208 S4 — the focused producer crosses the wrapper object's
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
