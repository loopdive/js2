// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";

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
