// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static resolution for builtin values captured in locals.
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

function boundTargetOf(init: ts.CallExpression): ts.Expression | undefined {
  const callee = skipTransparentExpressions(init.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text === "bind") return callee.expression;
  if (
    callee.name.text === "call" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "bind"
  ) {
    return init.arguments[0];
  }
  return undefined;
}

/**
 * Prove that a stored bind result ultimately targets a compiled callable.
 *
 * This is deliberately conservative: parameters, property reads, calls and
 * otherwise dynamic values may be caller-owned JS functions and therefore
 * retain the explicit callback-boundary fallback. Function declarations,
 * function/arrow initializers, and chains of bind results rooted in one of
 * those shapes stay entirely in Wasm.
 */
export function boundFunctionTargetIsDefinitelyCompiled(oracle: TypeOracle, expr: ts.Expression): boolean {
  const init = resolveBoundFunctionInitializer(oracle, expr);
  const root = init && boundTargetOf(init);
  if (!root) return false;
  const seen = new Set<ts.Node>();
  const visit = (value: ts.Expression): boolean => {
    const inner = skipTransparentExpressions(value);
    if (seen.has(inner)) return false;
    seen.add(inner);
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return true;
    if (!ts.isIdentifier(inner)) return false;
    const declaration = oracle.valueDeclarationOf(inner);
    if (declaration && ts.isFunctionDeclaration(declaration)) return true;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    const variableInit = skipTransparentExpressions(declaration.initializer);
    if (ts.isArrowFunction(variableInit) || ts.isFunctionExpression(variableInit)) return true;
    if (!ts.isCallExpression(variableInit)) return false;
    const nestedTarget = boundTargetOf(variableInit);
    return nestedTarget ? visit(nestedTarget) : false;
  };
  return visit(root);
}

function resolvesToConstFunctionPrototypeMethod(
  oracle: TypeOracle,
  expr: ts.Expression,
  method: "apply" | "bind" | "call",
): boolean {
  const value = skipTransparentExpressions(expr);
  if (!ts.isIdentifier(value)) return false;
  const declaration = oracle.valueDeclarationOf(value);
  if (!declaration || !ts.isBindingElement(declaration) || declaration.dotDotDotToken) return false;
  const property = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(property) || property.text !== method) return false;
  const pattern = declaration.parent;
  if (!ts.isObjectBindingPattern(pattern)) return false;
  const variable = pattern.parent;
  if (!ts.isVariableDeclaration(variable) || variable.name !== pattern || !variable.initializer) return false;
  const list = variable.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
  const initializer = skipTransparentExpressions(variable.initializer);
  return (
    ts.isPropertyAccessExpression(initializer) &&
    initializer.name.text === "prototype" &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "Function"
  );
}

/**
 * Resolve Deno's immutable `applyBind = bind.bind(apply)` primordial helper.
 * Calling `applyBind(target, receiver)` is exactly
 * `Function.prototype.apply.bind(target, receiver)`. Returning the captured
 * `apply` expression lets call lowering mint the ordinary native bound-function
 * carrier without trying to invoke the still-generic Function.prototype.bind
 * method-value closure.
 */
export function resolveApplyBindAlias(oracle: TypeOracle, expr: ts.Expression): ts.Expression | undefined {
  const initializer = oracle.variableInitializerOf(expr);
  if (!initializer) return undefined;
  const init = skipTransparentExpressions(initializer);
  if (
    !ts.isCallExpression(init) ||
    init.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(init.expression) ||
    init.expression.name.text !== "bind"
  ) {
    return undefined;
  }
  const bindValue = init.expression.expression;
  const applyValue = init.arguments[0]!;
  if (!resolvesToConstFunctionPrototypeMethod(oracle, bindValue, "bind")) return undefined;
  if (!resolvesToConstFunctionPrototypeMethod(oracle, applyValue, "apply")) return undefined;
  return applyValue;
}

/**
 * Resolve Deno's immutable `uncurryThis = bind.bind(call)` primordial helper.
 * Calling `uncurryThis(target)` is exactly
 * `Function.prototype.call.bind(target)`. As with `applyBind`, exposing the
 * captured method lets call lowering construct the ordinary native bound
 * function directly instead of invoking the generic `bind` method-value body.
 */
export function resolveUncurryThisAlias(oracle: TypeOracle, expr: ts.Expression): ts.Expression | undefined {
  const initializer = oracle.variableInitializerOf(expr);
  if (!initializer) return undefined;
  const init = skipTransparentExpressions(initializer);
  if (
    !ts.isCallExpression(init) ||
    init.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(init.expression) ||
    init.expression.name.text !== "bind"
  ) {
    return undefined;
  }
  const bindValue = init.expression.expression;
  const callValue = init.arguments[0]!;
  if (!resolvesToConstFunctionPrototypeMethod(oracle, bindValue, "bind")) return undefined;
  if (!resolvesToConstFunctionPrototypeMethod(oracle, callValue, "call")) return undefined;
  return callValue;
}

export type UncurriedBuiltinPrototypeMethod =
  | { builtin: "Array"; method: "join" | "push" }
  | { builtin: "Object"; method: "hasOwnProperty" | "propertyIsEnumerable" | "valueOf" };

/**
 * Resolve the exact immutable `Function.prototype.call.bind(Builtin.prototype.m)`
 * aliases used by test262's propertyHelper. Invocation can then reuse the
 * corresponding native direct-call lowering instead of the incomplete generic
 * standalone builtin-method carrier.
 */
export function resolveUncurriedBuiltinPrototypeMethod(
  oracle: TypeOracle,
  expr: ts.Expression,
): UncurriedBuiltinPrototypeMethod | undefined {
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
    !ts.isIdentifier(target.expression.expression)
  ) {
    return undefined;
  }
  const builtin = target.expression.expression.text;
  const method = target.name.text;
  if (builtin === "Array" && (method === "join" || method === "push")) {
    return { builtin, method };
  }
  if (
    builtin === "Object" &&
    (method === "hasOwnProperty" || method === "propertyIsEnumerable" || method === "valueOf")
  ) {
    return { builtin, method };
  }
  return undefined;
}

export type StoredObjectStaticMethod =
  | "assign"
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
    case "assign":
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
