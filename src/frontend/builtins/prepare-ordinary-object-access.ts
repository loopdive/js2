// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import type { IrType } from "../../ir/core/types.js";
import { resolveOrdinaryObjectClosureSignature } from "../../ir/ordinary-object-closure-signatures.js";

export interface PreparedOrdinaryPropertyRead {
  readonly key: string;
  readonly resultType: IrType;
}

/** Exact source intent only. The packet's actual object/descriptor/Get graph grants runtime authority. */
export function prepareOrdinaryObjectAccessResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declarationOrStatements: ts.FunctionDeclaration | readonly ts.Statement[],
): {
  readonly preparedOrdinaryPropertyRead: (
    expression: ts.PropertyAccessExpression,
  ) => PreparedOrdinaryPropertyRead | undefined;
} {
  const plans = new WeakMap<ts.PropertyAccessExpression, PreparedOrdinaryPropertyRead>();
  const roots: readonly ts.Node[] =
    "kind" in declarationOrStatements ? [declarationOrStatements] : declarationOrStatements;
  const descriptorLiteral = (expression: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    let candidate: ts.Expression = expression;
    if (ts.isIdentifier(candidate)) {
      const declaration = checker.getSymbolAtLocation(candidate)?.valueDeclaration;
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !sourceFiles.includes(declaration.getSourceFile()) ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const) ||
        !declaration.initializer
      )
        return undefined;
      candidate = declaration.initializer;
    }
    return ts.isObjectLiteralExpression(candidate) &&
      candidate.properties.some(
        (property) => ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property),
      )
      ? candidate
      : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      !node.questionDotToken &&
      ts.isIdentifier(node.name) &&
      descriptorLiteral(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node);
      const parts = type.isUnion() ? type.types : [type];
      // These are logical result intentions. The keyed descriptor/return proof
      // must authenticate them before physical allocation; checker types alone
      // do not grant either the Boolean payload read or callable projection.
      if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0)) {
        const resultType: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
        plans.set(node, Object.freeze({ key: node.name.text, resultType }));
      } else if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0)) {
        const resultType: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });
        plans.set(node, Object.freeze({ key: node.name.text, resultType }));
      } else {
        const getters = descriptorLiteral(node.expression)!.properties.filter(
          (property): property is ts.GetAccessorDeclaration =>
            ts.isGetAccessorDeclaration(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === node.name.text,
        );
        const signature =
          getters.length === 1 ? resolveOrdinaryObjectClosureSignature(checker, getters[0]!) : undefined;
        if (signature?.kind === "supported" && signature.signature.returnType?.kind === "callable")
          plans.set(node, Object.freeze({ key: node.name.text, resultType: signature.signature.returnType }));
      }
    }
    ts.forEachChild(node, visit);
  };
  if (roots.every((root) => sourceFiles.includes(root.getSourceFile()))) roots.forEach(visit);
  return Object.freeze({
    preparedOrdinaryPropertyRead(expression: ts.PropertyAccessExpression) {
      return plans.get(expression);
    },
  });
}
