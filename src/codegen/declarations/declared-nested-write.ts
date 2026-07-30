// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Syntactic proof that a deep property write mutates an already-declared field
 * on a value stored in an outer object literal. Kept separate from the
 * growable-object scan so that scan stays below the repository function budget.
 */
import { forEachChild, ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

type DeclaredNestedWriteClassifier = (
  literal: ts.ObjectLiteralExpression,
  left: ts.PropertyAccessExpression,
  rootName: string,
) => boolean;

function unwrapCarrier(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

function singleReturn(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    if (
      node !== fn.body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(fn.body, visit);
  return returns.length === 1 ? returns[0] : undefined;
}

function declaresThisField(ctor: ts.FunctionDeclaration | ts.FunctionExpression, fieldName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      node !== ctor &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === fieldName &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.parent.left === node
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  if (ctor.body) forEachChild(ctor.body, visit);
  return found;
}

function propertyValue(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = property.name;
    if (
      (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName) || ts.isNumericLiteral(propertyName)) &&
      propertyName.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function literalDeclaresPath(firstValue: ts.Expression, names: readonly string[]): boolean {
  let current = unwrapCarrier(firstValue);
  if (!ts.isObjectLiteralExpression(current)) return false;
  for (const name of names) {
    if (!ts.isObjectLiteralExpression(current)) return false;
    const next = propertyValue(current, name);
    if (!next) return false;
    current = unwrapCarrier(next);
  }
  return true;
}

/**
 * Build one module-local classifier. Function-style constructor factories such
 * as Acorn's `kw(...) { return table[name] = new TokenType(...) }` lose their
 * return type to `any` under skip-semantic-diagnostics, so the classifier keeps
 * a small syntactic factory index and follows assignment-expression returns.
 */
export function createDeclaredNestedWriteClassifier(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): DeclaredNestedWriteClassifier {
  const factories = new Map<string, ts.FunctionLikeDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      factories.set(stmt.name.text, stmt);
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const declaration of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
      ) {
        factories.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  const inferFnctorName = (expr: ts.Expression, depth = 4): string | undefined => {
    if (depth <= 0) return undefined;
    const carrier = unwrapCarrier(expr);
    if (ts.isNewExpression(carrier) && ts.isIdentifier(carrier.expression)) {
      const ctorName = carrier.expression.text;
      return ctx.fnctorEscapeGate?.ctorDeclByName.has(ctorName) ? ctorName : undefined;
    }
    if (!ts.isCallExpression(carrier) || !ts.isIdentifier(carrier.expression)) return undefined;
    const factory = factories.get(carrier.expression.text);
    const returned = factory && singleReturn(factory);
    return returned ? inferFnctorName(returned, depth - 1) : undefined;
  };

  return (literal, left, rootName) => {
    const names: string[] = [];
    let cursor: ts.Expression = left;
    while (ts.isPropertyAccessExpression(cursor)) {
      names.unshift(cursor.name.text);
      cursor = cursor.expression;
    }
    if (!ts.isIdentifier(cursor) || cursor.text !== rootName || names.length < 2) return false;
    const firstValue = propertyValue(literal, names[0]!);
    if (!firstValue) return false;
    if (literalDeclaresPath(firstValue, names.slice(1))) return true;
    const ctorName = inferFnctorName(firstValue);
    const ctor = ctorName ? ctx.fnctorEscapeGate?.ctorDeclByName.get(ctorName) : undefined;
    return ctor ? declaresThisField(ctor, names[names.length - 1]!) : false;
  };
}
