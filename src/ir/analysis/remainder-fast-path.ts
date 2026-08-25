// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { staticIntegerRange, type StaticIntegerRange, type StaticIntegerRangeContext } from "./static-numeric-range.js";

const I64_MIN = -(2 ** 63);
const I64_MAX_EXCLUSIVE = 2 ** 63;

type IntegerProof =
  | { readonly kind: "known"; readonly range: StaticIntegerRange }
  | { readonly kind: "impossible" }
  | { readonly kind: "unknown" };

export type RemainderFastPathPlan =
  | { readonly kind: "none" }
  | { readonly kind: "direct-i64" }
  | {
      readonly kind: "guarded-i64";
      readonly checkLeftIntegerRange: boolean;
      readonly checkRightIntegerRange: boolean;
      readonly checkDivisorNonZero: boolean;
      readonly checkSignedOverflow: boolean;
    };

/** Conservative runtime plan when no source expression is available (`%=`). */
export const UNKNOWN_REMAINDER_FAST_PATH: RemainderFastPathPlan = {
  kind: "guarded-i64",
  checkLeftIntegerRange: true,
  checkRightIntegerRange: true,
  checkDivisorNonZero: true,
  checkSignedOverflow: true,
};

/**
 * Plan JS Number remainder as direct-i64, guarded-i64, or exact-helper only.
 *
 * Positive AOT facts remove guards. A negative fact (fractional/non-finite
 * constant, a value outside signed i64, or a definitely-zero divisor) removes
 * the speculative fast path entirely. Only genuinely unknown facts receive a
 * runtime check and exact-helper fallback.
 */
export function remainderFastPathPlan(
  ctx: StaticIntegerRangeContext | undefined,
  left: ts.Expression,
  right: ts.Expression,
): RemainderFastPathPlan {
  if (process.env.JS2WASM_INLINE_REMAINDER_FAST_PATH === "0") return { kind: "none" };

  const lhs = proveIntegerOperand(ctx, left);
  const rhs = proveIntegerOperand(ctx, right);
  if (lhs.kind === "impossible" || rhs.kind === "impossible") return { kind: "none" };
  if (rhs.kind === "known" && rhs.range.min === 0 && rhs.range.max === 0) return { kind: "none" };

  const rhsExcludesZero = rhs.kind === "known" && (rhs.range.max < 0 || rhs.range.min > 0);
  const overflowImpossible =
    (lhs.kind === "known" && !rangeContains(lhs.range, I64_MIN)) ||
    (rhs.kind === "known" && !rangeContains(rhs.range, -1));

  if (lhs.kind === "known" && rhs.kind === "known" && rhsExcludesZero && overflowImpossible) {
    return { kind: "direct-i64" };
  }

  return {
    kind: "guarded-i64",
    checkLeftIntegerRange: lhs.kind === "unknown",
    checkRightIntegerRange: rhs.kind === "unknown",
    checkDivisorNonZero: !rhsExcludesZero,
    checkSignedOverflow: !overflowImpossible,
  };
}

function proveIntegerOperand(ctx: StaticIntegerRangeContext | undefined, expression: ts.Expression): IntegerProof {
  const constant = numericConstant(expression);
  if (constant !== undefined) {
    if (!Number.isFinite(constant) || !Number.isInteger(constant)) return { kind: "impossible" };
    if (constant < I64_MIN || constant >= I64_MAX_EXCLUSIVE) return { kind: "impossible" };
    return { kind: "known", range: { min: constant, max: constant } };
  }

  const range = ctx ? staticIntegerRange(ctx, expression) : undefined;
  if (!range) return { kind: "unknown" };
  if (range.max < I64_MIN || range.min >= I64_MAX_EXCLUSIVE) return { kind: "impossible" };
  if (range.min < I64_MIN || range.max >= I64_MAX_EXCLUSIVE) return { kind: "unknown" };
  return { kind: "known", range };
}

function numericConstant(expression: ts.Expression): number | undefined {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isNumericLiteral(current)) return Number(current.text.replace(/_/g, ""));
  if (
    ts.isPrefixUnaryExpression(current) &&
    (current.operator === ts.SyntaxKind.MinusToken || current.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = numericConstant(current.operand);
    if (operand !== undefined) return current.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  return undefined;
}

function rangeContains(range: StaticIntegerRange, value: number): boolean {
  return range.min <= value && value <= range.max;
}
