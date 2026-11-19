// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import type { IrType } from "../../ir/core/types.js";
import { resolveOrdinaryObjectClosureSignature } from "../../ir/ordinary-object-closure-signatures.js";
import { objectLiteralDataPropertyName } from "../../ir/property-key-fold.js";

export interface PreparedOrdinaryPropertyRead {
  readonly key: string;
  readonly resultType: IrType;
}

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

const isAccessor = (property: ts.ObjectLiteralElementLike): boolean =>
  ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property);

/** (#7354 O1) Every member is a static-keyed data property: its value is the literal's own initializer. */
function isDataOnlyLiteral(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      objectLiteralDataPropertyName(property.name) !== null &&
      !(ts.isPropertyAssignment(property) && objectLiteralDataPropertyName(property.name) === "__proto__"),
  );
}

/**
 * A read `o.k` that neither writes, deletes, calls nor otherwise passes on the property or `o`. A member inside an
 * array or object literal is refused outright: that is where a destructuring assignment target hides.
 */
function isPlainMemberRead(reference: ts.Identifier): boolean {
  const access = reference.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== reference || access.questionDotToken)
    return false;
  let outer: ts.Node = access;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const user = outer.parent;
  const step = (unary: ts.Node) =>
    (ts.isPrefixUnaryExpression(unary) || ts.isPostfixUnaryExpression(unary)) &&
    (unary.operator === ts.SyntaxKind.PlusPlusToken || unary.operator === ts.SyntaxKind.MinusMinusToken);
  const assigned =
    ts.isBinaryExpression(user) &&
    user.left === outer &&
    user.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    user.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  return !(
    assigned ||
    step(user) ||
    ts.isDeleteExpression(user) ||
    (ts.isCallExpression(user) && user.expression === outer) ||
    ((ts.isForInStatement(user) || ts.isForOfStatement(user)) && user.initializer === outer) ||
    ts.isArrayLiteralExpression(user) ||
    ts.isSpreadElement(user) ||
    ts.isPropertyAssignment(user) ||
    ts.isShorthandPropertyAssignment(user) ||
    ts.isSpreadAssignment(user)
  );
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
  readonly preparedOrdinaryObjectLiteral: (literal: ts.ObjectLiteralExpression) => boolean;
} {
  const plans = new WeakMap<ts.PropertyAccessExpression, PreparedOrdinaryPropertyRead>();
  const roots: readonly ts.Node[] =
    "kind" in declarationOrStatements ? [declarationOrStatements] : declarationOrStatements;
  // (#7354 O1) Every reference to a symbol in the program's sources, gathered once.
  let references: Map<ts.Symbol, ts.Identifier[]> | undefined;
  const referencesOf = (symbol: ts.Symbol): readonly ts.Identifier[] => {
    if (!references) {
      const found = new Map<ts.Symbol, ts.Identifier[]>();
      const collect = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const target = checker.getSymbolAtLocation(node);
          if (target) found.set(target, [...(found.get(target) ?? []), node]);
        }
        ts.forEachChild(node, collect);
      };
      sourceFiles.forEach(collect);
      references = found;
    }
    return references.get(symbol) ?? [];
  };
  /**
   * The literal behind a receiver whose property values the checker types exactly: an accessor literal bound to a
   * `const`, or (#7354 O1) a data-only literal whose binding is only ever read as `o.k`, so no property is written
   * after the literal stored it.
   */
  const ordinaryLiteral = (expression: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    // The literal itself as the receiver: its members are its own initializers.
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !sourceFiles.includes(declaration.getSourceFile()) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !declaration.initializer ||
      !ts.isObjectLiteralExpression(declaration.initializer)
    )
      return undefined;
    const literal = declaration.initializer;
    if (literal.properties.some(isAccessor)) return declaration.parent.flags & ts.NodeFlags.Const ? literal : undefined;
    return isDataOnlyLiteral(literal) &&
      referencesOf(symbol!).every((reference) => reference === declaration.name || isPlainMemberRead(reference))
      ? literal
      : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      !node.questionDotToken &&
      ts.isIdentifier(node.name) &&
      ordinaryLiteral(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node);
      const parts = type.isUnion() ? type.types : [type];
      // These are logical result intentions. The keyed descriptor/return proof
      // must authenticate them before physical allocation; checker types alone
      // do not grant either the Boolean payload read or callable projection.
      if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.NumberLike) !== 0)) {
        plans.set(node, Object.freeze({ key: node.name.text, resultType: F64 }));
      } else if (parts.length > 0 && parts.every((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0)) {
        plans.set(node, Object.freeze({ key: node.name.text, resultType: BOOLEAN }));
      } else {
        const getters = ordinaryLiteral(node.expression)!.properties.filter(
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
  const owned = roots.every((root) => sourceFiles.includes(root.getSourceFile()));
  if (owned) roots.forEach(visit);
  return Object.freeze({
    preparedOrdinaryPropertyRead(expression: ts.PropertyAccessExpression) {
      return plans.get(expression);
    },
    // (#7354 O1) The Prepared backend has no closed object struct: every literal it owns is an ordinary object.
    preparedOrdinaryObjectLiteral(literal: ts.ObjectLiteralExpression) {
      return owned && sourceFiles.includes(literal.getSourceFile());
    },
  });
}
