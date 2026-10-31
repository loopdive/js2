// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) Selector admission for the boolean statics `./lowering.ts` lowers.
 * The selector asks this module before it walks the operands; admission is the
 * exact domain of the lowering and of the consumer of its answer, so a claimed
 * call never demotes at build time:
 *   - at most the plan's arity of arguments, none spread;
 *   - every operand is `null`, the global `undefined` or `void 0` (never
 *     lowered), or is proved to lower to a number, a string or a boolean;
 *   - the IR boolean it answers is consumed where an i32 boolean lowers
 *     ({@link booleanAnswerConsumed}).
 * A dynamic operand is refused: legacy's typed arm answers it through the
 * runtime's typeof test, which this lowering does not make.
 */

import {
  additiveOperandsProvable,
  binaryOperandsAdmissible,
  isEqualityOperator,
  isTypedBinaryOperator,
  nullComparisonFolds,
  throwOperandAdmissible,
  type OperandFamily,
} from "../analysis/operand-admissibility.js";
import { ts } from "../../ts-api.js";
import { staticPredicateLiteralFamily, staticPredicatePlan } from "./lowering.js";

export interface IrStaticPredicateSelection {
  /** The receiver is the unshadowed ambient namespace. */
  readonly isAmbientNamespace: (receiver: ts.Identifier) => boolean;
  readonly isGlobalUndefined: (operand: ts.Expression) => boolean;
  /** The family the selector proves an expression lowers to; `unknown` without a proof. */
  readonly family: (expression: ts.Expression) => OperandFamily;
}

export type IrStaticPredicateVerdict =
  | { readonly admitted: true; readonly lowered: readonly ts.Expression[] }
  | {
      readonly admitted: false;
      readonly reason: "call-arity-unsupported" | "operand-coercion-unsupported";
      readonly arm: string;
      readonly node: ts.Node;
    };

const LOWERED_FAMILIES: ReadonlySet<OperandFamily> = new Set(["number", "string", "boolean"]);

/** `undefined` when `call` is not an ambient static predicate, else the admission verdict. */
export function selectStaticPredicateCall(
  call: ts.CallExpression,
  options: IrStaticPredicateSelection,
): IrStaticPredicateVerdict | undefined {
  const plan = staticPredicatePlan(call, options.isAmbientNamespace);
  if (plan === undefined) return undefined;
  if (call.arguments.length > plan.arity || call.arguments.some(ts.isSpreadElement)) {
    return { admitted: false, reason: "call-arity-unsupported", arm: "expr-static-predicate-arity", node: call };
  }
  const lowered: ts.Expression[] = [];
  for (const operand of call.arguments) {
    if (staticPredicateLiteralFamily(operand, options.isGlobalUndefined) !== undefined) continue;
    if (!LOWERED_FAMILIES.has(expressionFamily(operand, options))) {
      return refusal("expr-static-predicate-operand", operand);
    }
    lowered.push(operand);
  }
  if (!booleanAnswerConsumed(call, options)) return refusal("expr-static-predicate-consumer", call);
  return { admitted: true, lowered };
}

function refusal(arm: string, node: ts.Node): IrStaticPredicateVerdict {
  return { admitted: false, reason: "operand-coercion-unsupported", arm, node };
}

/**
 * The family `expression` lowers to: a `+` only when `additiveOperandsProvable`
 * takes it to a number or a string, another static predicate a boolean,
 * anything else by the selector's proof.
 */
function expressionFamily(expression: ts.Expression, options: IrStaticPredicateSelection): OperandFamily {
  let candidate = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionFamily(candidate.left, options);
    const right = expressionFamily(candidate.right, options);
    const proof = (family: OperandFamily) => (family === "number" || family === "string" ? family : "unprovable");
    return additiveOperandsProvable(proof(left), proof(right)) ? left : "unknown";
  }
  if (ts.isCallExpression(candidate) && staticPredicatePlan(candidate, options.isAmbientNamespace) !== undefined) {
    return "boolean";
  }
  return options.family(candidate);
}

/**
 * Is the boolean `answer` produces consumed where the lowering takes an IR
 * boolean? Parentheses, a comma's right side, `&&` / `||` with a boolean
 * partner and a conditional branch with a boolean partner forward it, so their
 * own position decides. Refused where from-ast withdraws: `throw`
 * (`throwOperandAdmissible`), a typed binary operator whose partner
 * `binaryOperandsAdmissible` refuses (`+`, a number, a string or an unproved
 * partner), a string method's argument (no ToString), and every other binary
 * operator but a plain `=` value — `??` has no null carrier, `in`,
 * `instanceof` and the compound assignments no boolean operand. Every other
 * consumer takes the i32 boolean.
 */
function booleanAnswerConsumed(answer: ts.Expression, options: IrStaticPredicateSelection): boolean {
  let child: ts.Node = answer;
  let parent = answer.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isThrowStatement(parent)) return throwOperandAdmissible("boolean");
  if (ts.isConditionalExpression(parent) && parent.condition !== child) {
    const partner = parent.whenTrue === child ? parent.whenFalse : parent.whenTrue;
    return expressionFamily(partner, options) === "boolean" && booleanAnswerConsumed(parent, options);
  }
  if (ts.isCallExpression(parent) && parent.expression !== child) {
    const callee = parent.expression;
    return !ts.isPropertyAccessExpression(callee) || expressionFamily(callee.expression, options) !== "string";
  }
  if (!ts.isBinaryExpression(parent)) return true;
  const op = parent.operatorToken.kind;
  const partner = parent.left === child ? parent.right : parent.left;
  if (op === ts.SyntaxKind.CommaToken) return parent.left === child || booleanAnswerConsumed(parent, options);
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return expressionFamily(partner, options) === "boolean" && booleanAnswerConsumed(parent, options);
  }
  if (!isTypedBinaryOperator(op)) return op === ts.SyntaxKind.EqualsToken && parent.right === child;
  if (isEqualityOperator(op) && partner.kind === ts.SyntaxKind.NullKeyword) return nullComparisonFolds(op, "boolean");
  const partnerFamily = expressionFamily(partner, options);
  return parent.left === child
    ? binaryOperandsAdmissible(op, "boolean", partnerFamily)
    : binaryOperandsAdmissible(op, partnerFamily, "boolean");
}
