import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coercionInstrs } from "./type-coercion.js";
import { valTypesMatch } from "./shared.js";

/**
 * The read of one name-matched alternate shape in an inlined property-access
 * dispatch chain: `ref.cast` the receiver to that shape, `struct.get` its
 * field, coerce to the read's result type.
 *
 * Returns `null` when the alternate cannot produce `resultType` at all, and
 * the caller should skip the arm.
 *
 * Why skipping is right: `findAlternateStructsForField` enumerates candidates
 * by field NAME, so it deliberately over-approximates — two unrelated shapes
 * can share a property name and hold different types under it. `coercionInstrs`
 * answers `[]` both for "no coercion needed" and for "cannot bridge this pair",
 * so an unbridgeable arm used to emit a bare `struct.get` feeding a local of
 * the wrong type: invalid wasm the emitter produces happily and only the engine
 * rejects —
 *
 *   __closure_21: local.set[0] expected type (ref null 6),
 *                 found struct.get of type i32
 *
 * which is acorn's `Parser`, where `reservedWords[...]` (a string read) matched
 * `defaultOptions` on name and found an i32 field. A shape that cannot yield
 * the result type is not a candidate for this read, so the chain should fall
 * through to the generic path instead.
 */
export function alternateFieldArmRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  alt: { structTypeIdx: number; fieldIdx: number; fieldType: ValType },
  resultType: ValType,
  sourceLocal: number,
): Instr[] | null {
  const coerce = coercionInstrs(ctx, alt.fieldType, resultType, fctx);
  if (coerce.length === 0 && !valTypesMatch(alt.fieldType, resultType)) return null;

  return [
    { op: "local.get", index: sourceLocal },
    { op: "ref.cast", typeIdx: alt.structTypeIdx },
    { op: "struct.get", typeIdx: alt.structTypeIdx, fieldIdx: alt.fieldIdx },
    ...coerce,
  ];
}
