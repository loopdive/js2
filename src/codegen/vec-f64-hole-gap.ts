// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T8) The f64 half of the array-hole value representation.
 *
 * ## The wall, precisely
 *
 * `array-holes.ts` gives an **externref**-element vec a real absence marker —
 * the `$Hole` singleton — and states the scope limit in its own header: typed
 * `number[]` vecs "never see a `$Hole` struct type". `expressions/assignment.ts`
 * says the same thing from the other side, in the #2773 S7 gap-fill comment:
 * *"an f64/i32 slot cannot hold either representation."*
 *
 * That sentence is what this module contradicts, and only for f64. An f64 slot
 * CAN hold a marker, and the compiler already has one: `UNDEF_F64_BITS`
 * (`value-tags.ts`), the SIGNALING NaN `0x7FF00000DEADC0DE`. JS arithmetic only
 * ever produces the QUIET NaN `0x7FF8000000000000`, so the pattern cannot
 * collide with a computed value, and ~28 observer sites already read it as
 * "undefined" (`x === undefined`, `typeof`, ToString, destructuring defaults).
 *
 * ## What was actually wrong
 *
 * The bug is NOT (mainly) the literal elision `[0, , 2]` — it is the GROW-GAP:
 *
 * ```js
 * var x = [];
 * x[0] = 0;
 * x[3] = 3;      // grows the backing; slots 1,2 are array.new_default
 * x.toString();  // "0,0,0,3"  — expected "0,,,3"
 * x[1];          // 0          — expected undefined
 * ```
 *
 * `array.new_default` zero-fills an f64 backing, and `0` is a perfectly legal
 * array element, so nothing downstream could tell the gap from real data. The
 * externref carrier had this covered since #2773 S7 (it fills the gap with
 * `undefined`, or with `$Hole` for the #4222 branded carrier); the f64 carrier
 * fell through that `if` entirely.
 *
 * ## The two halves here
 *
 * 1. {@link emitF64GapFillInstrs} — the gap-fill the externref branch already
 *    had, for an f64 element: `array.fill(data, oldLen, UNDEF_F64_BITS,
 *    idx - oldLen)` under the same `needsGapFillCondInstrs` guard. Emitted only
 *    when a store actually grows past the current length, so a dense
 *    `for (i…) a[i] = v` fill never reaches it (`idx > length` is false at every
 *    step) and the #1897 dense-numeric `struct.get` contract is untouched.
 *
 * 2. {@link f64JoinSentinelArm} — §23.1.3.18 step 4.b for the marker. The
 *    JS-host `compileArrayJoin` has had this since #1998; the standalone
 *    `compileArrayJoinNative` fold never grew it, so the same array joined as
 *    "0,NaN,NaN,3" host-free. Renders `""`, which is also what a genuine
 *    `undefined` element renders — so this arm is correct whether the slot got
 *    its marker from a gap or from `a[1] = undefined`.
 *
 * ## What this deliberately does NOT do
 *
 * The marker means **undefined**, not **absent**. `1 in x` still answers true
 * and `Object.keys(x)` still lists the gap index, because distinguishing a hole
 * from an explicit `undefined` needs a SECOND, distinct sNaN payload plus a
 * `hole → undefined` canonicalization at every vec read boundary (the
 * `emitHoleToUndefined` discipline, extended from externref to f64) and a
 * per-carrier hole test in `__extern_has_idx`'s vec arm. That is the presence
 * half; it is designed in the issue file and deliberately not in this slice,
 * which is the value half only.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { FunctionContext } from "./context/types.js";
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "./value-tags.js";

/**
 * The `[oldLen, idx)` gap-fill for an f64-element vec whose backing has just
 * been grown by an index store past the current length.
 *
 * Mirrors the externref branch in `expressions/assignment.ts` one-for-one —
 * same `needsGapFillCondInstrs` guard, same `array.fill` — with the sNaN
 * marker in place of the `undefined` externref. Returns the instructions to
 * append; the caller supplies the already-allocated `vecLocal` / `dataLocal` /
 * `idxLocal` / `unbackedLocal` and the guard builder, so this module stays free
 * of assignment.ts's local-allocation bookkeeping.
 */
export function emitF64GapFillInstrs(
  fctx: FunctionContext,
  opts: {
    vecLocal: number;
    dataLocal: number;
    idxLocal: number;
    vecTypeIdx: number;
    arrTypeIdx: number;
    /** `needsGapFillCondInstrs(unbackedLocal, idxLocal, oldLenLocal)`. */
    gapCond: (oldLenLocal: number) => Instr[];
    /**
     * (#4491 T11) Which marker the gap carries. `UNDEF_F64_BITS` — the T8-A
     * value-half answer — when the module cannot ask presence questions;
     * `HOLE_F64_BITS` when it can, so `in` / `hasOwnProperty` / `Object.keys` /
     * the HOF hole-skip can tell the gap from an explicit `undefined` element.
     * The caller supplies it from `f64HolesActive(ctx)`.
     */
    markerBits?: bigint;
  },
): Instr[] {
  const markerLocal = allocLocal(fctx, `__gap_hole_${fctx.locals.length}`, { kind: "f64" });
  const oldLenLocal = allocLocal(fctx, `__gap_hole_len_${fctx.locals.length}`, { kind: "i32" });
  return [
    { op: "i64.const", value: opts.markerBits ?? UNDEF_F64_BITS },
    { op: "f64.reinterpret_i64" },
    { op: "local.set", index: markerLocal },
    { op: "local.get", index: opts.vecLocal },
    { op: "struct.get", typeIdx: opts.vecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: oldLenLocal },
    ...opts.gapCond(oldLenLocal),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: opts.dataLocal },
        { op: "local.get", index: oldLenLocal },
        { op: "local.get", index: markerLocal },
        { op: "local.get", index: opts.idxLocal },
        { op: "local.get", index: oldLenLocal },
        { op: "i32.sub" },
        { op: "array.fill", typeIdx: opts.arrTypeIdx },
      ],
    },
  ];
}

/**
 * §23.1.3.18 step 4.b for the f64 marker inside `compileArrayJoinNative`'s
 * element-to-string fold: the marker renders `""`, every other f64 renders
 * through `number_toString` (so a genuine NaN still renders "NaN").
 *
 * `emptyLiteral` / `resultType` come from the caller's join representation so
 * the arm types identically in the native-string and host lanes.
 */
export function f64JoinSentinelArm(
  fctx: FunctionContext,
  opts: {
    resultType: ValType;
    emptyLiteral: Instr[];
    /** Instructions that turn the f64 on the stack into the fold's result type. */
    numberToString: Instr[];
  },
): Instr[] {
  const elemLocal = allocLocal(fctx, `__njoin_f64_${fctx.locals.length}`, { kind: "f64" });
  const bitsLocal = allocLocal(fctx, `__njoin_bits_${fctx.locals.length}`, { kind: "i64" });
  return [
    { op: "local.tee", index: elemLocal },
    { op: "i64.reinterpret_f64" },
    // (#4491 T11) BOTH markers render `""` here: §23.1.3.18 step 4.b treats an
    // absent index and an `undefined` element identically. Testing only the
    // `undefined` payload would make a hole render "NaN" the moment T11 started
    // marking gaps with the absence payload.
    { op: "local.tee", index: bitsLocal },
    { op: "i64.const", value: UNDEF_F64_BITS },
    { op: "i64.eq" },
    { op: "local.get", index: bitsLocal },
    { op: "i64.const", value: HOLE_F64_BITS },
    { op: "i64.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: opts.resultType },
      then: opts.emptyLiteral,
      else: [{ op: "local.get", index: elemLocal }, ...opts.numberToString],
    },
  ];
}
