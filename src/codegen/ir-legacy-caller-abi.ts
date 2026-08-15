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
 */
import { ts } from "../ts-api.js";

import { effectiveIrParamTypeNode, effectiveIrReturnTypeNode } from "../ir/select.js";

function isScalarAbiKeyword(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.NumberKeyword || kind === ts.SyntaxKind.BooleanKeyword;
}

/**
 * Is this declaration's wasm signature identical in the direct and IR
 * front-ends *by construction*?
 *
 * True when every parameter and the return type carry an explicit annotation
 * drawn from the fully-annotated scalar surface. Both front-ends then resolve
 * the same `ts.TypeNode` through the same mode-consistent mapping — number →
 * f64, boolean → i32, void → no result, and `T[]` → the interned
 * `(ref_null $vec_<elem>)` struct that `resolvePositionType` and legacy
 * `getOrRegisterVecType` agree on. Signature divergence, NOT body lowerability,
 * is what the caller-direction closure guards against, so certifying this
 * family is a proof rather than an optimism.
 *
 * Deliberately excluded:
 * - unannotated / implicit positions — the implicit-param resolver owns those,
 *   and they are the #4186 signature split-brain surface (lattice shape structs
 *   vs. legacy `lowerParamType`), which this predicate must not pre-empt;
 * - optional / rest / defaulted parameters — arity is part of the ABI;
 * - generators and generics;
 * - string and object positions, plus non-scalar or nested array elements —
 *   their carrier depends on `nativeStrings` / vec-element decisions this
 *   predicate does not reproduce.
 */
export function hasFullyAnnotatedScalarAbi(declaration: ts.FunctionDeclaration): boolean {
  if (declaration.typeParameters && declaration.typeParameters.length > 0) return false;
  if (declaration.asteriskToken) return false;
  for (const parameter of declaration.parameters) {
    if (parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) return false;
    const explicitType = effectiveIrParamTypeNode(parameter);
    if (!explicitType) return false;
    const isScalarArray = ts.isArrayTypeNode(explicitType) && isScalarAbiKeyword(explicitType.elementType.kind);
    if (!isScalarAbiKeyword(explicitType.kind) && !isScalarArray) return false;
  }
  const returnType = effectiveIrReturnTypeNode(declaration);
  if (!returnType) return false;
  return isScalarAbiKeyword(returnType.kind) || returnType.kind === ts.SyntaxKind.VoidKeyword;
}
