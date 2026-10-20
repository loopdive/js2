// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrModuleBindingValueKind } from "./module-binding-value-kinds.js";
import type { IrType } from "./core/types.js";
import { irVec } from "./core/types.js";
import { nativeFamilyAmbientSymbol, type NativeFamilyVectorType } from "./program-logical-types.js";

/** Source data only: real internal const literal, with no physical resource authority. */
export function nativeModuleVectorType(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): NativeFamilyVectorType | undefined {
  const list = declaration.parent;
  if (
    !ts.isIdentifier(declaration.name) ||
    !list ||
    !ts.isVariableDeclarationList(list) ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(list.parent) ||
    !ts.isSourceFile(list.parent.parent) ||
    list.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !declaration.initializer ||
    !ts.isArrayLiteralExpression(declaration.initializer) ||
    declaration.initializer.elements.length > 2147483647
  )
    return undefined;
  const type = checker.getTypeAtLocation(declaration.name);
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (
    !checker.isArrayType(type) ||
    type.getSymbol() !== nativeFamilyAmbientSymbol(checker, "Array", ts.SymbolFlags.Type) ||
    !element ||
    (element.flags & ts.TypeFlags.NumberLike) === 0
  )
    return undefined;
  for (const item of declaration.initializer.elements) {
    const literal =
      ts.isPrefixUnaryExpression(item) &&
      (item.operator === ts.SyntaxKind.MinusToken || item.operator === ts.SyntaxKind.PlusToken)
        ? item.operand
        : item;
    if (!ts.isNumericLiteral(literal) || (checker.getTypeAtLocation(item).flags & ts.TypeFlags.NumberLike) === 0)
      return undefined;
  }
  return irVec({ kind: "val", val: { kind: "f64" } }, false) as NativeFamilyVectorType;
}

export function storageType(
  identity: { readonly declaration: ts.VariableDeclaration; readonly valueKind: IrModuleBindingValueKind },
  checker: ts.TypeChecker,
  unsupported: (detail: string) => never,
): IrType {
  const value = identity.valueKind;
  switch (value.kind) {
    case "f64":
      return { kind: "val", val: { kind: "f64" } };
    case "i32":
      return { kind: "val", val: { kind: "i32", boolean: true } };
    case "string":
      return { kind: "string" };
    case "dynamic":
      return { kind: "dynamic" };
    case "native-f64-vector": {
      const type = nativeModuleVectorType(checker, identity.declaration);
      return type ?? unsupported("native vector storage lost its authentic literal contract");
    }
    default:
      return unsupported(`whole-program source storage has no typed carrier for ${value.kind}`);
  }
}
export function sameSourceModuleVectors(
  rows: readonly {
    readonly identity: { readonly sourceId: string; readonly declaration: ts.VariableDeclaration };
    readonly binding: { readonly type: IrType };
  }[],
  sourceId: string,
): ReadonlyMap<ts.VariableDeclaration, NativeFamilyVectorType> {
  return new Map(
    rows
      .filter((row) => row.identity.sourceId === sourceId && row.binding.type.kind === "vec")
      .map((row) => [row.identity.declaration, row.binding.type as NativeFamilyVectorType]),
  );
}
