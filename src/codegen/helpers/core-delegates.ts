// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771, #6797) Late-bound handles on core codegen helpers for LEAF modules
 * that the core itself calls.
 *
 * `src/codegen/array/*`, `expressions/bool-to-locale-string.ts` and
 * `proxy-array-like.ts` are called by core modules (array-holes, vec-overlay,
 * type-coercion, index, …) and need a few core helpers back
 * (`buildThrowJsErrorInstrs`, `stringConstantExternrefInstrs`, …). A static
 * value import in both directions pulls every such leaf into the codegen
 * strongly-connected component that `scripts/check-import-cycles.mjs` ratchets.
 * So the leaves import the wrappers below instead. This module imports only
 * TYPES from the core, so it sits below both sides; the real functions are
 * registered once, at module scope, by `src/codegen/expressions.ts` — the same
 * registrar that wires the `shared.ts` delegates. Every wrapper forwards its
 * arguments unchanged.
 */
import type { addStringConstantGlobal as AddStringConstantGlobal } from "../registry/imports.js";
import type { buildThrowJsErrorInstrs as BuildThrowJsErrorInstrs } from "../js-errors.js";
import type { stringConstantExternrefInstrs as StringConstantExternrefInstrs } from "../native-strings.js";
import type { holeSentinelInstrs as HoleSentinelInstrs, holeTestInstrs as HoleTestInstrs } from "../array-holes.js";
import type { canonicalUndefinedExternInstrs as CanonicalUndefinedExternInstrs } from "../any-helpers.js";
import type { emitArraySetLengthValidation as EmitArraySetLengthValidation } from "../array-length-define.js";
import type {
  clampRelative as ClampRelative,
  integerArg as IntegerArg,
  requireObjectCoercible as RequireObjectCoercible,
  resolveSliceDeps as ResolveSliceDeps,
} from "../array-slice-native.js";
import type { emitBuiltinNamespaceObject as EmitBuiltinNamespaceObject } from "../builtin-static-globals.js";
import type { emitArrayIsArrayExternrefPredicate as EmitArrayIsArrayExternrefPredicate } from "../builtin-value-read.js";
import type { buildArrayLikeToLengthFromExternref as BuildArrayLikeToLengthFromExternref } from "../object-runtime-enumeration.js";
import type { sourceOverridesBuiltinPrototypeMember as SourceOverridesBuiltinPrototypeMember } from "../builtin-proto-member-override.js";
import type { protoIndexBrandCompanionHasInstrs as ProtoIndexBrandCompanionHasInstrs } from "../proto-index-store.js";

/** The core functions the leaves reach through this module. */
export interface CoreDelegates {
  addStringConstantGlobal: typeof AddStringConstantGlobal;
  buildArrayLikeToLengthFromExternref: typeof BuildArrayLikeToLengthFromExternref;
  buildThrowJsErrorInstrs: typeof BuildThrowJsErrorInstrs;
  canonicalUndefinedExternInstrs: typeof CanonicalUndefinedExternInstrs;
  clampRelative: typeof ClampRelative;
  emitArrayIsArrayExternrefPredicate: typeof EmitArrayIsArrayExternrefPredicate;
  emitArraySetLengthValidation: typeof EmitArraySetLengthValidation;
  emitBuiltinNamespaceObject: typeof EmitBuiltinNamespaceObject;
  holeSentinelInstrs: typeof HoleSentinelInstrs;
  holeTestInstrs: typeof HoleTestInstrs;
  integerArg: typeof IntegerArg;
  protoIndexBrandCompanionHasInstrs: typeof ProtoIndexBrandCompanionHasInstrs;
  requireObjectCoercible: typeof RequireObjectCoercible;
  resolveSliceDeps: typeof ResolveSliceDeps;
  sourceOverridesBuiltinPrototypeMember: typeof SourceOverridesBuiltinPrototypeMember;
  stringConstantExternrefInstrs: typeof StringConstantExternrefInstrs;
}

let registered: CoreDelegates | undefined;

/** Called once by `src/codegen/expressions.ts` at module scope. */
export function registerCoreDelegates(impl: CoreDelegates): void {
  registered = impl;
}

function core(): CoreDelegates {
  if (registered === undefined) {
    throw new Error(
      "codegen core delegates not yet registered — src/codegen/expressions.ts was not imported before this call",
    );
  }
  return registered;
}

export const addStringConstantGlobal: CoreDelegates["addStringConstantGlobal"] = (...a) =>
  core().addStringConstantGlobal(...a);
export const buildArrayLikeToLengthFromExternref: CoreDelegates["buildArrayLikeToLengthFromExternref"] = (...a) =>
  core().buildArrayLikeToLengthFromExternref(...a);
export const buildThrowJsErrorInstrs: CoreDelegates["buildThrowJsErrorInstrs"] = (...a) =>
  core().buildThrowJsErrorInstrs(...a);
export const canonicalUndefinedExternInstrs: CoreDelegates["canonicalUndefinedExternInstrs"] = (...a) =>
  core().canonicalUndefinedExternInstrs(...a);
export const clampRelative: CoreDelegates["clampRelative"] = (...a) => core().clampRelative(...a);
export const emitArrayIsArrayExternrefPredicate: CoreDelegates["emitArrayIsArrayExternrefPredicate"] = (...a) =>
  core().emitArrayIsArrayExternrefPredicate(...a);
export const emitArraySetLengthValidation: CoreDelegates["emitArraySetLengthValidation"] = (...a) =>
  core().emitArraySetLengthValidation(...a);
export const emitBuiltinNamespaceObject: CoreDelegates["emitBuiltinNamespaceObject"] = (...a) =>
  core().emitBuiltinNamespaceObject(...a);
export const holeSentinelInstrs: CoreDelegates["holeSentinelInstrs"] = (...a) => core().holeSentinelInstrs(...a);
export const holeTestInstrs: CoreDelegates["holeTestInstrs"] = (...a) => core().holeTestInstrs(...a);
export const integerArg: CoreDelegates["integerArg"] = (...a) => core().integerArg(...a);
export const protoIndexBrandCompanionHasInstrs: CoreDelegates["protoIndexBrandCompanionHasInstrs"] = (...a) =>
  core().protoIndexBrandCompanionHasInstrs(...a);
export const requireObjectCoercible: CoreDelegates["requireObjectCoercible"] = (...a) =>
  core().requireObjectCoercible(...a);
export const resolveSliceDeps: CoreDelegates["resolveSliceDeps"] = (...a) => core().resolveSliceDeps(...a);
export const sourceOverridesBuiltinPrototypeMember: CoreDelegates["sourceOverridesBuiltinPrototypeMember"] = (...a) =>
  core().sourceOverridesBuiltinPrototypeMember(...a);
export const stringConstantExternrefInstrs: CoreDelegates["stringConstantExternrefInstrs"] = (...a) =>
  core().stringConstantExternrefInstrs(...a);
