// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7338) The ONE definition of "this expression lowers to the dynamic
 * carrier", over source shape. from-ast reads it with the bindings it has
 * lowered (`expressionProducesDynamic`); the selector reads it with the
 * carriers the `Object` statics table introduces (`lowersToCarrier`), so the
 * two cannot disagree on how a carrier flows through an expression, only on
 * which leaves are carriers.
 *
 * A carrier flows through parentheses, a member or element read, a method
 * call on it (`recv.m()` answers the carrier), the right side of a comma or
 * an `=` assignment, a conditional whose arms are both carriers, and a `+`
 * with a carrier operand.
 */

import { ts } from "../../ts-api.js";
import { isCarrierAddition } from "./operand-admissibility.js";

/** What a side knows about the leaves of an expression. */
export interface CarrierLeaves {
  /** An identifier or `this`: its binding holds the carrier. */
  readonly binding: (node: ts.Identifier | ts.ThisExpression) => boolean;
  /**
   * A call's own answer; undefined for a method call whose answer is its
   * receiver's (the carrier's method call answers the carrier).
   */
  readonly call: (call: ts.CallExpression) => boolean | undefined;
  /** A conditional whose arms are not both carriers but that still lowers to one. */
  readonly conditional?: (conditional: ts.ConditionalExpression) => boolean;
  /** A `+` operand that adds as the carrier though it is not one (a fresh wrapper's ToPrimitive). */
  readonly addsAsCarrier?: (operand: ts.Expression) => boolean;
}

export function producesCarrier(expression: ts.Expression, leaves: CarrierLeaves): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const carrier = (inner: ts.Expression) => producesCarrier(inner, leaves);
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return leaves.binding(e as ts.Identifier);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return carrier(e.expression);
  if (ts.isCallExpression(e)) {
    const answer = leaves.call(e);
    if (answer !== undefined) return answer;
    return ts.isPropertyAccessExpression(e.expression) && carrier(e.expression.expression);
  }
  if (ts.isConditionalExpression(e)) {
    return (carrier(e.whenTrue) && carrier(e.whenFalse)) || leaves.conditional?.(e) === true;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) return carrier(e.right);
  }
  return isCarrierAddition(e, (operand) => carrier(operand) || leaves.addsAsCarrier?.(operand) === true);
}
