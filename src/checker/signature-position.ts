// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { SignaturePositionPath } from "./oracle.js";

/** Checker-private resolution. No checker type crosses the TypeOracle boundary. */
export function resolveCheckerSignaturePosition(
  checker: ts.TypeChecker,
  node: ts.Node,
  path: SignaturePositionPath,
): { type: ts.Type; annotation?: ts.TypeNode } | undefined {
  if (path.length === 0 || path.length > 12) return undefined;
  let type = checker.getTypeAtLocation(node);
  let annotation: ts.TypeNode | undefined;
  for (const step of path) {
    const signatures = type.getCallSignatures();
    if (signatures.length !== 1) return undefined;
    const signature = signatures[0]!;
    if (signature.typeParameters?.length) return undefined;
    if (step === "return") {
      type = checker.getReturnTypeOfSignature(signature);
      annotation = signature.getDeclaration()?.type;
    } else {
      if (!Number.isSafeInteger(step) || step < 0 || step >= signature.parameters.length) return undefined;
      const parameter = signature.parameters[step]!;
      const declaration = parameter.valueDeclaration;
      if (!declaration || !ts.isParameter(declaration)) return undefined;
      type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
      annotation = declaration.type;
    }
  }
  // A substituted signature may still point to the generic source declaration.
  // It is useful provenance, but is NOT an annotation of this exact position.
  if (annotation && checker.getTypeFromTypeNode(annotation) !== type) annotation = undefined;
  return { type, ...(annotation ? { annotation } : {}) };
}
