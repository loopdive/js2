import type ts from "typescript";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";
import { emitUndefined } from "./expressions/late-imports.js";

/**
 * Can a value with this static `typeof` tag ever BE an element of a numeric
 * (i32/f64) element vec? SameValueZero (§7.2.12) compares Type(x) first, so a
 * search value of any other tag can never match — no matter what it coerces to.
 *
 * "number" and "mixed" are absent deliberately: both may match, so they take the
 * ordinary compile-into-`valTmp` path.
 */
const NEVER_A_NUMBER = new Set(["string", "boolean", "bigint", "symbol", "undefined", "object", "function"]);

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
  const searchArg = callExpr.arguments[0];
  if (searchArg !== undefined) {
    // §7.2.12 SameValueZero compares Type(x) BEFORE value, so a search value
    // that is statically not a number can never equal an element of a numeric
    // vec. Compiling it into `valType` anyway would COERCE it — that is how
    // `[42, 0, 1, NaN].includes("42")` answered true (test262
    // `includes/samevaluezero.js`): "42" became f64 42 and matched. The
    // argument is still evaluated (it may have side effects) and dropped.
    if (
      (valType.kind === "f64" || valType.kind === "i32") &&
      NEVER_A_NUMBER.has(ctx.oracle.staticJsTypeOf(searchArg))
    ) {
      if (compileExpression(ctx, fctx, searchArg) !== null) fctx.body.push({ op: "drop" });
      return true;
    }
    compileExpression(ctx, fctx, searchArg, valType);
    fctx.body.push({ op: "local.set", index: valTmp });
    return false;
  }
  if (valType.kind !== "externref") return true;
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.set", index: valTmp });
  return false;
}
