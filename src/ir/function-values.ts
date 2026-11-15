// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// (#7349) Function values: where a function is read as a value, where such a value (or the result of a call through
// one) is consumed as the dynamic carrier, and which calls go through a dynamic value. The selector, the planner, the
// call graph and from-ast ask these questions here instead of each keeping its own position list.
import { ts } from "../ts-api.js";
import { outermostParenthesized } from "../shared/binding-writes.js";
import {
  dynamicCallArgumentAdmissible,
  isTypedBinaryOperator,
  type OperandFamily,
} from "./analysis/operand-admissibility.js";
import { isFunctionObjectReceiverUse } from "./select-expression-structure.js";

/**
 * How `node`, an identifier that names a function, is used: as the receiver of
 * one of the function object's own expandos (`F.x(…)`, `F.x = v`, see
 * {@link isFunctionObjectReceiverUse}), as a whole value, or neither. A direct
 * call, a constructor callee, an `instanceof` operand, a write and a declared
 * name are no value read; nor is any other member access, because the boxed
 * function object does not resolve the realm's members (`F.bind`, `F.caller`).
 */
export function functionValueUse(node: ts.Identifier): "receiver" | "value" | undefined {
  if (isFunctionObjectReceiverUse(node, { chainedWrite: true })) return "receiver";
  const value = outermostParenthesized(node);
  const parent = value.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === value)
    return undefined;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === value) return undefined;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) return undefined;
    if (parent.left === value && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)
      return undefined;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isDeleteExpression(parent))
    return ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken
      ? "value"
      : undefined;
  if ((parent as { readonly name?: ts.Node }).name === value || ts.isShorthandPropertyAssignment(parent))
    return undefined;
  return "value";
}

/** The selector's answers about the consumers of a carrier that depend on its own state. */
export interface CarrierSinkHost {
  /** Does argument `index` of `call` cross into the callee as the carrier? */
  argumentTakesCarrier(call: ts.CallExpression, index: number): boolean;
  /** Does `expr` construct through the dynamic carrier, taking every argument as one? */
  constructTakesCarrier(expr: ts.NewExpression): boolean;
  /** Is the member write `store = value` a dynamic member write on a function object? */
  storeTakesCarrier(store: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean;
}

/** An operator that reads its operand as the carrier: a typed binary operator, `typeof` or `!`. */
export function operatorReadsCarrier(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return isTypedBinaryOperator(parent.operatorToken.kind);
  if (ts.isTypeOfExpression(parent)) return true;
  return ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken;
}

/**
 * Does the position of `value` take the dynamic carrier as-is? A discarded
 * statement value, an operator that reads the carrier, an argument or a stored
 * value the host says crosses as one. Anywhere else the selector would type the
 * value by the checker's signature, which a carrier does not have.
 */
export function carrierSink(value: ts.Expression, host: CarrierSinkHost): boolean {
  const node = outermostParenthesized(value);
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || operatorReadsCarrier(node)) return true;
  if (ts.isCallExpression(parent) && parent.expression !== node)
    return host.argumentTakesCarrier(parent, parent.arguments.indexOf(node));
  if (ts.isNewExpression(parent) && parent.expression !== node) return host.constructTakesCarrier(parent);
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left))
  )
    return host.storeTakesCarrier(parent.left);
  return false;
}

/**
 * The callee of a bare call `f(…)` that may go through a dynamic value: a call through a binding that holds the
 * carrier lowers through `__apply_closure` with an undefined receiver. Whether `f` holds the carrier is each asker's
 * binding question (the selector's, the call graph's, from-ast's). An optional or spread call never does.
 */
export function bareCallCallee(call: ts.CallExpression): ts.Identifier | undefined {
  const callee = call.expression;
  return ts.isIdentifier(callee) && !call.questionDotToken && !call.arguments.some(ts.isSpreadElement)
    ? callee
    : undefined;
}

/**
 * (#7287) Every argument of a call through a script `var`'s dynamic home crosses
 * into the carrier (`dynamicCallArgumentAdmissible`), judged by the syntax the
 * selector and from-ast both see.
 */
export function argumentsCrossSyntactically(call: ts.CallExpression): boolean {
  return call.arguments.every((argument) => dynamicCallArgumentAdmissible(syntacticArgumentFamily(argument)));
}

/** The families `dynamicCallArgumentAdmissible` refuses that an argument shows syntactically. */
function syntacticArgumentFamily(argument: ts.Expression): OperandFamily {
  let value = argument;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (value.kind === ts.SyntaxKind.NullKeyword) return "nullish";
  return ts.isArrayLiteralExpression(value) ? "vec<other>" : "unknown";
}
