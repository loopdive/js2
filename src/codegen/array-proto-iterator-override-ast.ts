// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** AST-only recognition for the two already-supported #1719 CPR write targets. */
import { ts } from "../ts-api.js";

export type ArrayProtoIteratorOverrideKey = "@@iterator" | "values";

/** True when `expression` is exactly the unwrapped builtin `Array.prototype`. */
function isArrayPrototype(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "prototype" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Array"
  );
}

/**
 * Resolve an exact CPR assignment target without checker/codegen state.
 * Transparent receiver wrappers deliberately remain outside this bounded seam
 * (#1750); the existing conservative whole-source brand scan still sees them.
 */
export function arrayProtoIteratorOverrideKeyFromTarget(
  target: ts.Expression,
): ArrayProtoIteratorOverrideKey | undefined {
  if (ts.isPropertyAccessExpression(target)) {
    return isArrayPrototype(target.expression) && target.name.text === "values" ? "values" : undefined;
  }
  if (!ts.isElementAccessExpression(target) || !isArrayPrototype(target.expression)) return undefined;
  const key = target.argumentExpression;
  if (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    key.name.text === "iterator"
  ) {
    return "@@iterator";
  }
  if (ts.isStringLiteral(key) && key.text === "values") return "values";
  return undefined;
}

export function isArrayProtoIteratorAssignTarget(target: ts.Expression): boolean {
  return arrayProtoIteratorOverrideKeyFromTarget(target) !== undefined;
}

export interface DirectArrayProtoIteratorAssignment {
  readonly assignment: ts.BinaryExpression;
  readonly key: ArrayProtoIteratorOverrideKey;
  readonly statement: ts.ExpressionStatement;
  readonly value: ts.Expression;
}

/**
 * Recognize exactly `Array.prototype[Symbol.iterator] = value;` or
 * `Array.prototype.values = value;` as a direct expression statement. This is
 * the shared future admission seam for the checkpoint-2 receiver exception;
 * checkpoint 1 only installs/tests the predicate and does not broaden native
 * generator eligibility.
 */
export function directArrayProtoIteratorAssignment(node: ts.Node): DirectArrayProtoIteratorAssignment | undefined {
  if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return undefined;
  const assignment = node.expression;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const key = arrayProtoIteratorOverrideKeyFromTarget(assignment.left);
  return key === undefined ? undefined : { assignment, key, statement: node, value: assignment.right };
}
