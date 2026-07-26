// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static resolution for Object builtin values captured in locals.
 *
 * Keeping this analysis separate from call lowering lets declaration-time
 * representation selection and expression-time semantic routing agree on the
 * exact same single-assignment builtin identity.
 */
import { ts } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { skipTransparentExpressions } from "./shared.js";

export function resolveBoundFunctionInitializer(
  oracle: TypeOracle,
  expr: ts.Expression,
): ts.CallExpression | undefined {
  const init = oracle.variableInitializerOf(expr);
  if (!init) return undefined;
  if (!ts.isCallExpression(init)) return undefined;
  const callee = init.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text === "bind") return init;
  if (
    callee.name.text === "call" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "bind" &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === "prototype" &&
    ts.isIdentifier(callee.expression.expression.expression) &&
    callee.expression.expression.expression.text === "Function"
  ) {
    return init;
  }
  return undefined;
}

export function calleeIsBoundFunctionVar(oracle: TypeOracle, expr: ts.Expression): boolean {
  return resolveBoundFunctionInitializer(oracle, expr) !== undefined;
}

export function resolveUncurriedObjectPrototypeMethod(
  oracle: TypeOracle,
  expr: ts.Expression,
): "hasOwnProperty" | "propertyIsEnumerable" | "valueOf" | undefined {
  const init = resolveBoundFunctionInitializer(oracle, expr);
  if (!init || !ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== "bind") {
    return undefined;
  }
  const callValue = init.expression.expression;
  if (
    !ts.isPropertyAccessExpression(callValue) ||
    callValue.name.text !== "call" ||
    !ts.isPropertyAccessExpression(callValue.expression) ||
    callValue.expression.name.text !== "prototype" ||
    !ts.isIdentifier(callValue.expression.expression) ||
    callValue.expression.expression.text !== "Function"
  ) {
    return undefined;
  }
  const target = init.arguments[0];
  if (
    !target ||
    !ts.isPropertyAccessExpression(target) ||
    !ts.isPropertyAccessExpression(target.expression) ||
    target.expression.name.text !== "prototype" ||
    !ts.isIdentifier(target.expression.expression) ||
    target.expression.expression.text !== "Object"
  ) {
    return undefined;
  }
  const method = target.name.text;
  return method === "hasOwnProperty" || method === "propertyIsEnumerable" || method === "valueOf" ? method : undefined;
}

export type StoredObjectStaticMethod =
  | "defineProperty"
  | "defineProperties"
  | "freeze"
  | "seal"
  | "preventExtensions"
  | "getOwnPropertyDescriptor"
  | "getOwnPropertyNames";

/**
 * Resolve the exact single-assignment stored builtin-static shape whose generic
 * typed-call adapter cannot preserve a closed-struct argument carrier.
 */
export function resolveStoredObjectStaticMethod(
  oracle: TypeOracle,
  expr: ts.Expression,
): StoredObjectStaticMethod | undefined {
  const initializer = oracle.variableInitializerOf(expr);
  if (!initializer) return undefined;
  const init = skipTransparentExpressions(initializer);
  if (!ts.isPropertyAccessExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== "Object") {
    return undefined;
  }
  switch (init.name.text) {
    case "defineProperty":
    case "defineProperties":
    case "freeze":
    case "seal":
    case "preventExtensions":
    case "getOwnPropertyDescriptor":
    case "getOwnPropertyNames":
      return init.name.text;
    default:
      return undefined;
  }
}
