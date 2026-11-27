// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 W2) The call forms that name a realm constructor without reading it as a value: the front end lowers each
 * from its shape (from-ast's `String(v)` ToString and `Object.prototype.toString.call(v)` tag) and the source walk of
 * what a program names (`source-plain-objects.ts`) skips the same shape, by these predicates, so the two cannot drift.
 */
import { ts } from "../ts-api.js";

/** `String(v)` with at most one argument and no spread: from-ast's ToString of the argument. */
export function isStringConversionCall(
  call: ts.CallExpression,
): call is ts.CallExpression & { expression: ts.Identifier } {
  return (
    ts.isIdentifier(call.expression) &&
    call.expression.text === "String" &&
    call.arguments.length <= 1 &&
    !call.arguments.some(ts.isSpreadElement)
  );
}

/** The `Object` of `Object.prototype.toString.call(v)` (one argument, no spread): from-ast's tag of `v`. */
export function objectToStringCallRoot(call: ts.CallExpression): ts.Identifier | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
  const method = callee.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== "toString") return undefined;
  const prototype = method.expression;
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== "prototype") return undefined;
  const root = prototype.expression;
  return ts.isIdentifier(root) &&
    root.text === "Object" &&
    call.arguments.length === 1 &&
    !ts.isSpreadElement(call.arguments[0]!)
    ? root
    : undefined;
}
