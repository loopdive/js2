// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3358 — `%TypedArray%.prototype.set` bounds check, relocated out of the
 * `array-methods.ts` god-file (8k+ LOC, over the LOC-budget threshold — see
 * #3102/#3131). The bounds-check emission was added to `compileTypedArraySet`
 * by #3202 (OOB must throw a *catchable* RangeError, not an uncatchable Wasm
 * `oob` trap that escapes try/catch), which landed via a `loc-budget-allow`
 * escape hatch. This is the follow-up that moves those instructions into a
 * small single-purpose module so array-methods.ts shrinks back and the
 * allowance can be retired. Pure code motion — byte-identical emit.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/**
 * Emit the `%TypedArray%.prototype.set(src[, offset])` bounds check.
 *
 * Spec §23.2.3.24: the write must throw an observable, *catchable* `RangeError`
 * when `offset < 0` or `offset + srcLength > targetLength`, rather than letting
 * the subsequent `array.copy` / element-wise store `oob`-trap (an uncatchable
 * Wasm abort that escapes try/catch and poisons the whole test file —
 * #3202 / #3335 Part 1).
 *
 * The predicate is computed in i32: `offset + srcLen` for test-realistic
 * magnitudes never overflows, and a negative offset is caught by the `< 0` arm.
 * All three operands are pre-computed locals owned by `compileTypedArraySet`;
 * this helper only reads them, so the emitted instruction sequence is identical
 * to the inline version it replaced.
 *
 * @param offsetTmp  i32 local holding the (defaulted) destination offset
 * @param srcLen     i32 local holding the source length
 * @param dstLen     i32 local holding the destination (target) length
 */
export function emitTypedArraySetBoundsCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  offsetTmp: number,
  srcLen: number,
  dstLen: number,
): void {
  fctx.body.push(
    // predicate: offset < 0  ||  offset + srcLen > dstLen
    { op: "local.get", index: offsetTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "local.get", index: offsetTmp },
    { op: "local.get", index: srcLen },
    { op: "i32.add" },
    { op: "local.get", index: dstLen },
    { op: "i32.gt_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "RangeError", "offset is out of bounds", { flush: fctx }),
    } as Instr,
  );
}
