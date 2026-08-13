// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "./ts-api.js";

/**
 * The one indirect-eval spelling this increment may route through the host
 * import. Binding, capability, and carrier proofs stay with their owning
 * compiler phases; this module owns syntax only.
 */
export interface ExactIndirectEvalStatement {
  readonly evalIdentifier: ts.Identifier;
  readonly source: ts.Expression;
}

function stripParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * Return the identifier from exactly `(0, eval)(source)`, after stripping
 * parentheses around the comma operands. Direct eval, aliases, and arbitrary
 * comma expressions intentionally return undefined.
 */
export function exactIndirectEvalIdentifier(call: ts.CallExpression): ts.Identifier | undefined {
  const callee = stripParentheses(call.expression);
  if (!ts.isBinaryExpression(callee) || callee.operatorToken.kind !== ts.SyntaxKind.CommaToken) return undefined;
  const left = stripParentheses(callee.left);
  const right = stripParentheses(callee.right);
  if (!ts.isNumericLiteral(left) || Number(left.text) !== 0 || !ts.isIdentifier(right) || right.text !== "eval") {
    return undefined;
  }
  return right;
}

/**
 * Return the complete statement-position shape accepted by the host-only IR
 * slice. The call result must be directly discarded by an expression statement
 * and the one source argument must not be spread.
 */
export function exactIndirectEvalStatement(call: ts.CallExpression): ExactIndirectEvalStatement | undefined {
  if (call.questionDotToken || !ts.isExpressionStatement(call.parent) || call.parent.expression !== call)
    return undefined;
  const evalIdentifier = exactIndirectEvalIdentifier(call);
  const source = call.arguments.length === 1 ? call.arguments[0] : undefined;
  if (!evalIdentifier || !source || ts.isSpreadElement(source)) return undefined;
  return { evalIdentifier, source };
}
