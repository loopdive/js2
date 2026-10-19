// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared expression-wrapper normalization used by variable-carrier inference.
 */
import { ts } from "../ts-api.js";

export function stripInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}
