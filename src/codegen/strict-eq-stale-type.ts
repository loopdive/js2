// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Runtime-carrier guards for expressions whose checker type is stale after
 * an indexed or union-alias object property write. Arithmetic, storage and
 * output consumers must preserve that value until the actual JS operation.
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

/** Whether a value derives from a property whose carrier was widened. */
export function expressionHasWidenedPropertyType(
  ctx: CodegenContext,
  expr: ts.Expression,
  seen?: Set<ts.Node>,
): boolean {
  if (!indexedStaleProperties.get(ctx)?.size) return false;
  seen ??= new Set<ts.Node>();
  if (seen.has(expr)) return false;
  seen.add(expr);
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    expr = expr.expression;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      expressionHasWidenedPropertyType(ctx, expr.left, seen) || expressionHasWidenedPropertyType(ctx, expr.right, seen)
    );
  }

  if (ts.isIdentifier(expr) && ctx.objectLiteralIndexedAssignedPropertyTypes.size > 0) {
    const declaration = ctx.oracle.valueDeclarationOf(expr);
    if (declaration && ts.isVariableDeclaration(declaration) && !declaration.type && declaration.initializer) {
      return expressionHasWidenedPropertyType(ctx, declaration.initializer, seen);
    }
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

/** Equality also observes pre-existing dynamic module/for-in carriers. */
export function equalityOperandHasStaleStaticType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): boolean {
  return (
    (ts.isIdentifier(expr) &&
      (fctx.forInIdentifierVars?.has(expr.text) === true || moduleGlobalIsDynamicButStaticallyPrimitive(ctx, expr))) ||
    expressionHasWidenedPropertyType(ctx, expr)
  );
}
