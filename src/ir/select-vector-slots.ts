// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

type ImplicitNumericVecPredicate = (parameter: ts.ParameterDeclaration) => boolean;
type MutableSlotResolvedKind = "f64" | "bool" | "string" | "object" | "void" | "closure" | "dynamic";

export function isNumericArrayTypeNode(node: ts.TypeNode): boolean {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isNumericArrayTypeNode(node.type);
  }
  if (ts.isArrayTypeNode(node)) return node.elementType.kind === ts.SyntaxKind.NumberKeyword;
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray") &&
    node.typeArguments?.length === 1 &&
    node.typeArguments[0]!.kind === ts.SyntaxKind.NumberKeyword
  );
}

export function parameterUsesNumericVecAbi(
  parameter: ts.ParameterDeclaration,
  implicit?: ImplicitNumericVecPredicate,
): boolean {
  const type = parameter.type ?? ts.getJSDocType(parameter);
  return type ? isNumericArrayTypeNode(type) : implicit?.(parameter) === true;
}

export function mutableParameterHasIrSlot(
  parameter: ts.ParameterDeclaration,
  resolvedKind: MutableSlotResolvedKind,
  implicit?: ImplicitNumericVecPredicate,
): boolean {
  return (
    resolvedKind === "f64" ||
    resolvedKind === "bool" ||
    resolvedKind === "string" ||
    resolvedKind === "dynamic" ||
    (resolvedKind === "object" && parameterUsesNumericVecAbi(parameter, implicit))
  );
}
