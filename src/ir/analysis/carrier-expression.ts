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
  if (yieldsRight(e)) return carrier(e.right);
  return isCarrierAddition(e, (operand) => carrier(operand) || leaves.addsAsCarrier?.(operand) === true);
}

/**
 * (#7341) Every value `expression` can yield passes `leaf`: a conditional yields either arm, a comma
 * or an `=` assignment its right side (the flow `producesCarrier` follows), anything else itself.
 */
export function everyYieldedValue(expression: ts.Expression, leaf: (value: ts.Expression) => boolean): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const each = (inner: ts.Expression) => everyYieldedValue(inner, leaf);
  if (ts.isConditionalExpression(e)) return each(e.whenTrue) && each(e.whenFalse);
  if (yieldsRight(e)) return each(e.right);
  return leaf(e);
}

/** A comma or an `=` assignment: its value is its right side's. */
function yieldsRight(e: ts.Expression): e is ts.BinaryExpression {
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  return op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken;
}
