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
 *
 * **"undefined" is absent, and that is load-bearing.** A HOLE in an f64 vec
 * reads as NaN, and `undefined` coerces to f64 NaN too, so the existing
 * both-NaN arm of the SameValueZero comparison is what makes
 * `[, , , 42, , ].includes(undefined)` answer true (test262 `includes/sparse.js`,
 * §23.1.3.16 step 7a — holes are read with Get, which returns undefined).
 * Listing "undefined" here forces that comparison false and breaks the row.
 * The encoding is imprecise in the other direction — `[NaN].includes(undefined)`
 * wrongly answers true — but that is pre-existing, orthogonal, and not what this
 * predicate is for.
 */
const NEVER_A_NUMBER = new Set(["string", "boolean", "bigint", "symbol", "object", "function"]);

/**
 * Emit the `searchElement` operand for `Array.prototype.includes` into `valTmp`.
 *
 * §23.1.3.16 takes `searchElement` as an ordinary parameter, so the zero-argument
 * form is legal and searches for `undefined`. Rejecting it (as this used to) made
 * the whole call compile to nothing and evaluate as `undefined` — exactly what
 * test262's `includes/no-arg.js` and `includes/length-zero-returns-false.js`
 * report as "Expected SameValue(«undefined», «false»)".
 *
 * The absent argument is emitted as whatever an explicit `undefined` would
 * produce for this element type, so the two spellings cannot disagree: the
 * externref vec gets a real `undefined` (SameValueZero matches a hole read as
 * undefined), and the f64 vec gets NaN (which matches a hole, per the note on
 * NEVER_A_NUMBER above). Any other element type can hold no value that is
 * `undefined`, so the caller must force the comparison false — this returns
 * `true` to say so. That is load-bearing: leaving `valTmp` at its zero default
 * would compare against `0` and make `[0].includes()` wrongly answer true.
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
  if (valType.kind === "externref") {
    emitUndefined(ctx, fctx);
  } else if (valType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: Number.NaN });
  } else {
    return true;
  }
  fctx.body.push({ op: "local.set", index: valTmp });
  return false;
}

/**
 * Emit the ABSENT `searchElement` for `Array.prototype.indexOf` / `lastIndexOf`
 * into `valTmp`.
 *
 * §23.1.3.13 / §23.1.3.20 take `searchElement` as an ordinary parameter, so the
 * zero-argument form is legal and searches for `undefined` — but with STRICT
 * EQUALITY (§7.2.16), not `includes`'s SameValueZero. That one difference is why
 * this is a sibling of {@link emitIncludesSearchValue} rather than a call to it:
 *
 * - **externref vec** — a real `undefined`, so an element that IS `undefined`
 *   (or a hole mapped to one) matches: `["x",undefined,"z"].indexOf()` is `1`.
 * - **f64 vec** — `undefined` in f64 context is NaN, exactly what the explicit
 *   `indexOf(undefined)` spelling already emits, and `f64.eq` is false when
 *   either side is NaN. The scan therefore runs and finds nothing, which is
 *   right for `[10,20,30]`. `includes` resolves this the OTHER way (its
 *   SameValueZero arm deliberately makes NaN match NaN, which is how it finds a
 *   hole) — copying that here would wrongly match `[NaN].indexOf()`.
 * - **any other element type** (i32 elements, native-string / object refs) — no
 *   value of that type is `undefined`, so nothing can match. Returning `true`
 *   says so and the caller answers -1 without scanning. That return is
 *   load-bearing: leaving `valTmp` at its zero default would compare against
 *   `0` and make `[false, true].indexOf()` answer `0` instead of `-1`.
 *
 * @returns true when no element can match, i.e. the result is -1 with no scan.
 */
export function emitIndexOfAbsentSearchValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valType: ValType,
  valTmp: number,
): boolean {
  if (valType.kind === "externref") {
    emitUndefined(ctx, fctx);
  } else if (valType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: Number.NaN });
  } else {
    return true;
  }
  fctx.body.push({ op: "local.set", index: valTmp });
  return false;
}
