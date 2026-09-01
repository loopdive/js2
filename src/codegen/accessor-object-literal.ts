// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

export function isAccessorObjectLiteral(expr: ts.Expression): expr is ts.ObjectLiteralExpression {
  return (
    ts.isObjectLiteralExpression(expr) &&
    expr.properties.some((property) => ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property))
  );
}

export function isAccessorReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  return (ts.isIdentifier(expr) && ctx.externrefAccessorVars.has(expr.text)) || isAccessorObjectLiteral(expr);
}

export function tagAccessorObjectLiteralReceiver(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): void {
  let parent: ts.Node | undefined = expr.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent;
  const receiver =
    parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
      ? parent.name
      : parent &&
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(parent.left)
        ? parent.left
        : undefined;
  if (receiver) ctx.externrefAccessorVars.add(receiver.text);
}
