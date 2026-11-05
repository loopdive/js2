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

const IR_ARRAY_BORROW_PREFIX = "__ir_arr_borrow_";

export interface ArrayPrototypeBorrowCall {
  /** The `Array` identifier — callers settle shadowing and ambient-ness. */
  readonly root: ts.Identifier;
  readonly method: string;
  /** The borrowed receiver: `.call`'s first argument. */
  readonly receiver: ts.Expression;
  /** `.call`'s remaining arguments; their count is the wrapper's arity. */
  readonly args: readonly ts.Expression[];
}

/**
 * Match the exact `Array.prototype.<m>.call(recv, …args)` shape: a `.call`
 * on a `.prototype.<m>` read off the identifier `Array`, at least the receiver
 * argument, no spread, a nameable (method, arity). Pure syntax — no scope,
 * ambient or lane question is answered here.
 */
export function matchArrayPrototypeBorrowCall(expr: ts.CallExpression): ArrayPrototypeBorrowCall | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "call") return undefined;
  const methodAccess = callee.expression;
  if (!ts.isPropertyAccessExpression(methodAccess) || !ts.isIdentifier(methodAccess.name)) return undefined;
  const proto = methodAccess.expression;
  if (!ts.isPropertyAccessExpression(proto) || proto.name.text !== "prototype") return undefined;
  const root = proto.expression;
  if (!ts.isIdentifier(root) || root.text !== "Array") return undefined;
  const [receiver, ...args] = expr.arguments;
  if (receiver === undefined || expr.arguments.some(ts.isSpreadElement)) return undefined;
  const method = methodAccess.name.text;
  if (!irWrapperSymbolIsNameable(method, args.length)) return undefined;
  return { root, method, receiver, args };
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
