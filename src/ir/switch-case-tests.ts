// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#2952 slices 4/6b, #7354 Ty) The `case` tests a lowered switch admits, decided once for the selector and
 * from-ast: every test is a numeric literal (the slice-4 dispatch table) or every test is a string literal (the
 * slice-6b string dispatch), with at most one `default`. The string dispatch compares only literal tests, so a
 * non-literal or mixed test must never reach it: it would be skipped, neither compared nor evaluated. The Prepared
 * path has no selector, so from-ast asks this too.
 */
import { ts } from "../ts-api.js";

/** A plain NumericLiteral or a prefix-minus NumericLiteral; `null` for any other shape. */
export function numericCaseTestValue(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  )
    return -Number(expr.operand.text.replace(/_/g, ""));
  return null;
}

/** The text of a string-literal test; `null` for any other shape. */
export function stringCaseTestValue(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

export type SwitchCaseTests =
  | { readonly kind: "numeric" | "string" }
  | {
      readonly kind: "rejected";
      readonly reason: "switch-case-test-nonliteral" | "switch-multiple-defaults" | "switch-case-test-mixed";
      readonly node: ts.Node;
    };

export function switchCaseTests(stmt: ts.SwitchStatement): SwitchCaseTests {
  let defaults = 0;
  let numericTests = 0;
  let stringTests = 0;
  for (const clause of stmt.caseBlock.clauses) {
    if (ts.isCaseClause(clause)) {
      if (numericCaseTestValue(clause.expression) !== null) numericTests++;
      else if (stringCaseTestValue(clause.expression) !== null) stringTests++;
      else return { kind: "rejected", reason: "switch-case-test-nonliteral", node: clause.expression };
    } else if (++defaults > 1) return { kind: "rejected", reason: "switch-multiple-defaults", node: clause };
  }
  // §14.12.9 dispatch is strict equality, so a numeric test never matches a string disc (and vice versa); a mixed
  // set would need both mechanisms in one ladder.
  if (numericTests > 0 && stringTests > 0)
    return { kind: "rejected", reason: "switch-case-test-mixed", node: stmt.expression };
  return { kind: stringTests > 0 ? "string" : "numeric" };
}
