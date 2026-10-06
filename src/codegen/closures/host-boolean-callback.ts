// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6417) The RESULT of a host-invoked callback (`__cb_<id>`) whose TS type is
 * `boolean`.
 *
 * The JS-host lane lowers `boolean` to an i32, and a host caller receives that
 * i32 as the JS number `1`/`0`. Most host consumers only test truthiness, but
 * not all: Node's `assert.throws(fn, validator)` requires the validator to
 * return literally `true` and threw "The validation function is expected to
 * return "true". Received 1" for axios' `(err) => err.code === 'ERR_INVALID_URL'`
 * (fromDataURI, transformResponse). Such a callback therefore declares an
 * `externref` result and boxes its boolean through `__box_boolean`.
 *
 * Host lane only: on standalone/WASI the callback bridge is native and the i32
 * never crosses a JS boundary.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/** The boolean-branded i32 `coerceType` boxes through `__box_boolean`. */
export const BOOLEAN_I32: ValType = { kind: "i32", boolean: true };

/** True when a host callback lowered to an i32 result is really a `boolean`. */
export function hostBooleanCallbackResult(ctx: CodegenContext, retType: ts.Type, resolved: ValType | null): boolean {
  if (resolved?.kind !== "i32" || ctx.standalone || ctx.wasi) return false;
  const flags = retType.flags;
  return (flags & ts.TypeFlags.BooleanLike) !== 0 && (flags & ~(ts.TypeFlags.BooleanLike | ts.TypeFlags.Union)) === 0;
}

/**
 * True when an expression-bodied callback's i32 result must box as a boolean
 * into its `externref` result: the callback was widened above, or its declared
 * result was already `externref` (`(err): any => a === b`) and the body is a
 * boolean expression.
 */
export function callbackBodyBoxesBoolean(
  ctx: CodegenContext,
  exprType: ValType,
  resultType: ValType,
  hostBooleanResult: boolean,
  body: ts.Expression,
): boolean {
  if (exprType.kind !== "i32" || resultType.kind !== "externref") return false;
  return hostBooleanResult || ctx.oracle.isBooleanProducing(body);
}
