// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) Selector admission for the boolean statics `./lowering.ts` lowers.
 * The selector asks this module before it walks the operands; admission is the
 * exact domain of the lowering and of the consumer of its answer, so neither
 * the call nor its consumer demotes at build time (another construct in the
 * unit still may: #7106 plan, follow-ups):
 *   - at most the plan's arity of arguments, none spread; `Object.is` with one
 *     number argument only when it is a literal;
 *   - every operand is `null`, the global `undefined` or `void 0` (never
 *     lowered), or is proved to lower to a number, a string or a boolean —
 *     the IR representation from-ast's `irOperandFamily` will name, not the
 *     checker's type ({@link expressionFamily});
 *   - the IR boolean it answers is consumed where an i32 boolean lowers
 *     ({@link booleanAnswerConsumed}).
 * A dynamic operand is refused: legacy's typed arm answers it through the
 * runtime's typeof test, which this lowering does not make.
 */

import {
  additiveResultFamily,
  binaryOperandsAdmissible,
  conditionalJoinFamily,
  isEqualityOperator,
  isStrictEqualityOperator,
  isTypedBinaryOperator,
  isUndefinedCompareOperand,
  logicalResultFamily,
  nullComparisonFolds,
  slotWriteVerdict,
  undefinedCompareOperandAdmissible,
  type OperandFamily,
} from "../analysis/operand-admissibility.js";
import { ts } from "../../ts-api.js";
import { localIsRewritten } from "../lattice-param-facts.js";
import { effectiveIrReturnTypeNode } from "../select-expression-structure.js";
import { LOWERED_FAMILIES, staticPredicateLiteralFamily, staticPredicatePlan, unsignedOperand } from "./lowering.js";

export interface IrStaticPredicateSelection {
  /** The receiver is the unshadowed ambient namespace. */
  readonly isAmbientNamespace: (receiver: ts.Identifier) => boolean;
  readonly isGlobalUndefined: (operand: ts.Expression) => boolean;
  /**
   * The declaration of the function or block local `identifier` names,
   * annotated or not, rewritten or not; `undefined` for a module binding.
   * from-ast types an unannotated local's slot from its initializer and
   * withdraws a later write of another family, so this module traces only an
   * unannotated local that `localIsRewritten` clears.
   */
  readonly localDeclaration: (identifier: ts.Identifier) => ts.VariableDeclaration | undefined;
  /** The representation family the selector proves any other expression lowers to; `unknown` without a proof. */
  readonly family: (expression: ts.Expression) => OperandFamily;
  /** A string method's call: its arguments need a ToString a boolean does not get. */
  readonly isStringMethodCall: (call: ts.CallExpression) => boolean;
  /** The family of the slot a type node declares (`unknown` for a kind no predicate answer fits). */
  readonly declaredSlotFamily: (type: ts.TypeNode) => OperandFamily;
  /**
   * The family of the callee's parameter the argument at `index` is written
   * into: a top-level function's (`unknown` when that parameter does not
   * resolve, or for a local callee); `undefined` for a member, ambient or
   * imported callee, which has no parameter slot of the program's own.
   */
  readonly argumentSlotFamily: (call: ts.CallExpression, index: number) => OperandFamily | undefined;
}

export type IrStaticPredicateVerdict =
  | { readonly admitted: true; readonly lowered: readonly ts.Expression[] }
  | {
      readonly admitted: false;
      readonly reason: "call-arity-unsupported" | "operand-coercion-unsupported";
      readonly arm: string;
      readonly node: ts.Node;
    };

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
  // `Object.is(x)`: main answers a number `x` through its boxing path, which reads legacy's f64 `undefined`
  // marker as `undefined`, and the lowering cannot tell the marker from a NaN; only a literal `x` is lowered.
  const [single] = lowered;
  if (plan.test === "same-value" && call.arguments.length === 1 && single !== undefined) {
    const literal = ts.isNumericLiteral(unsignedOperand(single));
    if (!literal && expressionFamily(single, options) === "number")
      return refusal("expr-static-predicate-operand", single);
  }
  if (!booleanAnswerConsumed(call, options)) return refusal("expr-static-predicate-consumer", call);
  return { admitted: true, lowered };
}

function refusal(arm: string, node: ts.Node): IrStaticPredicateVerdict {
  return { admitted: false, reason: "operand-coercion-unsupported", arm, node };
}

/**
 * The family `expression` lowers to, as from-ast represents it: an unannotated
 * local takes its initializer's family (not the checker's type of the read),
 * `+` and `&&` / `||` the operators' result families, a conditional its arms'
 * shared family, another static predicate a boolean, an element read none,
 * and anything else the selector's proof.
 */
function expressionFamily(
  expression: ts.Expression,
  options: IrStaticPredicateSelection,
  seen: ReadonlySet<ts.VariableDeclaration> = new Set(),
): OperandFamily {
  let candidate = expression;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  const family = (operand: ts.Expression) => expressionFamily(operand, options, seen);
  if (ts.isIdentifier(candidate)) {
    const local = options.localDeclaration(candidate);
    if (local !== undefined && local.type === undefined) {
      if (local.initializer === undefined || seen.has(local) || localIsRewritten(local)) return "unknown";
      return expressionFamily(local.initializer, options, new Set(seen).add(local));
    }
  }
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return additiveResultFamily(family(candidate.left), family(candidate.right));
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return logicalResultFamily(family(candidate.left), family(candidate.right));
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) return "unknown";
  }
  // An element read may be out of bounds, which the IR reads as NaN on the GC
  // lanes and as 0 on linear — never as `undefined`, so its family is no
  // number a predicate can answer on.
  if (ts.isElementAccessExpression(candidate)) return "unknown";
  if (ts.isConditionalExpression(candidate)) {
    return conditionalJoinFamily(family(candidate.whenTrue), family(candidate.whenFalse));
  }
  if (ts.isCallExpression(candidate) && staticPredicatePlan(candidate, options.isAmbientNamespace) !== undefined) {
    return "boolean";
  }
  return options.family(candidate);
}

/**
 * Is the boolean `answer` produces consumed where the lowering takes an IR
 * boolean? An allow-list, judged with the predicates from-ast withdraws on:
 *   - a condition, `!`, `typeof`, a statement, a template span;
 *   - the initializer of an unannotated local that is never rewritten
 *     (`localIsRewritten`: from-ast withdraws a write of another family into
 *     the initializer's slot);
 *   - a write `slotWriteVerdict` admits a boolean into, judged by the slot's
 *     declared type (`declaredSlotFamily`): a declaration of or `=` into a
 *     local annotated `boolean` or `any`, a `return` into the declared result
 *     (an undeclared one is inferred from the returns), a call's argument into
 *     a top-level function's parameter. A module `var` refuses (a module
 *     boolean reads back without the brand), as do a member target and a
 *     local callee's argument. A member, ambient or imported callee's argument
 *     is admitted, except a string method's: it needs a ToString;
 *   - a comma's sides, `&&` / `||` with a boolean partner and a conditional
 *     arm with a boolean partner forward it: their own position decides;
 *   - a typed binary operator `binaryOperandsAdmissible` admits against the
 *     partner's family, a `null` compare that `nullComparisonFolds`, a strict
 *     `undefined` compare.
 * Everything else refuses: `??` (no null carrier), `in`, `instanceof`, a
 * compound assignment, a member read, `void`, an `as` / `!` / `satisfies`
 * wrapper, an array or object element, a `throw` (`throwOperandAdmissible`).
 */
function booleanAnswerConsumed(answer: ts.Expression, options: IrStaticPredicateSelection): boolean {
  let child: ts.Node = answer;
  let parent = answer.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) {
    return parent.expression === child;
  }
  if (ts.isForStatement(parent)) return parent.condition === child;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isTypeOfExpression(parent) || ts.isExpressionStatement(parent) || ts.isTemplateSpan(parent)) return true;
  if (ts.isVariableDeclaration(parent)) {
    if (!ts.isIdentifier(parent.name)) return false;
    if (parent.type !== undefined) return annotatedLocalTakesBoolean(parent.name, options);
    return options.localDeclaration(parent.name) !== undefined && !localIsRewritten(parent);
  }
  if (ts.isReturnStatement(parent)) {
    const declared = effectiveIrReturnTypeNode(ts.findAncestor(parent, ts.isFunctionLike)!);
    return booleanWritable(declared && options.declaredSlotFamily(declared));
  }
  if (ts.isCallExpression(parent)) {
    if (parent.expression === child || options.isStringMethodCall(parent)) return false;
    return booleanWritable(options.argumentSlotFamily(parent, parent.arguments.indexOf(child as ts.Expression)));
  }
  if (ts.isConditionalExpression(parent)) {
    if (parent.condition === child) return true;
    const partner = parent.whenTrue === child ? parent.whenFalse : parent.whenTrue;
    return (
      conditionalJoinFamily("boolean", expressionFamily(partner, options)) === "boolean" &&
      booleanAnswerConsumed(parent, options)
    );
  }
  return ts.isBinaryExpression(parent) && binaryOperandConsumed(parent, child, options);
}

/** Does a boolean written into a slot of this family stand? `undefined`: no declared slot to judge. */
function booleanWritable(slot: OperandFamily | undefined): boolean {
  return slot === undefined || slotWriteVerdict(slot, "boolean") === "admissible";
}

/** Is `target` a function or block local whose declared type takes a boolean (`boolean`, `any`)? */
function annotatedLocalTakesBoolean(target: ts.Expression, options: IrStaticPredicateSelection): boolean {
  let name = target;
  while (ts.isParenthesizedExpression(name)) name = name.expression;
  const local = ts.isIdentifier(name) ? options.localDeclaration(name) : undefined;
  return local?.type !== undefined && booleanWritable(options.declaredSlotFamily(local.type));
}

function binaryOperandConsumed(
  parent: ts.BinaryExpression,
  child: ts.Node,
  options: IrStaticPredicateSelection,
): boolean {
  const op = parent.operatorToken.kind;
  const partner = parent.left === child ? parent.right : parent.left;
  if (op === ts.SyntaxKind.CommaToken) return parent.left === child || booleanAnswerConsumed(parent, options);
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return (
      logicalResultFamily("boolean", expressionFamily(partner, options)) === "boolean" &&
      booleanAnswerConsumed(parent, options)
    );
  }
  if (op === ts.SyntaxKind.EqualsToken)
    return parent.right === child && annotatedLocalTakesBoolean(parent.left, options);
  if (!isTypedBinaryOperator(op)) return false;
  if (isEqualityOperator(op) && partner.kind === ts.SyntaxKind.NullKeyword) return nullComparisonFolds(op, "boolean");
  if (isStrictEqualityOperator(op) && isUndefinedCompareOperand(partner, () => !options.isGlobalUndefined(partner))) {
    return undefinedCompareOperandAdmissible("boolean");
  }
  const partnerFamily = expressionFamily(partner, options);
  return parent.left === child
    ? binaryOperandsAdmissible(op, "boolean", partnerFamily)
    : binaryOperandsAdmissible(op, partnerFamily, "boolean");
}
