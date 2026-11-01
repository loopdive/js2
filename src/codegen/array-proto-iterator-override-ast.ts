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

/**
 * (#5139) `delete Array.prototype[Symbol.iterator]` / `delete
 * Array.prototype.values` — the removal counterpart of an override assignment.
 * Reuses the same exact-target recognition, so the two stay in lockstep.
 */
export function arrayProtoIteratorDeleteKey(node: ts.Node): ArrayProtoIteratorOverrideKey | undefined {
  if (!ts.isDeleteExpression(node)) return undefined;
  return arrayProtoIteratorOverrideKeyFromTarget(node.expression);
}

export function isArrayProtoIteratorAssignTarget(target: ts.Expression): boolean {
  return arrayProtoIteratorOverrideKeyFromTarget(target) !== undefined;
}
