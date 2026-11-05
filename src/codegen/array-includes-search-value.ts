import type ts from "typescript";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { emitThrowTypeError } from "./js-errors.js";
import { coerceType } from "./shared.js";

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
  } else if (valType.kind === "ref_null" && ctx.nativeStrings && valType.typeIdx === ctx.anyStrTypeIdx) {
    fctx.body.push({ op: "ref.null", typeIdx: valType.typeIdx });
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
 * - **native-string vec** (`(string | undefined)[]` under the native regime,
 *   #6982) — `undefined` is the null `AnyString` carrier, which is exactly what
 *   the explicit `indexOf(undefined)` spelling compiles to, so the absent form
 *   searches the same `ref.null`: `["x",undefined,"z"].indexOf()` is `1`. (The
 *   carrier does not tell `undefined` from `null` — shared with the explicit
 *   spelling, so the two cannot disagree.)
 * - **any other element type** (i32 elements, object refs) — no
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
  } else if (valType.kind === "ref_null" && ctx.nativeStrings && valType.typeIdx === ctx.anyStrTypeIdx) {
    fctx.body.push({ op: "ref.null", typeIdx: valType.typeIdx });
  } else {
    return true;
  }
  fctx.body.push({ op: "local.set", index: valTmp });
  return false;
}

/** `typeof` tags whose ToNumber can neither run user code nor throw. */
const INERT_TO_NUMBER = new Set(["number", "string", "boolean", "undefined"]);

/**
 * (#4765) Evaluate the `fromIndex` argument of an inlined `includes` /
 * `indexOf` / `lastIndexOf` NOW, and return an emitter that pushes its i32
 * ToIntegerOrInfinity LATER — the caller runs it inside its `len != 0` arm.
 *
 * The spec separates the two. The argument expression is evaluated with the
 * call, like any argument; ToIntegerOrInfinity(fromIndex) is step 4 (§23.1.3.16
 * / .17 / .20), after step 3 has already returned for `len = 0`. That ToNumber
 * is observable — a user `valueOf`/`toString` runs, a Symbol or BigInt throws —
 * which is what test262 `includes/length-zero-returns-false.js` counts. The
 * inlined lowerings each got one half wrong: `includes` converted eagerly (its
 * `valueOf` ran on `[]`), while `indexOf`/`lastIndexOf` moved the whole
 * expression under the guard (so `[].indexOf(0, f())` never called `f`).
 *
 * A primitive-typed argument has an unobservable ToNumber, so it converts
 * eagerly and only the i32 is deferred; `tag` names the temp locals.
 */
export function evalSearchFromIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  tag: string,
): () => void {
  const I32: ValType = { kind: "i32" };
  const jsType = ctx.oracle.staticJsTypeOf(arg);
  // A symbol lowers to a bare i32 id, which a numeric coercion would read as an
  // ordinary index (#3481): evaluate it, and make the deferred step the throw.
  if (jsType === "symbol") {
    if (compileExpression(ctx, fctx, arg) !== null) fctx.body.push({ op: "drop" });
    return () => emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  }
  if (INERT_TO_NUMBER.has(jsType)) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, arg, I32);
    } else {
      compileExpression(ctx, fctx, arg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    const fromTmp = allocLocal(fctx, `__${tag}_from_${fctx.locals.length}`, I32);
    fctx.body.push({ op: "local.set", index: fromTmp });
    return () => fctx.body.push({ op: "local.get", index: fromTmp });
  }
  const argType = compileExpression(ctx, fctx, arg);
  // A void-valued argument is `undefined`, whose ToIntegerOrInfinity is 0.
  if (argType === null) return () => fctx.body.push({ op: "i32.const", value: 0 });
  const argTmp = allocLocal(fctx, `__${tag}_fromarg_${fctx.locals.length}`, argType);
  fctx.body.push({ op: "local.set", index: argTmp });
  return () => {
    fctx.body.push({ op: "local.get", index: argTmp });
    coerceType(ctx, fctx, argType, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  };
}

/**
 * Set `startLocal` to the forward-search start of `includes` / `indexOf`:
 * `k = ToIntegerOrInfinity(fromIndex)`, then `max(len + k, 0)` when negative
 * (§23.1.3.16 / .17 steps 4–9). The conversion runs only when `len != 0`; an
 * empty receiver gets 0, which the caller's scan bound turns into "not found".
 */
export function emitForwardSearchStart(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromArg: ts.Expression,
  lenLocal: number,
  startLocal: number,
  tag: string,
): void {
  const emitFromI32 = evalSearchFromIndex(ctx, fctx, fromArg, tag);
  // Emitted into the live body, then spliced under the guard: nested arms are
  // walked by flushLateImportShifts, so a late import the conversion adds still
  // shifts these indices.
  const guardStart = fctx.body.length;
  emitFromI32();
  fctx.body.push(
    { op: "local.tee", index: startLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenLocal },
        { op: "local.get", index: startLocal },
        { op: "i32.add" },
        { op: "local.tee", index: startLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: startLocal },
          ],
        },
      ],
    },
  );
  const guarded = fctx.body.splice(guardStart);
  fctx.body.push(
    { op: "local.get", index: lenLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: guarded,
      else: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: startLocal },
      ],
    },
  );
}
