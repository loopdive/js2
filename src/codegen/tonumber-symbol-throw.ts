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
