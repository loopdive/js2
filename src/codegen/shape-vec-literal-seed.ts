// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491, wave-5 T5) The module-global array-carrier SEED.
 *
 * `applyShapeInference` (declarations/object-shape-widening.ts) retypes a
 * module global to a concrete vec struct when `collectShapes` sees BOTH a
 * numeric-index write and a `length` write on it — the `var obj: any = {};
 * obj.length = 3; obj[0] = 10;` array-like idiom. The declaration site then
 * seeded that global with an EMPTY vec (`{length: 0, data:
 * array.new_default(4)}`) and, critically, **`continue`d without compiling the
 * declaration's initializer at all.**
 *
 * That is correct only when the initializer carries no element data. For the
 * ES5 spelling
 *
 * ```js
 * var x = [0, 1, 2];
 * x[4294967294] = 4294967294;   // numeric-index write  → hasNumericIndexing
 * x.length = 2;                 // named "length" write → fields.has("length")
 * ```
 *
 * the same two writes classify `x` as array-like, so `[0, 1, 2]` was silently
 * discarded and EVERY element read answered the `array.new_default` zero —
 * including reads that appear textually BEFORE the two writes. Measured on
 * `7dd91b7bad`, `--target standalone`: `x[1]` answered `0` (and `undefined`/NaN
 * when read into an f64 slot) instead of `1`. Either write alone is correct,
 * and the same code inside a function expression is correct, because neither
 * shape (a) reaches `collectShapes`, which walks module scope only, nor
 * (b) satisfies the two-signal array-like filter.
 *
 * The seed now carries the literal's elements. `compileArrayLiteral`'s
 * `forcedElementType` parameter re-keys the literal to the shape's own element
 * type, so `getOrRegisterVecType` hands back the SAME `vecTypeIdx` the global
 * was retyped to — the seed cannot disagree with the global's declared type.
 *
 * Deliberately NOT seeded (kept on the empty-vec path, byte-identical):
 * spreads and elisions in the initializer. A spread needs the runtime
 * concat/grow machinery rather than a constant seed, and an elision is a HOLE
 * whose faithful representation is the f64-hole value-representation wall
 * (`$Hole` is externref-only) — fabricating a `0` there would trade one wrong
 * answer for another. Both stay as measured non-attempts.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileArrayLiteral } from "./literals.js";
import { coerceType } from "./type-coercion.js";

export interface ShapeVecInfo {
  vecTypeIdx: number;
  arrTypeIdx: number;
  elemType: ValType;
}

/**
 * True when the shape-inferred seed can carry `init`'s elements instead of
 * throwing them away: a non-empty array literal with no spread and no elision.
 */
function isSeedableArrayLiteral(init: ts.Expression): init is ts.ArrayLiteralExpression {
  return (
    ts.isArrayLiteralExpression(init) &&
    init.elements.length > 0 &&
    !init.elements.some((el) => ts.isSpreadElement(el) || ts.isOmittedExpression(el))
  );
}

/**
 * Emit the initial value for a shape-inferred array-like module global, leaving
 * exactly one `(ref null shape.vecTypeIdx)` on the stack.
 */
export function emitShapeInferredVecInit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  shape: ShapeVecInfo,
  init: ts.Expression,
): void {
  if (isSeedableArrayLiteral(init)) {
    const produced = compileArrayLiteral(ctx, fctx, init, shape.elemType);
    if (produced !== null) {
      // `forcedElementType` routes the literal through the shape's own vec type,
      // so this coercion is a no-op in the expected case and a safety net if a
      // contextual-tuple arm ever answered something else.
      coerceType(ctx, fctx, produced, { kind: "ref_null", typeIdx: shape.vecTypeIdx });
      return;
    }
    // compileArrayLiteral reported an error; fall through to the empty seed so
    // the global still gets a well-typed value.
  }

  // Empty vec struct: `{length: 0, data: array.new_default(4)}` — the original
  // `var obj: any = {}` seed, unchanged.
  fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
  fctx.body.push({ op: "i32.const", value: 4 }); // initial capacity
  fctx.body.push({ op: "array.new_default", typeIdx: shape.arrTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: shape.vecTypeIdx });
}
