// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3518 (standalone lane) — exact direct/IR signature certification used by the
 * standalone/WASI caller-direction call-graph closure in `src/ir/select.ts`.
 *
 * Outside JS-host mode the selector demotes any claimed function that has an
 * unclaimed LOCAL caller, because the IR overlay may replace the function's
 * legacy-allocated `typeIdx` after legacy already compiled that caller's body —
 * a cross-signature `call`. `planIrOverlay` may exempt a callee when it can
 * prove the two front-ends derive the SAME signature; this module owns one such
 * proof.
 *
 * The predicate is consulted ONLY under `demoteOnLegacyCaller`
 * (`jsHostExterns !== true`), so widening it cannot move a JS-host claim.
 */
import { ts } from "../ts-api.js";

import { effectiveIrParamTypeNode, effectiveIrReturnTypeNode } from "../ir/select.js";

function isScalarAbiKeyword(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.NumberKeyword || kind === ts.SyntaxKind.BooleanKeyword;
}

/**
 * (#3518) `string` is certifiable in EVERY mode because both front-ends read
 * the same two context fields to pick the carrier, and nothing else:
 *
 *   legacy `resolveWasmType`   `ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`
 *                              ? `(ref $AnyStr)` : externref
 *   IR     `resolveString()`   `ctx.nativeStrings && ctx.anyStrTypeIdx >= 0`
 *                              ? `(ref $AnyStr)` : externref
 *
 * They therefore agree by construction, not by coincidence — including the
 * `anyStrTypeIdx < 0` corner, where both fall back to externref. The legacy
 * `isStringWrapperType` exclusion is unreachable from a `string` KEYWORD node
 * (the wrapper is spelled `String`), and `resolveNativeTypeAnnotation` only
 * matches alias TypeReferences, never a keyword node.
 *
 * `string[]` is deliberately NOT certified: array element carriers are a
 * vec-layout decision (`getOrRegisterVecType` vs `resolvePositionType`'s
 * element arm) that this predicate does not reproduce.
 */
function isCertifiedAbiKeyword(kind: ts.SyntaxKind): boolean {
  return isScalarAbiKeyword(kind) || kind === ts.SyntaxKind.StringKeyword;
}

/** Evidence the certification cannot derive from the declaration's syntax alone. */
export interface LegacyCallerAbiEvidence {
  /**
   * True when legacy overrides the DECLARED return carrier to externref
   * regardless of the annotation — today that is exactly
   * `functionReturnsDynamicObjectCarrier` (declarations.ts), which is a
   * body-shape decision the IR front-end does not mirror. Supplied by the
   * production planner; when omitted the certification is not attempted, so an
   * un-wired caller cannot silently inherit an unproven exemption.
   */
  readonly returnCarrierIsOverridden?: (declaration: ts.FunctionDeclaration) => boolean;
}

/**
 * Is this declaration's wasm signature identical in the direct and IR
 * front-ends *by construction*?
 *
 * True when every parameter and the return type carry an explicit annotation
 * drawn from the certified surface. Both front-ends then resolve the same
 * `ts.TypeNode` through the same mode-consistent mapping — number → f64,
 * boolean → i32, string → the one `nativeStrings`-keyed carrier above, void →
 * no result, and `T[]` → the interned `(ref_null $vec_<elem>)` struct that
 * `resolvePositionType` and legacy `getOrRegisterVecType` agree on. Signature
 * divergence, NOT body lowerability, is what the caller-direction closure
 * guards against, so certifying this family is a proof rather than an optimism.
 *
 * Deliberately excluded:
 * - unannotated / implicit positions — the implicit-param resolver owns those,
 *   and they are the #4186 signature split-brain surface (lattice shape structs
 *   vs. legacy `lowerParamType`), which this predicate must not pre-empt;
 * - optional / rest / defaulted parameters — arity is part of the ABI;
 * - destructuring parameters — legacy `bindingPatternParamNeedsWiden` widens
 *   them to externref no matter what the annotation says;
 * - `async` / generators / generics — legacy rewrites those signatures
 *   (`prepareAsyncCallableAbi`, the generator state struct,
 *   `resolveGenericDeclarationCallSiteTypes`);
 * - a return carrier legacy overrides on body shape (see the evidence above);
 * - object positions, plus non-scalar or nested array elements — their carrier
 *   depends on vec-element decisions this predicate does not reproduce.
 */
export function hasFullyAnnotatedScalarAbi(
  declaration: ts.FunctionDeclaration,
  evidence?: LegacyCallerAbiEvidence,
): boolean {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return false;
  if (declaration.asteriskToken) return false;
  if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  for (const parameter of declaration.parameters) {
    if (parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) return false;
    if (!ts.isIdentifier(parameter.name)) return false;
    const explicitType = effectiveIrParamTypeNode(parameter);
    if (!explicitType) return false;
    const isScalarArray = ts.isArrayTypeNode(explicitType) && isScalarAbiKeyword(explicitType.elementType.kind);
    if (!isCertifiedAbiKeyword(explicitType.kind) && !isScalarArray) return false;
  }
  const returnType = effectiveIrReturnTypeNode(declaration);
  if (!returnType) return false;
  if (returnType.kind === ts.SyntaxKind.VoidKeyword) return true;
  if (!isCertifiedAbiKeyword(returnType.kind)) return false;
  return evidence?.returnCarrierIsOverridden?.(declaration) === false;
}
