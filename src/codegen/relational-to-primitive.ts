// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §7.2.12 IsLessThan step 1 — `px = ToPrimitive(x, NUMBER)` — for the
 * standalone abstract-relational cascade, plus the predicate that decides
 * which operands belong on that cascade at all.
 *
 * ## The defect, in two halves
 *
 * **(a) An object-TYPED operand never reached the cascade.** Its gate admits
 * only statically `any`/`unknown` operands AND requires `anyValueTypeIdx < 0`.
 * In standalone that index is always >= 0, so the gate is shut outright and the
 * comparison is lowered inline as `ToNumber(l) f64.<op> ToNumber(r)`. An object
 * unboxes to NaN there, and every f64 comparison against NaN is `false`:
 *
 * ```js
 * var f = function () { return 1; }, o = {};
 * f >= f;      // false — must be true
 * o <= o;      // false — must be true
 * f >= o;      // false — must be true ("function…" > "[object Object]")
 * ```
 *
 * The exclusion's stated reason — "the AnyValue helpers own that ABI" — does
 * not hold for this shape: `__any_lt`/`__any_ge` are not even emitted for these
 * programs (verified on the module for `f >= o`). So the gate was closed in
 * favour of a path that does not run.
 *
 * **(b) The cascade itself chose its arm from the RAW operands**
 * (`__typeof_string(l) && __typeof_string(r)`), so even once an object reached
 * it, it would take the numeric arm and unbox to NaN again. Both halves are
 * needed; either alone changes nothing.
 *
 * Half the truth table looked right by luck — `o >= f` and `f < o` genuinely
 * ARE `false` — so spot-checking the wrong pairs finds nothing. The tell is
 * that `x >= y` was not `!(x < y)`, and that `f + ""` produced the correct
 * string all along, because the §13.15.3 `+` path already reduces to primitives
 * before ITS string-vs-numeric test. Only the relational path tested raw
 * operands. Measured over a 180-cell {function, object, array, Date, number,
 * string} × {`<`,`<=`,`>`,`>=`,`+`} matrix: **64 cells wrong in standalone, 0
 * wrong in the js-host lane.**
 *
 * ## Why widening the gate is safe HERE and was not in #1374
 *
 * `binary-ops.ts` records that #1374 widened this same gate to non-numeric
 * operands and caused **14 runtime_error regressions**: it routed object
 * relationals to the HOST comparator, and host `<` throws on an opaque WasmGC
 * struct. That hazard belongs to the js-host lane. `admitsObjectRelational`
 * therefore widens **only when there is no JS host**, where the cascade is
 * entirely in-module (`__to_primitive`, `__typeof_string`, `__str_compare`,
 * `__unbox_number`) and no host operator ever sees a struct. The js-host lane
 * keeps its existing path byte-for-byte — and, being already correct on all
 * 180 cells, is the regression guard for this change.
 *
 * ## Hint
 *
 * NUMBER, not default — §7.2.12 says so, and it is observable on a `Date`,
 * where the default hint would take `toString` and make two Dates compare as
 * strings instead of by time value.
 */
import { ts } from "../ts-api.js";
import { runtimeToPrimitiveInstrs } from "./coercion-engine.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** Operand types the cascade must not take — it has no i64 arm. */
export const TO_PRIMITIVE_EXCLUDED_FLAGS =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral;
const EXCLUDED = TO_PRIMITIVE_EXCLUDED_FLAGS;

/**
 * Is this operand type an ordinary OBJECT — something §7.2.12 must reduce with
 * ToPrimitive before comparing? A union qualifies only when every constituent
 * does, so `number | {}` keeps its existing numeric lowering.
 *
 * (#4491 T4) Exported so the §13.15.3 `+` twin (`add-to-primitive.ts`) asks the
 * SAME question the relational cascade asks — the two operators share one
 * "this operand needs ToPrimitive first" notion, and forking it is how the two
 * paths drift out of agreement.
 */
export function isObjectOperandType(t: ts.Type): boolean {
  const parts = t.isUnion() ? t.types : [t];
  if (parts.length === 0) return false;
  for (const p of parts) {
    if ((p.flags & EXCLUDED) !== 0) return false;
    if ((p.flags & ts.TypeFlags.Object) === 0) return false;
  }
  return true;
}

/** Should a relational with these operand types take the standalone cascade? */
export function admitsObjectRelational(ctx: CodegenContext, left: ts.Type, right: ts.Type): boolean {
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  if ((left.flags & EXCLUDED) !== 0 || (right.flags & EXCLUDED) !== 0) return false;
  return isObjectOperandType(left) || isObjectOperandType(right);
}

const ANYISH = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/**
 * (#6999) A `string | number`-style union: a String constituent alongside a
 * non-String primitive one. Its runtime value may be a string, so §7.2.13's
 * both-strings lexicographic arm is reachable and the numeric lowering is wrong.
 */
function isStringMixedPrimitiveUnion(t: ts.Type): boolean {
  if (!t.isUnion()) return false;
  const parts = t.types;
  const hasString = parts.some((p) => (p.flags & ts.TypeFlags.StringLike) !== 0);
  const hasOther = parts.some((p) => (p.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0);
  return hasString && hasOther && parts.every((p) => (p.flags & EXCLUDED) === 0);
}

/**
 * Should a relational with these operand types take the runtime-dispatched
 * `emitAnyRelational` (§7.2.13: both strings → lexicographic, else numeric)?
 *
 * - js-host lane: an `any`/`unknown` operand, and only while `$AnyValue` is not
 *   registered (#2059; the #1374 host-comparator hazard) — unchanged bytes.
 * - no JS host (#6999): that `anyValueTypeIdx < 0` exclusion shut the arm for
 *   good, because standalone always registers `$AnyValue`, so `"b" > "a"` on
 *   `any` compared NaN to NaN. The in-module cascade has no host comparator, so
 *   the arm opens for `any`/`unknown` and for string-mixed unions
 *   (`string | number`) as well.
 */
export function admitsAnyRelational(ctx: CodegenContext, left: ts.Type, right: ts.Type): boolean {
  const anyish = (left.flags & ANYISH) !== 0 || (right.flags & ANYISH) !== 0;
  if (ctx.anyValueTypeIdx < 0 && anyish) return true;
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  return anyish || isStringMixedPrimitiveUnion(left) || isStringMixedPrimitiveUnion(right);
}

/**
 * Reduce the two externref operand temps in place. A no-op when the native
 * `__to_primitive` is unavailable (older minimal standalone builds), so the
 * caller degrades to its previous raw-operand dispatch rather than failing.
 */
export function reduceRelationalOperandsToPrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  lTmp: number,
  rTmp: number,
): void {
  for (const tmp of [lTmp, rTmp]) {
    const toPrimitiveInstrs = runtimeToPrimitiveInstrs(ctx, "number");
    if (toPrimitiveInstrs === null) return;
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push(...toPrimitiveInstrs);
    fctx.body.push({ op: "local.set", index: tmp });
  }
}
