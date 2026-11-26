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
 * with a carrier operand. (#7354 W) `mayYieldCarrier` asks the "may" question
 * over the same walk.
 */

import { ts } from "../../ts-api.js";
import { skipOuterExpressions } from "../../shared/binding-writes.js";
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
  /** (#7462) A `new` expression's own answer: one that lowers to `dyn.construct` yields the carrier. */
  readonly construct?: (construction: ts.NewExpression) => boolean;
  /** A conditional whose arms are not both carriers but that still lowers to one. */
  readonly conditional?: (conditional: ts.ConditionalExpression) => boolean;
  /** A `+` operand that adds as the carrier though it is not one (a fresh wrapper's ToPrimitive). */
  readonly addsAsCarrier?: (operand: ts.Expression) => boolean;
}

/** Every value `expression` can yield is the carrier. */
export function producesCarrier(expression: ts.Expression, leaves: CarrierLeaves): boolean {
  return yieldsCarrier(expression, leaves, "every");
}

/**
 * (#7354 W) Some value `expression` can yield may be the carrier: the "may" dual of {@link producesCarrier}. A proof
 * that an expression has one primitive representation fails when any of its values may be the carrier. Beyond the
 * flows both questions share, a value also passes on as an operand of `&&` / `||` / `??` and through a type
 * projection; `producesCarrier` does not join through those, as its callers' lowerings do not.
 */
export function mayYieldCarrier(expression: ts.Expression, leaves: CarrierLeaves): boolean {
  return yieldsCarrier(expression, leaves, "some");
}

/** How the values an expression can yield combine: all of them, or any one. */
type Quantifier = "every" | "some";

function yieldsCarrier(expression: ts.Expression, leaves: CarrierLeaves, quantifier: Quantifier): boolean {
  const carrier = (inner: ts.Expression) => yieldsCarrier(inner, leaves, quantifier);
  const leaf = (e: ts.Expression): boolean => {
    if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return leaves.binding(e as ts.Identifier);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return carrier(e.expression);
    if (ts.isCallExpression(e)) {
      const answer = leaves.call(e);
      if (answer !== undefined) return answer;
      return ts.isPropertyAccessExpression(e.expression) && carrier(e.expression.expression);
    }
    if (ts.isNewExpression(e)) return leaves.construct?.(e) === true;
    if (quantifier === "some") {
      const projected = skipOuterExpressions(e);
      if (projected !== e) return carrier(projected);
      if (ts.isBinaryExpression(e) && yieldsOperand(e.operatorToken.kind)) return carrier(e.left) || carrier(e.right);
    }
    return isCarrierAddition(e, (operand) => carrier(operand) || leaves.addsAsCarrier?.(operand) === true);
  };
  return yieldedValues(expression, leaf, quantifier, leaves.conditional);
}

/**
 * Every value `expression` can yield passes `leaf`: a conditional yields either arm (or passes as a
 * whole by `conditional`), a comma or an `=` assignment its right side, anything else itself.
 */
export function everyYieldedValue(
  expression: ts.Expression,
  leaf: (value: ts.Expression) => boolean,
  conditional?: (conditional: ts.ConditionalExpression) => boolean,
): boolean {
  return yieldedValues(expression, leaf, "every", conditional);
}

function yieldedValues(
  expression: ts.Expression,
  leaf: (value: ts.Expression) => boolean,
  quantifier: Quantifier,
  conditional?: (conditional: ts.ConditionalExpression) => boolean,
): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const each = (inner: ts.Expression) => yieldedValues(inner, leaf, quantifier, conditional);
  if (ts.isConditionalExpression(e)) {
    const arms = quantifier === "every" ? each(e.whenTrue) && each(e.whenFalse) : each(e.whenTrue) || each(e.whenFalse);
    return arms || conditional?.(e) === true;
  }
  if (yieldsRight(e)) return each(e.right);
  return leaf(e);
}

/** `&&` / `||` / `??`: the value is one of the operands. */
function yieldsOperand(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.AmpersandAmpersandToken ||
    op === ts.SyntaxKind.BarBarToken ||
    op === ts.SyntaxKind.QuestionQuestionToken
  );
}

/** A comma or an `=` assignment: its value is its right side's. */
function yieldsRight(e: ts.Expression): e is ts.BinaryExpression {
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  return op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken;
}
