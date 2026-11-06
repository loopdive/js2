// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7084) `o[k] += rhs` on a dynamic (externref) receiver, native-semantics lane.
 *
 * ```js
 * const escapeToBuffer = (str, buffer) => { buffer[0] += str; };   // hono utils/html
 * ```
 *
 * The externref element compound path read the current value, `__unbox_number`
 * -ed it, `f64.add`-ed the RHS and stored the boxed number back: `buffer[0]`
 * became NaN. JS `+` is §13.15.3 ApplyStringOrNumericBinaryOperator — it
 * concatenates when either primitive is a string — so `+=` on an element needs
 * the same runtime dispatch #3673 gave the property twin (`obj.p += rhs`):
 * `emitAnyAddFromExternTemps` (`__to_primitive` → string test → `__str_concat`
 * or `f64.add`). The receiver and the key were evaluated once by the caller
 * (§13.15.2: the LHS Reference is evaluated once); the current value is on the
 * stack. Every other compound operator stays numeric, as before.
 */
import type { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { emitAnyAddFromExternTemps } from "../binary-ops.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType, compileExpression } from "../shared.js";
import { isStrictContext } from "./assignment.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Current element value on the stack → `o[k] = current + rhs`; leaves the result. */
export function emitElementCompoundAnyAdd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  objLocal: number,
  keyLocal: number,
): ValType | null {
  const lTmp = allocLocal(fctx, `__cmpd_eadd_l_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: lTmp });
  const rhsType = compileExpression(ctx, fctx, rhs, EXTERNREF);
  if (!rhsType) return null;
  if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, EXTERNREF);
  const rTmp = allocLocal(fctx, `__cmpd_eadd_r_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: rTmp });
  const addType = emitAnyAddFromExternTemps(ctx, fctx, lTmp, rTmp);
  if (addType.kind !== "externref") coerceType(ctx, fctx, addType, EXTERNREF);
  const resLocal = allocLocal(fctx, `__cmpd_eadd_res_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: resLocal });
  // (#3430) A strict Reference throws when [[Set]] fails, as for plain `=`.
  const setName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(ctx, setName, [EXTERNREF, EXTERNREF, EXTERNREF], []);
  flushLateImportShifts(ctx, fctx);
  if (setIdx !== undefined) {
    fctx.body.push(
      { op: "local.get", index: objLocal },
      { op: "local.get", index: keyLocal },
      { op: "local.get", index: resLocal },
      { op: "call", funcIdx: setIdx },
    );
  }
  fctx.body.push({ op: "local.get", index: resLocal });
  return EXTERNREF;
}
