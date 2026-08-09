// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Resolve a compile-time constant, but only for truly immutable values.
 * Unlike general constant folding, this does not resolve `let`/`var`
 * declarations: only literals, `const` aliases, and expressions composed from
 * those values are accepted.
 */
export function resolveStrictConstant(ctx: CodegenContext, expression: ts.Expression): string | number | undefined {
  const expr = expression;
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isParenthesizedExpression(expr)) return resolveStrictConstant(ctx, expr.expression);

  if (ts.isIdentifier(expr)) {
    const initializer = ctx.oracle.constInitializerOf(expr);
    return initializer ? resolveStrictConstant(ctx, initializer) : undefined;
  }

  if (ts.isBinaryExpression(expr)) {
    const left = resolveStrictConstant(ctx, expr.left);
    const right = resolveStrictConstant(ctx, expr.right);
    if (left === undefined || right === undefined) return undefined;
    if (typeof left === "string" || typeof right === "string") {
      return expr.operatorToken.kind === ts.SyntaxKind.PlusToken ? String(left) + String(right) : undefined;
    }
    return expr.operatorToken.kind === ts.SyntaxKind.PlusToken ? left + right : undefined;
  }

  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const value = resolveStrictConstant(ctx, span.expression);
      if (value === undefined) return undefined;
      result += String(value) + span.literal.text;
    }
    return result;
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;

  return undefined;
}

/**
 * Prove an exact compile-time string length without materializing its value.
 *
 * This deliberately recognizes only immutable expressions: literals, `const`
 * aliases, and `String#repeat` with a compile-time numeric count. This lets a
 * proven rope concat reuse the exact RHS length while avoiding a potentially
 * huge repeated compiler-side string.
 */
export function staticStringLength(
  ctx: CodegenContext,
  expression: ts.Expression,
  seen = new Set<ts.VariableDeclaration>(),
): number | undefined {
  let expr = expression;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }

  if (ts.isStringLiteralLike(expr)) return expr.text.length;

  if (ts.isIdentifier(expr)) {
    const declaration = ctx.oracle.variableDeclarationOf(expr);
    const initializer = ctx.oracle.constInitializerOf(expr);
    if (!declaration || !initializer || seen.has(declaration)) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(declaration);
    return staticStringLength(ctx, initializer, nextSeen);
  }

  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "repeat" &&
    expr.arguments.length === 1 &&
    ctx.oracle.staticJsTypeOf(expr.expression.expression) === "string"
  ) {
    const receiverLength = staticStringLength(ctx, expr.expression.expression, new Set(seen));
    const rawCount = resolveStrictConstant(ctx, expr.arguments[0]!);
    if (receiverLength === undefined || typeof rawCount !== "number" || !Number.isFinite(rawCount)) return undefined;
    const count = Math.trunc(rawCount);
    const length = receiverLength * count;
    if (count < 0 || !Number.isSafeInteger(count) || !Number.isSafeInteger(length) || length > 0x7fffffff) {
      return undefined;
    }
    return length;
  }

  return undefined;
}
