// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC `String.prototype.split` builder.
 *
 * Split out of `native-strings-rewrite.ts` (#3901): that module is itself a
 * #3182 Wave B decomposition of the ~4.8k-LOC `ensureNativeStringHelpers`, and
 * the #3901 rewrite of `__str_split` pushed it back over the
 * `check:loc-budget` ceiling. `__str_split` is a self-contained builder with
 * no shared state beyond {@link NativeStrShared}, so it gets its own cohesive
 * sibling module rather than an LOC-budget allowance — which is what the
 * consolidation plan asks for (add code to the subsystem module, not the
 * barrel).
 *
 * Called from `ensureNativeStringHelpers` in `native-strings.ts`, in the same
 * position as before, AFTER `__str_indexOf`/`__str_substring` are registered.
 */
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { NativeStrShared } from "./native-strings-shared.js";

// Local slots of `$__str_split`. Hoisted to module scope (#3901) so the scan
// and slice-view emitters below can be plain module functions — the combined
// builder outgrew the `check:func-budget` ceiling.
// params: s(0), sep(1), limit(2)
const S = 0,
  SEP = 1,
  LIMIT = 2;
// locals
const SLEN = 3,
  SEPLEN = 4,
  POS = 5,
  IDX = 6,
  SOFF = 7,
  SDATA = 8,
  SEPOFF = 9,
  SEPDATA = 10,
  SEPCH = 11,
  ONECHAR = 12,
  COUNT = 13,
  I = 14,
  J = 15,
  W = 16,
  N = 17,
  END = 18,
  RARR = 19,
  // (#4150) single-pass split: physical capacity of RARR, and the scratch
  // holding the grown array while its contents are copied over.
  CAP = 20,
  GROWN = 21;

/**
 * Emit `IDX = indexOf(sep, from POS)`, or -1 when there is no further
 * occurrence. Reads the pre-hoisted SLEN/SOFF/SDATA/SEPLEN/SEPOFF/SEPDATA
 * locals — no call, no flatten preamble, no re-`struct.get`.
 */
function emitScan(strDataTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: ONECHAR },
    {
      op: "if",
      blockType: { kind: "empty" },
      // Single code unit separator: flat scan, one compare per character.
      then: [
        { op: "local.get", index: POS },
        { op: "local.set", index: I },
        { op: "i32.const", value: -1 },
        { op: "local.set", index: IDX },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // if (i >= sLen) break
                { op: "local.get", index: I },
                { op: "local.get", index: SLEN },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // if (sData[sOff + i] === sepCh) { idx = i; break }
                { op: "local.get", index: SDATA },
                { op: "local.get", index: SOFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "local.get", index: SEPCH },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: I },
                    { op: "local.set", index: IDX },
                    // depths: if(0) loop(1) block(2)
                    { op: "br", depth: 2 },
                  ],
                },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      // Multi code unit separator: naive O(n·m) scan, same as __str_indexOf.
      else: [
        { op: "local.get", index: POS },
        { op: "local.set", index: I },
        { op: "i32.const", value: -1 },
        { op: "local.set", index: IDX },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // if (i > sLen - sepLen) break  — also covers sepLen > sLen
                { op: "local.get", index: I },
                { op: "local.get", index: SLEN },
                { op: "local.get", index: SEPLEN },
                { op: "i32.sub" },
                { op: "i32.gt_s" },
                { op: "br_if", depth: 1 },
                { op: "i32.const", value: 0 },
                { op: "local.set", index: J },
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        // if (j >= sepLen) { idx = i; break out of everything }
                        { op: "local.get", index: J },
                        { op: "local.get", index: SEPLEN },
                        { op: "i32.ge_s" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: I },
                            { op: "local.set", index: IDX },
                            // depths: if(0) innerLoop(1) innerBlock(2)
                            //         outerLoop(3) outerBlock(4)
                            { op: "br", depth: 4 },
                          ],
                        },
                        // if (sData[sOff + i + j] !== sepData[sepOff + j]) break inner
                        { op: "local.get", index: SDATA },
                        { op: "local.get", index: SOFF },
                        { op: "local.get", index: I },
                        { op: "i32.add" },
                        { op: "local.get", index: J },
                        { op: "i32.add" },
                        { op: "array.get_u", typeIdx: strDataTypeIdx },
                        { op: "local.get", index: SEPDATA },
                        { op: "local.get", index: SEPOFF },
                        { op: "local.get", index: J },
                        { op: "i32.add" },
                        { op: "array.get_u", typeIdx: strDataTypeIdx },
                        { op: "i32.ne" },
                        { op: "br_if", depth: 1 },
                        { op: "local.get", index: J },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: J },
                        { op: "br", depth: 0 },
                      ],
                    },
                  ],
                },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** `dst = min_u(a, b)` — `limit` arrives as 0xFFFFFFFF for "unbounded". */
function emitMinU(a: number, b: number, dst: number): Instr[] {
  return [
    { op: "local.get", index: a },
    { op: "local.get", index: b },
    { op: "local.get", index: a },
    { op: "local.get", index: b },
    { op: "i32.lt_u" },
    { op: "select" },
    { op: "local.set", index: dst },
  ];
}

/** Push `struct.new $NativeString(len, sOff + start, sData)` — an O(1) view. */
function emitSliceView(strTypeIdx: number, lenInstrs: Instr[], startLocal: number): Instr[] {
  return [
    ...lenInstrs,
    { op: "local.get", index: SOFF },
    { op: "local.get", index: startLocal },
    { op: "i32.add" },
    { op: "local.get", index: SDATA },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];
}

/**
 * `String.prototype.split` — returns a `$vec_nstr` of NativeStrings.
 */
export function emitStrSplitHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_split(s: ref $NativeString, sep: ref $NativeString, limit: i32) -> ref $vec_nstr ---
  // Splits s by sep, returns a native array of native strings. `limit` caps the
  // number of pieces (ECMA-262 §22.1.3.23): callers pass 0xFFFFFFFF (= -1 as i32)
  // for "no limit"; `limit === 0` yields the empty array (#2125).
  //
  // (#3901) Two-pass, call-free lowering. The previous shape called
  // `__str_indexOf` + `__str_substring` once per piece and grew the result
  // array by doubling (`array.new_default` + `array.copy` on overflow). That is
  // NOT allocation-bound — `__str_substring` is already an O(1) slice view, so
  // the allocation count was already the minimum (1 backing array + 1
  // NativeString per piece + 1 vec struct). The cost was per-call and per-char
  // overhead:
  //   - every `__str_indexOf` / `__str_substring` call re-ran the flatten
  //     preamble (`ref.test` + guarded `__str_flatten`) and re-loaded
  //     len/off/data with a `ref.cast` in front of each `struct.get`;
  //   - `__str_indexOf`'s scan is a nested block/loop whose inner `j >= nLen`
  //     test costs ~12 instructions per character even for a 1-char separator;
  //   - `__str_substring` re-clamped both bounds (4 `select`s + a swap `if`)
  //     although split's bounds are always already in range.
  // Now: hoist s/sep len+off+data into locals once, count the pieces in a tight
  // inline scan, allocate the result array at the EXACT size (no doubling, no
  // `array.copy`, no slack), then fill it with inline `struct.new $NativeString`
  // slice views. A single-code-unit separator (`","`, `"\n"` — the overwhelming
  // majority) gets a branch-light scan with no inner loop at all.
  {
    // Register native string array type: (array (mut (ref null $AnyString)))
    // Use ref_null so array.new_default can initialize with null.
    // Key must match what resolveWasmType generates for string[] (ref_N).
    const nstrElemKey = `ref_${anyStrTypeIdx}`;
    const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
    const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
    const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [nstrVecRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_split", funcIdx);

    const body: Instr[] = [
      // #2125: limit === 0 → return empty array (ECMA-262 §22.1.3.23 step 14).
      // The vec struct is { length: i32, data: ref $arr }, so push length 0
      // then a 0-capacity backing array.
      { op: "local.get", index: LIMIT },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 }, // vec length
          { op: "i32.const", value: 0 }, // backing array size
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ],
      },

      // Hoist the receiver's shape once — every scan and every slice view below
      // reads these locals instead of re-`struct.get`ing through a `ref.cast`.
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SLEN },
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: SOFF },
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: SDATA },

      // sepLen = sep.len
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SEPLEN },

      // Empty separator: split into individual code units (`"abc".split("")` →
      // ["a","b","c"]), capped at `limit`. Pre-sized exactly; each element is a
      // 1-unit view onto the receiver's backing array.
      { op: "local.get", index: SEPLEN },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...emitMinU(SLEN, LIMIT, N),
          { op: "local.get", index: N },
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "local.set", index: RARR },
          { op: "i32.const", value: 0 },
          { op: "local.set", index: POS },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: POS },
                  { op: "local.get", index: N },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: POS },
                  ...emitSliceView(strTypeIdx, [{ op: "i32.const", value: 1 }], POS),
                  { op: "array.set", typeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: POS },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          { op: "local.get", index: N },
          { op: "local.get", index: RARR },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ],
      },

      // sepOff / sepData — only reachable with a non-empty separator.
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: SEPOFF },
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: SEPDATA },

      // oneChar = sepLen === 1; sepCh = sepData[sepOff] (guarded — reading it
      // unconditionally would trap on a 0-length backing array).
      { op: "local.get", index: SEPLEN },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      { op: "local.tee", index: ONECHAR },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: SEPDATA },
          { op: "local.get", index: SEPOFF },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: SEPCH },
        ],
      },

      // --- (#4150) Single pass: scan once, writing pieces as they are found.
      //
      // This replaces a count-pass followed by a fill-pass. Two passes read
      // EVERY input character twice, which is a flat 2x on the scan — the
      // dominant term for any string longer than a few dozen characters
      // (measured 2.66 ns per input character, ~59% of `mixed/csv-parse`, and
      // the reason a 902-character split cost 24.6 ms against V8's flat 2.0).
      //
      // #3901 chose two passes to size the result array EXACTLY: "no doubling,
      // no array.copy, no slack". That trade is inverted here. The vec struct
      // stores its LOGICAL length in field 0, separate from the physical size
      // of the backing array in field 1 — capacity beyond the length is the
      // normal representation for a growable vec (it is exactly what `push`
      // consumes), and every consumer bounds by the length field. So slack is
      // free, while rescanning is not: copying at most a handful of refs on a
      // doubling beats re-reading hundreds of characters.
      //
      // Growth starts at 8 — above the piece count of the overwhelmingly
      // common splits (2-4 fields) so the usual call never grows at all.
      { op: "i32.const", value: 8 },
      { op: "local.set", index: CAP },
      { op: "local.get", index: CAP },
      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
      { op: "local.set", index: RARR },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: POS },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: W },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Stop once `limit` pieces have been produced. UNSIGNED compare:
              // the unbounded sentinel is 0xFFFFFFFF, and `limit === 0` must
              // yield the empty array (it breaks here on the first iteration).
              { op: "local.get", index: W },
              { op: "local.get", index: LIMIT },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // Grow when the next write would not fit.
              { op: "local.get", index: W },
              { op: "local.get", index: CAP },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: CAP },
                  { op: "i32.const", value: 1 },
                  { op: "i32.shl" },
                  { op: "local.set", index: CAP },
                  { op: "local.get", index: CAP },
                  { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                  { op: "local.set", index: GROWN },
                  { op: "local.get", index: GROWN },
                  { op: "ref.as_non_null" },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RARR },
                  { op: "ref.as_non_null" },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: W },
                  { op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: GROWN },
                  { op: "local.set", index: RARR },
                ],
              },
              ...emitScan(strDataTypeIdx),
              // end = idx < 0 ? sLen : idx  (idx < 0 only on the final piece)
              { op: "local.get", index: SLEN },
              { op: "local.get", index: IDX },
              { op: "local.get", index: IDX },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "select" },
              { op: "local.set", index: END },
              // result[w] = view(s, pos, end) — bounds are in range by
              // construction, so no clamp/swap is needed.
              { op: "local.get", index: RARR },
              { op: "local.get", index: W },
              ...emitSliceView(
                strTypeIdx,
                [{ op: "local.get", index: END }, { op: "local.get", index: POS }, { op: "i32.sub" }],
                POS,
              ),
              { op: "array.set", typeIdx: nstrArrTypeIdx },
              { op: "local.get", index: W },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: W },
              // The piece just written was the last one — no further separator.
              { op: "local.get", index: IDX },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              // pos = idx + sepLen
              { op: "local.get", index: IDX },
              { op: "local.get", index: SEPLEN },
              { op: "i32.add" },
              { op: "local.set", index: POS },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(w, resultArr) — `w` is the LOGICAL piece count; the
      // backing array may be larger (see the slack note above).
      { op: "local.get", index: W },
      { op: "local.get", index: RARR },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: nstrVecTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_split",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "sepLen", type: { kind: "i32" } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sepOff", type: { kind: "i32" } },
        { name: "sepData", type: strDataRef },
        { name: "sepCh", type: { kind: "i32" } },
        { name: "oneChar", type: { kind: "i32" } },
        { name: "count", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "w", type: { kind: "i32" } },
        { name: "n", type: { kind: "i32" } },
        { name: "end", type: { kind: "i32" } },
        {
          name: "resultArr",
          type: { kind: "ref_null", typeIdx: nstrArrTypeIdx },
        },
        { name: "cap", type: { kind: "i32" } },
        { name: "grown", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}
