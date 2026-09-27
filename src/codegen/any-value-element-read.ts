// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 G3) The unproven element read of an array whose elements are tagged
 * `$AnyValue` boxes — the carrier a mixed-kind literal such as `[0, 'a']`
 * (checker type `(string | number)[]`) gets in the standalone lane.
 *
 * The generic reference-element OOB read (`emitReferenceArrayUndefinedOobGet`
 * in property-access.ts) widens to externref because a typed struct slot
 * cannot encode `undefined`, and converts the present element with a bare
 * `extern.convert_any`. For an `$AnyValue` element that hands the BOX itself
 * to the externref plane as if it were the JS value. Readers that re-box an
 * externref (a `var w = a[0]` binding typed `string | number` is an
 * `$AnyValue` local) do not recognise a non-undefined box and wrap it again as
 * tag 5 — the #1888 "string" wrap — so `typeof w` answered "string" and
 * `w === 0` false for the NUMBER 0, while `typeof a[0]` (no re-box) was right.
 *
 * `$AnyValue` needs no widening: its tag-1 `$undefined` singleton already
 * encodes `undefined`. So this read keeps the element's own representation —
 * the box `#6631` built with the element's honest tag at construction — and
 * answers the singleton for an out-of-range index or an empty (null) slot,
 * exactly the two cases the externref read maps to `undefined`. Every consumer
 * then converts through the ordinary `$AnyValue` coercions (`__any_to_extern`,
 * `__any_to_f64`, …), which project by tag.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyValueType, isAnyValue, undefinedSingletonActive } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * Emit the read when it applies, returning the result type; `undefined`
 * (emitting nothing) when it does not — the caller keeps its externref widen.
 *
 * Stack in:  [arrayref (non-null), i32 index]
 * Stack out: [ref_null $AnyValue]
 */
export function tryEmitAnyValueArrayUndefinedOobGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  lengthBoundInstrs?: Instr[],
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi) || !isAnyValue(elementType, ctx) || !undefinedSingletonActive(ctx)) {
    return undefined;
  }
  if (ctx.undefinedGlobalIdx === undefined) ensureAnyValueType(ctx);
  const undefIdx = ctx.undefinedGlobalIdx;
  if (undefIdx === undefined) return undefined;
  const resultType: ValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };

  const idxLocal = allocLocal(fctx, `__oobav_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__oobav_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const valueLocal = allocLocal(fctx, `__oobav_value_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: idxLocal });
  fctx.body.push({ op: "local.set", index: arrLocal });

  fctx.body.push({ op: "local.get", index: idxLocal });
  if (lengthBoundInstrs) {
    fctx.body.push(...lengthBoundInstrs.map((instr) => ({ ...instr })));
  } else {
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "array.len" });
  }
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: [
      { op: "local.get", index: arrLocal },
      { op: "local.get", index: idxLocal },
      { op: "array.get", typeIdx: arrTypeIdx },
      { op: "local.tee", index: valueLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: [{ op: "global.get", index: undefIdx }],
        else: [{ op: "local.get", index: valueLocal }],
      },
    ],
    else: [{ op: "global.get", index: undefIdx }],
  });
  return resultType;
}
