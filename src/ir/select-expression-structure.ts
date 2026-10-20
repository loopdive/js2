// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";
import type { IrImportedFunctionResolver } from "./imported-functions.js";

export function unwrapTypeErasedExpression(expr: ts.Expression): ts.Expression | undefined {
  return ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
    ? expr.expression
    : undefined;
}

/** Reject affine three-deep indices whose IR widening is costlier than legacy i32 induction. */
export function isAffineThreeDeepElementAccess(expr: ts.ElementAccessExpression): boolean {
  let enclosingForDepth = 0;
  for (let parent: ts.Node | undefined = expr.parent; parent; parent = parent.parent) {
    if (ts.isForStatement(parent)) enclosingForDepth++;
    if (ts.isFunctionLike(parent)) break;
  }
  if (enclosingForDepth < 3) return false;
  let indexHasMultiply = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      indexHasMultiply = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr.argumentExpression);
  return indexHasMultiply;
}

export function isFunctionObjectReceiver(
  node: ts.Identifier,
  resolver: IrImportedFunctionResolver | undefined,
): boolean {
  const access = node.parent;
  if (
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== node ||
    access.questionDotToken !== undefined
  )
    return false;
  const use = access.parent;
  if (
    !(ts.isCallExpression(use) && use.expression === access) &&
    !(ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  )
    return false;
  return resolver?.resolveTopLevelFunctionValue(node) !== undefined;
}

export function functionObjectMemberCallIsBuildable(
  expr: ts.CallExpression,
  resolver: IrImportedFunctionResolver | undefined,
  isExpressionBuildable: (expression: ts.Expression) => boolean,
): boolean | undefined {
  const functionAccess = expr.expression;
  if (
    (ts.isPropertyAccessExpression(functionAccess) || ts.isElementAccessExpression(functionAccess)) &&
    ts.isIdentifier(functionAccess.expression) &&
    isFunctionObjectReceiver(functionAccess.expression, resolver)
  ) {
    if (functionAccess.questionDotToken || expr.questionDotToken || expr.arguments.some(ts.isSpreadElement))
      return false;
    if (ts.isElementAccessExpression(functionAccess) && !isExpressionBuildable(functionAccess.argumentExpression))
      return false;
    return expr.arguments.every((argument) => isExpressionBuildable(argument));
  }
  return undefined;
}

export function identifierIsValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

export function expressionIsDefinitelyBoolean(expression: ts.Expression): boolean {
  let candidate = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    return (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    );
  }
  if (ts.isConditionalExpression(candidate)) {
    return expressionIsDefinitelyBoolean(candidate.whenTrue) && expressionIsDefinitelyBoolean(candidate.whenFalse);
  }
  return false;
}

/** Whole parent-method source/arity/argument verdict, with caller-owned facts. */
export function superMethodCallIsBuildable(
  expr: ts.CallExpression,
  host: {
    readonly superParentClassName: () => string | null;
    readonly localClassHasKnownProjectionGap: (name: string) => boolean;
    readonly classMethodProjection: (
      name: string,
      member: string,
      isStatic: boolean,
    ) => {
      readonly status: string;
      readonly arity?: number;
    };
    readonly shapeNo: (arm: string, node: ts.Node) => false;
    readonly capabilityNo: (
      reason: "class-projection-unsupported" | "class-member-unsupported" | "call-arity-unsupported",
      arm: string,
      node: ts.Node,
    ) => false;
    readonly isExpressionBuildable: (argument: ts.Expression) => boolean;
  },
): boolean | undefined {
  const {
    superParentClassName,
    localClassHasKnownProjectionGap,
    classMethodProjection,
    shapeNo,
    capabilityNo,
    isExpressionBuildable,
  } = host;
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    if (!ts.isIdentifier(expr.expression.name)) return shapeNo("super-method-computed", expr);
    const parentClass = superParentClassName();
    if (parentClass === null || localClassHasKnownProjectionGap(parentClass)) {
      return capabilityNo("class-projection-unsupported", "super-method-parent-shape", expr);
    }
    const projection = classMethodProjection(parentClass, expr.expression.name.text, false);
    if (projection.status !== "projected" || projection.arity === undefined) {
      return capabilityNo("class-member-unsupported", "super-method-member", expr);
    }
    if (expr.arguments.length !== projection.arity) {
      return capabilityNo("call-arity-unsupported", "super-method-arity", expr);
    }
    for (const arg of expr.arguments) {
      if (ts.isSpreadElement(arg)) return shapeNo("super-method-spread", arg);
      if (!isExpressionBuildable(arg)) return false;
    }
    return true;
  }
  return undefined;
}
