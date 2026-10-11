// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";

/** Full Number(value), including observable ToPrimitive(number), Symbol error
 * and BigInt conversion. This must never alias primitive numeric unboxing.
 * Represent it as a call so optimization retains arbitrary user effects.
 */
const DECLARATION: IrRuntimeCallableDeclaration = Object.freeze({
  feature: "js.number.from-value",
  ref: irIntrinsicFuncRef("js.number.from-value"),
  params: Object.freeze([Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "externref" as const }) })]),
  results: Object.freeze([Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "f64" as const }) })]),
});
export function irNumberConversionCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  return ref.binding.kind === "intrinsic" && ref.binding.symbol === "js.number.from-value" ? DECLARATION : undefined;
}
