// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 compareArray.format) `Array.prototype.<m>.call(recv, …args)` — the
 * §23.1.3 prototype BORROW over a dynamic receiver (`compareArray.format`'s
 * `Array.prototype.map.call(arrayLike, String)` in test262's assert.js).
 *
 * The IR never materializes `Array.prototype.<m>` as a value: a method read
 * off an ambient intrinsic has no exact IR carrier (#7123). It lowers the
 * whole borrow as ONE reflective call to the per-(method, arity) wrapper
 * `__ir_arr_borrow_<m>_<n>(recv, a0, …) -> carrier`, which codegen builds from
 * legacy's own borrow compiler over a fixed template
 * (`codegen/array/ir-array-prototype-borrow.ts`). This module is the shape
 * and naming contract both the selector and from-ast read, so neither
 * re-spells the AST walk.
 */
import { ts } from "../ts-api.js";
import { irWrapperSymbol, irWrapperSymbolIsNameable, parseIrWrapperSymbol } from "./dynamic-method-call-names.js";
import { isStringSurfaceMethod } from "./string-method-surface.js";

const IR_ARRAY_BORROW_PREFIX = "__ir_arr_borrow_";

export interface PrototypeBorrowCall {
  /** The constructor identifier — callers settle shadowing and ambient-ness. */
  readonly root: ts.Identifier;
  readonly method: string;
  /** The borrowed receiver: `.call`'s first argument, or a fresh `new String(v)`'s `v`. */
  readonly receiver: ts.Expression;
  /** The method's arguments: `.call`'s remaining ones; their count is the wrapper's arity. */
  readonly args: readonly ts.Expression[];
}

/**
 * Match the exact `<constructor>.prototype.<m>.call(recv, …args)` shape: a
 * `.call` on a `.prototype.<m>` read off the identifier `constructorName`, at
 * least the receiver argument, no spread. Pure syntax — no scope, ambient or
 * lane question is answered here. (#7106 lever P) `String`'s borrow reads it too.
 */
function matchPrototypeBorrowCall(
  expr: ts.CallExpression,
  constructorName: "Array" | "String",
): PrototypeBorrowCall | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
  const methodAccess = callee.expression;
  if (!ts.isPropertyAccessExpression(methodAccess) || !ts.isIdentifier(methodAccess.name)) return undefined;
  const proto = methodAccess.expression;
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return undefined;
  const root = proto.expression;
  if (!ts.isIdentifier(root) || root.text !== constructorName) return undefined;
  const [receiver, ...args] = expr.arguments;
  if (receiver === undefined || expr.arguments.some(ts.isSpreadElement)) return undefined;
  return { root, method: methodAccess.name.text, receiver, args };
}

/**
 * (#7106 lever SR) `new String(v).<m>(…args)` for a method the string surface
 * has a row for: a method called on a fresh wrapper of one argument. Its
 * `this` is only converted by the method (ToString(wrapper) = ToString(v)), so
 * the call is the borrow with receiver `v` and the wrapper's identity is never
 * observed.
 */
function matchStringWrapperMethodCall(expr: ts.CallExpression): PrototypeBorrowCall | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || !isStringSurfaceMethod(callee.name.text)) return undefined;
  let wrapper: ts.Expression = callee.expression;
  while (ts.isParenthesizedExpression(wrapper)) wrapper = wrapper.expression;
  if (!ts.isNewExpression(wrapper) || !ts.isIdentifier(wrapper.expression) || wrapper.expression.text !== "String") {
    return undefined;
  }
  const receiver = wrapper.arguments?.length === 1 ? wrapper.arguments[0]! : undefined;
  if (receiver === undefined || ts.isSpreadElement(receiver) || expr.arguments.some(ts.isSpreadElement))
    return undefined;
  return { root: wrapper.expression, method: callee.name.text, receiver, args: expr.arguments };
}

/**
 * (#7106 lever P) The `String` borrow off the ambient `String`: no local of
 * that name in `locals`, and `isAmbient` (the caller's view of the global
 * binding) takes the root for the realm's constructor. (#7106 lever SR) A
 * method called on a fresh `new String(v)` is the same borrow.
 */
export function ambientStringPrototypeBorrow(
  expr: ts.CallExpression,
  locals: { has(name: string): boolean },
  isAmbient: (root: ts.Identifier) => boolean,
): PrototypeBorrowCall | undefined {
  if (locals.has("String")) return undefined;
  const borrow = matchPrototypeBorrowCall(expr, "String") ?? matchStringWrapperMethodCall(expr);
  return borrow !== undefined && isAmbient(borrow.root) ? borrow : undefined;
}

/** The `Array` borrow, for a (method, arity) the wrapper symbol can name. */
export function matchArrayPrototypeBorrowCall(expr: ts.CallExpression): PrototypeBorrowCall | undefined {
  const borrow = matchPrototypeBorrowCall(expr, "Array");
  return borrow && irWrapperSymbolIsNameable(borrow.method, borrow.args.length) ? borrow : undefined;
}

export function irArrayPrototypeBorrowHelperName(method: string, arity: number): string {
  return irWrapperSymbol(IR_ARRAY_BORROW_PREFIX, method, arity);
}

/** Inverse of {@link irArrayPrototypeBorrowHelperName}; undefined for any other symbol. */
export function parseIrArrayPrototypeBorrowHelperName(
  symbol: string,
): { readonly method: string; readonly arity: number } | undefined {
  return parseIrWrapperSymbol(IR_ARRAY_BORROW_PREFIX, symbol);
}
