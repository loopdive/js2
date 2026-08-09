import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { FunctionContext } from "./context/types.js";

/**
 * (#3902) Shared **stable bottom-up merge sort** used by every
 * `Array.prototype.sort` lowering in `array-methods.ts`.
 *
 * Both sort lowerings (the default ToString sort and the comparator sort) used
 * to emit their own copy of the same in-place *insertion* sort. That is
 * O(n²) *comparisons*, and each comparison is expensive here — a `call_ref`
 * into a user closure, or (default sort) a `number_toString` + `string_compare`
 * pair. On the published `array/sort-i32` benchmark (10,000 elements in
 * pseudo-random order) that is ~25,000,000 comparisons, which measured
 * 774 ms — 1,586× the JS baseline, the worst number on the perf page. A merge
 * sort needs `n·⌈log₂ n⌉` ≈ 133,000 comparisons for the same input: ~190×
 * fewer, with the same total order and the same stability.
 *
 * Stability: the merge takes from the LEFT run whenever
 * `cmp(left, right) <= 0`, so equal elements keep their relative order —
 * matching both §23.1.3.30 (sort is required to be stable since ES2019) and
 * the insertion sort this replaces.
 *
 * Scratch buffer: seeded with `data[0]` via `array.new` rather than
 * `array.new_default`, because the element type may be a NON-nullable `(ref
 * $T)` (struct-element arrays reach the comparator sort), which is not
 * defaultable. `data[0]` is always a valid element of the exact element type,
 * and the `len < 2` guard above guarantees index 0 exists.
 *
 * Ping-pong: each pass merges `src` into `dst` and then swaps the two, so no
 * per-pass copy-back is needed. `parity` tracks which buffer holds the sorted
 * data; a single `array.copy` at the end restores it into the caller's backing
 * array when an odd number of passes ran. The array OBJECT the caller holds is
 * never replaced, so `sort()` stays in-place (aliases and `vec.data` stay
 * valid).
 */
export interface MergeSortEmitOptions {
  arrTypeIdx: number;
  /** `array.get` / `array.get_u` / `array.get_s` for the element type. */
  getOp: Instr["op"];
  /** Local holding `(ref null $arrType)` — the backing array, sorted in place. */
  dataLocal: number;
  /** Local holding the i32 element count (already clamped to the backing). */
  lenLocal: number;
  /**
   * Builds an i32 `cmp(left, right) > 0` given instruction sequences that push
   * the left and right element values (as the raw element type) on the stack.
   */
  buildCompareGtZero: (pushLeft: Instr[], pushRight: Instr[]) => Instr[];
}

export function emitStableMergeSort(fctx: FunctionContext, o: MergeSortEmitOptions): void {
  const { arrTypeIdx, getOp, dataLocal, lenLocal } = o;
  const arrRef: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const n = fctx.locals.length;
  const srcL = allocLocal(fctx, `__msort_src_${n}`, arrRef);
  const dstL = allocLocal(fctx, `__msort_dst_${n}`, arrRef);
  const swapL = allocLocal(fctx, `__msort_swap_${n}`, arrRef);
  const i32: ValType = { kind: "i32" };
  const widthL = allocLocal(fctx, `__msort_w_${n}`, i32);
  const iL = allocLocal(fctx, `__msort_i_${n}`, i32);
  const midL = allocLocal(fctx, `__msort_mid_${n}`, i32);
  const hiL = allocLocal(fctx, `__msort_hi_${n}`, i32);
  const aL = allocLocal(fctx, `__msort_a_${n}`, i32);
  const bL = allocLocal(fctx, `__msort_b_${n}`, i32);
  const kL = allocLocal(fctx, `__msort_k_${n}`, i32);
  const parityL = allocLocal(fctx, `__msort_par_${n}`, i32);

  /** `min(local, lenLocal)` written back into `local`. */
  const clampToLen = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "local.get", index: lenLocal },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenLocal },
        { op: "local.set", index: local },
      ],
    },
  ];

  const readSrc = (idxLocal: number): Instr[] => [
    { op: "local.get", index: srcL },
    { op: "local.get", index: idxLocal },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];

  /** `dst[k] = src[cursor]; cursor++` */
  const takeFrom = (cursor: number): Instr[] => [
    { op: "local.get", index: dstL },
    { op: "local.get", index: kL },
    ...readSrc(cursor),
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: cursor },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: cursor },
  ];

  // takeLeft = a < mid && (b >= hi || !(cmp(src[a], src[b]) > 0))
  const takeLeftCond: Instr[] = [
    { op: "local.get", index: aL },
    { op: "local.get", index: midL },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: bL },
        { op: "local.get", index: hiL },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: 1 }],
          else: [...o.buildCompareGtZero(readSrc(aL), readSrc(bL)), { op: "i32.eqz" }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  // Merge one [lo, mid) + [mid, hi) pair of runs from `src` into `dst`.
  const mergeRun: Instr[] = [
    // mid = min(i + width, len); hi = min(mid + width, len)
    { op: "local.get", index: iL },
    { op: "local.get", index: widthL },
    { op: "i32.add" },
    { op: "local.set", index: midL },
    ...clampToLen(midL),
    { op: "local.get", index: midL },
    { op: "local.get", index: widthL },
    { op: "i32.add" },
    { op: "local.set", index: hiL },
    ...clampToLen(hiL),
    // a = i; b = mid; k = i
    { op: "local.get", index: iL },
    { op: "local.set", index: aL },
    { op: "local.get", index: midL },
    { op: "local.set", index: bL },
    { op: "local.get", index: iL },
    { op: "local.set", index: kL },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: kL },
            { op: "local.get", index: hiL },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...takeLeftCond,
            { op: "if", blockType: { kind: "empty" }, then: takeFrom(aL), else: takeFrom(bL) },
            { op: "local.get", index: kL },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: kL },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      // Nothing to do for 0- or 1-element arrays (and the scratch seed below
      // would read out of bounds).
      { op: "local.get", index: lenLocal },
      { op: "i32.const", value: 2 },
      { op: "i32.lt_s" },
      { op: "br_if", depth: 0 },

      // src = data; dst = new array(len) seeded with data[0]; parity = 0
      { op: "local.get", index: dataLocal },
      { op: "local.set", index: srcL },
      { op: "local.get", index: dataLocal },
      { op: "i32.const", value: 0 },
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: lenLocal },
      { op: "array.new", typeIdx: arrTypeIdx },
      { op: "local.set", index: dstL },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: parityL },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: widthL },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: widthL },
              { op: "local.get", index: lenLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: iL },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: iL },
                      { op: "local.get", index: lenLocal },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      ...mergeRun,
                      // i += 2 * width
                      { op: "local.get", index: iL },
                      { op: "local.get", index: widthL },
                      { op: "i32.add" },
                      { op: "local.get", index: widthL },
                      { op: "i32.add" },
                      { op: "local.set", index: iL },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // swap(src, dst); parity ^= 1; width *= 2
              { op: "local.get", index: srcL },
              { op: "local.set", index: swapL },
              { op: "local.get", index: dstL },
              { op: "local.set", index: srcL },
              { op: "local.get", index: swapL },
              { op: "local.set", index: dstL },
              { op: "local.get", index: parityL },
              { op: "i32.const", value: 1 },
              { op: "i32.xor" },
              { op: "local.set", index: parityL },
              { op: "local.get", index: widthL },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.set", index: widthL },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Odd pass count ⇒ the sorted data is in the scratch buffer; copy it back
      // so the caller's array object is the sorted one (sort is in-place).
      { op: "local.get", index: parityL },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: dataLocal },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: srcL },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: lenLocal },
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
        ],
      },
    ],
  });
}
