// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4427) Lane selection + operand bridging for native-string `+=`.
//
// Two decisions that `compileCompoundAssignment` / the native-string compound
// path used to make inline, both of which were wrong in the standalone
// (nativeStrings) lane:
//
//   1. WHICH lane `x += y` takes when only the RHS is statically a string.
//   2. HOW a boolean RHS lands as the `ref $AnyString` the concat boundary
//      wants, given `emitBoolToString` is dual-lane.
//
// Both live here so the decision is stated once and the god-file driver keeps
// only the call.
import ts from "typescript";

import { isStringType } from "../checker/type-mapper.js";
import type { ValType } from "../ir/types.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { slotNeedsExternrefBridge } from "./native-string-slot-bridge.js";
import { localGlobalIdx } from "./registry/imports.js";
import { emitBoolToString } from "./string-ops.js";

/**
 * The physical ValType of the slot a compound assignment writes back into —
 * local, captured global, or module global, in the same precedence order
 * `compileNativeStringCompoundAssignment` resolves them. `undefined` when the
 * name has no slot in any of the three (the graceful-fallback case).
 */
export function compoundSlotValType(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | undefined {
  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) return getLocalType(fctx, localIdx);
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) return ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)]?.type;
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) return ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)]?.type;
  return undefined;
}

/**
 * True when a statically String-typed RHS forces `name += rhs` into the string
 * concat lane even though the LHS is not statically a string.
 *
 * §13.15.3 defers to §13.5.3, whose step 3 concatenates as soon as EITHER
 * operand's ToPrimitive is a String. A statically String-typed RHS — string
 * primitive, string literal, or a `String` WRAPPER object, all of which
 * ToPrimitive to a string — settles that without knowing the LHS, so
 * `x = 1; x += "1"` is `"11"`, never `2`. The lane gate only ever consulted
 * the LHS, so a NARROWED non-string LHS (the checker types `x` as `number`
 * right after `x = 1`, even for a `var x` whose slot is externref) silently
 * took the numeric lane and ToNumber-coerced the string operand: test262
 * S11.13.2_A4.4_T2.6 CHECK#2 `2`, T2.7 CHECK#1 `2`, T2.8 `undefined`,
 * T2.9 `null`.
 *
 * Restricted to the case the concat lane can actually SERVE: a slot the
 * native-string bridge accepts. `slotNeedsExternrefBridge` is that exact test
 * (no JS host + externref slot), and its inbound half
 * (`emitExternrefSlotToAnyStr`, #3472) runs the §7.1.17 ToString walker on the
 * loaded value — so a number / boolean / undefined / null / wrapper sitting in
 * the slot stringifies instead of trapping. An f64/i32 slot cannot hold the
 * concat result at all, and the JS-host lane's js-string concat has no
 * ToString on the LHS, so both keep the numeric lane.
 */
export function rhsStringForcesConcatLane(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  rightTsType: ts.Type,
): boolean {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return false;
  if (!isStringType(rightTsType)) return false;
  return slotNeedsExternrefBridge(ctx, compoundSlotValType(ctx, fctx, name));
}

/**
 * Land `emitBoolToString`'s result as a non-null `ref $AnyString`.
 *
 * `emitBoolToString` is DUAL-LANE: the JS-host lane selects an externref
 * string-constant global, while the nativeStrings/standalone lane selects a
 * native `$AnyString` struct directly (string-ops.ts). Both native-string `+=`
 * coercion sites hard-coded the host lane's tail — `any.convert_extern` +
 * `ref.cast` — so in standalone the `if` producing a `(ref null $AnyString)`
 * was fed straight into `any.convert_extern`, whose operand must be an
 * externref. That is a MODULE-level validation failure, not a statement-level
 * one: `var x = "1"; x += true;` cost the whole file (test262
 * S11.13.2_A4.4_T2.7 family, and any `+=` chain containing it).
 *
 * Bridge on the type `emitBoolToString` actually reports instead. In the
 * native lane only nullability can differ from the `ref $AnyString` the
 * `__str_concat` / builder-append boundary requires, and `ref.as_non_null`
 * accepts a non-null operand too — so it is correct for both shapes that lane
 * can produce.
 */
export function emitBoolToAnyStr(ctx: CodegenContext, fctx: FunctionContext): void {
  const produced = emitBoolToString(ctx, fctx);
  if (produced.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return;
  }
  fctx.body.push({ op: "ref.as_non_null" });
}
