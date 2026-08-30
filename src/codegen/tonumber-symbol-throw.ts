// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4556) ToNumber(Symbol) must throw a TypeError — §7.1.4 step 5.
 *
 * Symbols lower to i32 ids, so ANY builtin that coerces an argument with an
 * `{kind:"f64"}` hint silently leaks the raw id as a number instead of
 * throwing. `Math.*` already carried this guard inline; the Date setters did
 * not, so `new Date(0).setYear(Symbol())` quietly produced year 101
 * (annexB/built-ins/Date/prototype/setYear/year-to-number-err.js). Extracted
 * here so a third site cannot forget it.
 *
 * Evaluation order is preserved: every argument up to and including the symbol
 * one is compiled (and dropped) before the throw, per §13.3.6.1
 * ArgumentListEvaluation.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./js-errors.js";
import { compileExpression } from "./shared.js";

/**
 * Emit the throw when any argument is STATICALLY a symbol, and report it by
 * returning `result`; otherwise return `undefined` and emit nothing, so the
 * caller proceeds with its untouched lowering.
 */
export function emitSymbolArgToNumberThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  result: ValType,
): ValType | undefined {
  const symbolArgIdx = args.findIndex((a) => ctx.oracle.staticJsTypeOf(a) === "symbol");
  if (symbolArgIdx < 0) return undefined;
  for (let i = 0; i <= symbolArgIdx; i++) {
    const t = compileExpression(ctx, fctx, args[i]!);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  return result;
}

/** Which abstract operation is about to consume the operand. */
export type SymbolCoercionTarget = "number" | "string";

/**
 * (#3481 step 2) The SINGLE-OPERAND form of the guard above.
 *
 * `emitSymbolArgToNumberThrow` owns a whole argument list, which only fits a
 * site that has not compiled anything yet. The ToIndex / ToString argument
 * slots this issue is about sit in the MIDDLE of a lowering that has already
 * evaluated (and stashed) the earlier operands — `new DataView(buffer,
 * byteOffset)` has `buffer` in a local by the time `byteOffset` is coerced —
 * so the caller, not this helper, owns §13.3.6.1 order for the operands
 * before this one. This helper evaluates ONLY its own operand (so its side
 * effects still happen, e.g. `new ArrayBuffer(f())` where `f` returns a
 * symbol) and then throws.
 *
 * Returns true when the throw was emitted, in which case everything the
 * caller would emit next is unreachable and it should return its own result
 * ValType without pushing a value — the same contract
 * `emitStringWrapperValue` (new-builtin-globals.ts) already uses.
 *
 * Only fires when the operand is STATICALLY a symbol. That is exactly the
 * hole: a symbol lowers to a bare `i32` id, so `coerceType(i32 → f64)` is a
 * silent `f64.convert_i32_s` of the id and `ToIndex` then sees an ordinary
 * small integer. A DYNAMIC symbol (one that reached the site as an
 * `externref`) is already handled at runtime by `__unbox_number`, whose
 * object arm runs ToPrimitive and lets `Number(prim)`'s TypeError propagate.
 */
export function emitSymbolOperandCoercionThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  target: SymbolCoercionTarget,
  /**
   * Expressions the spec evaluates BEFORE this operand's coercion and that the
   * caller has not emitted yet — e.g. the receiver of `arr.at(sym)`, whose
   * lowering evaluates it inside the arm we are about to skip. Each is
   * compiled and dropped, in order, so `f().at(sym)` still calls `f()`.
   */
  before?: readonly ts.Expression[],
): boolean {
  if (ctx.oracle.staticJsTypeOf(operand) !== "symbol") return false;
  for (const e of before ?? []) {
    const bt = compileExpression(ctx, fctx, e);
    if (bt !== null) fctx.body.push({ op: "drop" });
  }
  const t = compileExpression(ctx, fctx, operand);
  if (t !== null) fctx.body.push({ op: "drop" });
  emitThrowTypeError(
    ctx,
    fctx,
    target === "number" ? "Cannot convert a Symbol value to a number" : "Cannot convert a Symbol value to a string",
  );
  return true;
}
