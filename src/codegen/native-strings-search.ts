// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — search (#3182 Wave B, slice 1).
 *
 * Extracted verbatim from the tail of `ensureNativeStringHelpers` in
 * `native-strings.ts` (which had grown to ~4.8k LOC). This module emits
 * the hot scan kernels (`indexOf`, `lastIndexOf`, `includes`).
 *
 * (#3256) The rest of this module's original contents — `startsWith`,
 * `endsWith`, and the whitespace-trim family — are SELF-HOSTED now: TS
 * source in src/stdlib/strings.ts compiled through the compiler's own IR
 * pipeline (see native-strings-selfhost.ts), registered under the same
 * `__str_*` names immediately after this builder runs.
 *
 * Each builder takes the shared per-call state ({@link NativeStrShared}) and is
 * called, in the original order, from `ensureNativeStringHelpers` AFTER the
 * core helpers (`__str_flatten`, `__str_concat`, `__str_equals`,
 * `__str_substring`, …) are registered — the builders look those up by name in
 * `ctx.nativeStrHelpers`.
 */
import type { Instr } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/** Reserved name of the shared fixed-offset code-unit compare kernel (#3899). */
export const STR_REGION_EQ_FN = "__str_region_eq";

/**
 * (#3899) `__str_region_eq(a, aOff, b, bOff, len) -> i32` — the shared
 * fixed-offset code-unit compare kernel.
 *
 * ## Why this is a hand `Instr[]` kernel and not more self-hosted TS
 *
 * `startsWith`/`endsWith` are self-hosted (#3256) and their spec clamps stay
 * there. Their SCAN, however, was lowering through the generic
 * `s.charCodeAt(i)` plan, which costs ~24 Wasm ops per code unit: an f64
 * induction variable (`f64.add` + `i32.trunc_sat_f64_s` per index), the
 * guarded helper's NaN bounds test on BOTH operands, and an
 * `f64.convert_i32_u` + `f64.ne` to compare two values that are already i32.
 * Measured on `string/startsWith-endsWith`, that is ~11 ns per code unit —
 * the reason the gc-native lane lost 4-7× to JS on the public perf page.
 *
 * The scan itself has no JS-observable semantics: it is a raw memory compare
 * of `len` code units, and the caller has already PROVEN both ranges are in
 * bounds (`pos + pLen <= sLen`, `start >= 0`). So it belongs with the other
 * retained rep kernels (`__str_flatten`, `__str_copy_tree`, `__str_equals`,
 * `__str_indexOf`) rather than in the self-hosted spec layer. The body below
 * is deliberately the SAME shape as `__str_indexOf`'s inner compare loop:
 * hoist `.data`/`.off` out of the loop, keep the induction variable in an i32
 * local, and compare with `i32.ne` — ~6 ops per code unit, no conversions.
 *
 * ABI: the numeric params are declared `f64` so self-hosted TS callers can
 * pass ordinary `number` index arithmetic (the caller-side dialect rule in
 * `stdlib-selfhost.ts` — there is no implicit f64→i32 arg coercion); the
 * kernel truncates all three ONCE at entry.
 *
 * PRECONDITION (caller-proven, not re-checked): `len >= 0`,
 * `aOff + len <= a.length` and `bOff + len <= b.length`. A violation is a
 * WasmGC `array.get` trap, not memory unsafety. `len <= 0` returns 1 (the
 * empty region matches), mirroring the `while (i < len)` loop it replaces.
 */
function emitStrRegionEqHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  const typeIdx = addFuncType(
    ctx,
    [strRef, { kind: "f64" }, strRef, { kind: "f64" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set(STR_REGION_EQ_FN, funcIdx);

  // params: a(0), aOff(1), b(2), bOff(3), len(4)
  // locals: n(5), i(6), ao(7), bo(8), aData(9), bData(10)
  const N = 5;
  const I = 6;
  const AO = 7;
  const BO = 8;
  const A_DATA = 9;
  const B_DATA = 10;

  const body: Instr[] = [
    // n = trunc(len); if (n <= 0) return 1
    { op: "local.get", index: 4 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: N },
    { op: "i32.const", value: 0 },
    { op: "i32.le_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    // ao = a.off + trunc(aOff)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "i32.add" },
    { op: "local.set", index: AO },
    // bo = b.off + trunc(bOff)
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 3 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "i32.add" },
    { op: "local.set", index: BO },
    // aData = a.data ; bData = b.data
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: A_DATA },
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: B_DATA },
    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if (i >= n) break
            { op: "local.get", index: I },
            { op: "local.get", index: N },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // if (aData[ao + i] != bData[bo + i]) return 0
            { op: "local.get", index: A_DATA },
            { op: "local.get", index: AO },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.get", index: B_DATA },
            { op: "local.get", index: BO },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "i32.ne" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 1 },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: STR_REGION_EQ_FN,
    typeIdx,
    locals: [
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "ao", type: { kind: "i32" } },
      { name: "bo", type: { kind: "i32" } },
      { name: "aData", type: strDataRef },
      { name: "bData", type: strDataRef },
    ],
    // Both string params may still be cons ropes (the self-hosted callers no
    // longer pre-flatten — that was two extra calls per invocation); the
    // `ref.test`-guarded preamble makes an already-flat receiver free.
    body: wrapBodyWithFlatten(body, [0, 2]),
    exported: false,
  });
}

/**
 * `String.prototype` search methods: `indexOf`, `lastIndexOf`, `includes`,
 * plus the shared `__str_region_eq` compare kernel (#3899).
 *
 * (`startsWith`/`endsWith` are self-hosted — see the module header, #3256.)
 *
 * The per-method builders below are separate functions purely for size (#3400
 * / R-FUNC); the EMISSION ORDER they are called in is load-bearing, because
 * each looks its predecessors up by name in `ctx.nativeStrHelpers` (`includes`
 * calls `indexOf`).
 */
export function emitStrSearchHelpers(shared: NativeStrShared): void {
  emitStrRegionEqHelper(shared);
  emitStrIndexOfHelper(shared);
  emitStrLastIndexOfHelper(shared);
  emitStrIncludesHelper(shared);
}

/** `$__str_indexOf(haystack: ref $AnyString, needle: ref $AnyString, fromIndex: i32) -> i32` */
function emitStrIndexOfHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_indexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10),
    //         last(11), n0(12)   — (#3899) last/n0 are the hoisted scan bounds
    const LAST = 11;
    const N0 = 12;
    const body: Instr[] = [
      // hLen = haystack.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // nLen = needle.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return clamp(fromIndex, 0, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
          { op: "select" },
          { op: "local.tee", index: 5 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff = haystack.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // nOff = needle.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData = haystack.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      // nData = needle.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // (#3899) last = hLen - nLen — the highest candidate start. Hoisted out
      // of the outer loop; it used to be recomputed on every candidate.
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.set", index: LAST },
      // (#3899) n0 = needle[0] — safe, the nLen == 0 arm returned above.
      { op: "local.get", index: 8 },
      { op: "local.get", index: 10 },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: N0 },
      // i = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // outer loop: scan i from fromIndex to last
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i > last, break
              { op: "local.get", index: 5 },
              { op: "local.get", index: LAST },
              { op: "i32.gt_s" },
              { op: "br_if", depth: 1 },
              // (#3899) First-code-unit skip: only set up the compare loop when
              // hData[hOff + i] == n0. On real text the overwhelming majority of
              // candidates fail here, and this arm is 1 load + 1 compare instead
              // of an inner-loop entry with two loads and a j induction variable.
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: N0 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // j = 1; inner loop compares the REMAINING needle units
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: 6 },
                  {
                    op: "block",
                    blockType: { kind: "empty" },
                    body: [
                      {
                        op: "loop",
                        blockType: { kind: "empty" },
                        body: [
                          // if j >= nLen, match found — return i
                          { op: "local.get", index: 6 },
                          { op: "local.get", index: 4 },
                          { op: "i32.ge_s" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [{ op: "local.get", index: 5 }, { op: "return" }],
                          },
                          // if hData[hOff + i + j] != nData[nOff + j], break inner
                          { op: "local.get", index: 7 },
                          { op: "local.get", index: 9 },
                          { op: "local.get", index: 5 },
                          { op: "i32.add" },
                          { op: "local.get", index: 6 },
                          { op: "i32.add" },
                          { op: "array.get_u", typeIdx: strDataTypeIdx },
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 10 },
                          { op: "local.get", index: 6 },
                          { op: "i32.add" },
                          { op: "array.get_u", typeIdx: strDataTypeIdx },
                          { op: "i32.ne" },
                          { op: "br_if", depth: 1 },
                          // j++
                          { op: "local.get", index: 6 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: 6 },
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_indexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
        { name: "last", type: { kind: "i32" } },
        { name: "n0", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}

/** `$__str_lastIndexOf(haystack: ref $AnyString, needle: ref $AnyString, fromIndex: i32) -> i32` */
function emitStrLastIndexOfHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_lastIndexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#2875) §22.1.3.9 step 8: start candidates are bounded by
      // min(max(pos, 0), …) — clamp fromIndex to ≥ 0 ONCE here so both the
      // empty-needle arm (min(fromIndex, hLen)) and the scan init
      // (min(fromIndex, hLen - nLen)) see the spec's max(pos, 0). Without it,
      // lastIndexOf('a', -1) started the reverse scan at -1 and returned -1
      // instead of checking position 0.
      // fromIndex = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // if nLen == 0, return min(fromIndex, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff, nOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData, nData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = min(fromIndex, hLen - nLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.tee", index: 5 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // reverse scan
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // hData[hOff + i + j]
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      // nData[nOff + j]
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_lastIndexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}

/**
 * `$__str_includes(haystack: ref $AnyString, needle: ref $AnyString, fromIndex: i32) -> i32`
 * — must be emitted AFTER `__str_indexOf`, whose funcIdx it bakes.
 */
function emitStrIncludesHelper(shared: NativeStrShared): void {
  const { ctx, strRef } = shared;
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_includes", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_includes",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // (#3256) __str_startsWith / __str_endsWith are SELF-HOSTED — see
  // src/stdlib/strings.ts + emitSelfHostedStringHelpers, which registers the
  // same names (legacy i32-position ABI preserved by thunks) right after this
  // builder runs. The trim family (__str_isWhitespace/trimStart/trimEnd/trim)
  // moved there too; __str_isWhitespace's table now lives in TS source.
}
