// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getLocalType } from "./context/locals.js";
import { staticIntegerRange } from "./analysis/static-numeric-range.js";

/** Emit a range-proven integer expression without f64 conversions/helpers. */
export function tryEmitStaticI32Expression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isNumericLiteral(current)) {
    const value = Number(current.text);
    if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) return false;
    fctx.body.push({ op: "i32.const", value });
    return true;
  }
  if (ts.isIdentifier(current)) {
    const localIdx = fctx.localMap.get(current.text);
    if (localIdx === undefined || getLocalType(fctx, localIdx)?.kind !== "i32") return false;
    if (!staticIntegerRange(ctx, current)) return false;
    fctx.body.push({ op: "local.get", index: localIdx });
    return true;
  }
  if (!ts.isBinaryExpression(current) || !staticIntegerRange(ctx, current)) return false;
  const op = current.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.PlusToken &&
    op !== ts.SyntaxKind.MinusToken &&
    op !== ts.SyntaxKind.AsteriskToken &&
    op !== ts.SyntaxKind.PercentToken
  ) {
    return false;
  }
  if (!tryEmitStaticI32Expression(ctx, fctx, current.left)) return false;
  if (!tryEmitStaticI32Expression(ctx, fctx, current.right)) return false;
  fctx.body.push({
    op:
      op === ts.SyntaxKind.PlusToken
        ? "i32.add"
        : op === ts.SyntaxKind.MinusToken
          ? "i32.sub"
          : op === ts.SyntaxKind.AsteriskToken
            ? "i32.mul"
            : "i32.rem_u",
  });
  return true;
}
