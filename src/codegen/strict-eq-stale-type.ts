// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Runtime-carrier guards for strict equality operands whose checker type is
 * stale after an indexed object-literal write.
 */
import { ts } from "../ts-api.js";
import { moduleGlobalIsDynamicButStaticallyPrimitive } from "./declarations/heterogeneous-scalar-var-widening.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

const indexedStaleProperties = new WeakMap<CodegenContext, Set<ts.Declaration>>();

export function markIndexedPropertyStale(ctx: CodegenContext, property: ts.Declaration): void {
  let stale = indexedStaleProperties.get(ctx);
  if (stale === undefined) {
    stale = new Set<ts.Declaration>();
    indexedStaleProperties.set(ctx, stale);
  }
  stale.add(property);
}

/** Whether equality must inspect the runtime carrier instead of checker type. */
export function equalityOperandHasStaleStaticType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): boolean {
  if (
    ts.isIdentifier(expr) &&
    (fctx.forInIdentifierVars?.has(expr.text) === true || moduleGlobalIsDynamicButStaticallyPrimitive(ctx, expr))
  ) {
    return true;
  }

  let key: string | undefined;
  let receiver: ts.Expression | undefined;
  let propertyNode: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(expr)) {
    key = expr.name.text;
    receiver = expr.expression;
    propertyNode = expr.name;
  } else if (ts.isElementAccessExpression(expr)) {
    propertyNode = expr.argumentExpression;
    let keyExpr: ts.Expression = expr.argumentExpression;
    while (
      ts.isParenthesizedExpression(keyExpr) ||
      ts.isAsExpression(keyExpr) ||
      ts.isSatisfiesExpression(keyExpr) ||
      ts.isTypeAssertionExpression(keyExpr) ||
      ts.isNonNullExpression(keyExpr)
    ) {
      keyExpr = keyExpr.expression;
    }
    if (ts.isStringLiteralLike(keyExpr)) {
      key = keyExpr.text;
    } else if (ts.isNumericLiteral(keyExpr)) {
      const numericKey = Number(keyExpr.text);
      if (Number.isFinite(numericKey)) key = String(numericKey);
    }
    receiver = expr.expression;
  }
  if (receiver === undefined || key === undefined) return false;
  const property =
    (propertyNode ? ctx.oracle.declarationsOf(propertyNode)[0] : undefined) ?? ctx.oracle.declarationsOf(expr)[0];
  const stale = property !== undefined && indexedStaleProperties.get(ctx)?.has(property) === true;
  if (!stale) return false;
  const propertyKey = key;
  const propertyReceiver = receiver;
  return (
    ctx.oracle.typeFactOf(propertyReceiver).kind === "object" &&
    ctx.oracle.propertyFactOf(propertyReceiver, propertyKey).kind !== "unresolvable"
  );
}
