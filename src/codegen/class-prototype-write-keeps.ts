// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  )
    expr = expr.expression;
  return expr;
}

/** A declaration-proven class prototype, with a side-effect-free property key. */
export function standaloneClassPrototypeReceiverName(
  ctx: CodegenContext,
  expression: ts.Expression,
): string | undefined {
  if (!ctx.standalone) return undefined;
  const receiver = unwrap(expression);
  if (ts.isPropertyAccessExpression(receiver)) {
    if (receiver.name.text !== "prototype") return undefined;
  } else if (ts.isElementAccessExpression(receiver)) {
    const key = unwrap(receiver.argumentExpression);
    if (!ts.isStringLiteralLike(key) || key.text !== "prototype") return undefined;
  } else return undefined;
  const root = unwrap(receiver.expression);
  if (!ts.isIdentifier(root)) return undefined;
  const name = ctx.classExprNameMap.get(root.text) ?? root.text;
  if (!ctx.classSet.has(name)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(root);
  return declaration !== undefined && ts.isClassDeclaration(declaration) ? name : undefined;
}

/** Class declarations are not module globals; keep their prototype writes
 * in source order so PutValue reaches the existing standalone property setter.
 */
export function shouldKeepClassPrototypeWrite(ctx: CodegenContext, target: ts.Expression): boolean {
  const lhs = unwrap(target);
  if (!ts.isPropertyAccessExpression(lhs) && !ts.isElementAccessExpression(lhs)) return false;
  return standaloneClassPrototypeReceiverName(ctx, lhs.expression) !== undefined;
}
