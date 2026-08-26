import type ts from "typescript";
import type { CodegenContext, FunctionContext, ValType } from "../types.js";
import { compileExpression } from "./expressions.js";
import { emitUndefined } from "./expressions/late-imports.js";

/**
 * Emit the `searchElement` operand for `Array.prototype.includes` into `valTmp`.
 *
 * §23.1.3.16 takes `searchElement` as an ordinary parameter, so the zero-argument
 * form is legal and searches for `undefined`. Rejecting it (as this used to) made
 * the whole call compile to nothing and evaluate as `undefined` — exactly what
 * test262's `includes/no-arg.js` and `includes/length-zero-returns-false.js`
 * report as "Expected SameValue(«undefined», «false»)".
 *
 * `undefined` is representable only in an externref element vec, where
 * SameValueZero can genuinely match a hole read as undefined (`[,].includes()` is
 * true). In a numeric or ref element vec no stored element can BE undefined, so
 * the caller must force the comparison false — this returns `true` to say so.
 * That is load-bearing: leaving `valTmp` at its zero default would compare
 * against f64 `0` and make `[0].includes()` wrongly answer true.
 *
 * @returns true when the scan comparison must be replaced by a constant 0.
 */
export function emitIncludesSearchValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  valType: ValType,
  valTmp: number,
): boolean {
  if (callExpr.arguments.length > 0) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, valType);
    fctx.body.push({ op: "local.set", index: valTmp });
    return false;
  }
  if (valType.kind !== "externref") return true;
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.set", index: valTmp });
  return false;
}
