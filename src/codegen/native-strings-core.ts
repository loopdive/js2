// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — rope flatten & UTF-8 conversion core (#3182 Wave B, slice 2).
 *
 * Extracted verbatim from the head of `ensureNativeStringHelpers` in
 * `native-strings.ts`. This module emits the rope-flattening core (`__str_copy_tree`, `__str_utf8_to_flat`,
 * `__str_flatten`) and UTF-8 serialization (`__str_to_utf8`) — the foundation every
 * other native-string helper relies on to turn a possibly-ConsString into a flat
 * NativeString.
 *
 * Each builder takes the shared per-call state ({@link NativeStrShared}) and is
 * called, in the original order, from `ensureNativeStringHelpers`. Ordering
 * matters: later builders look up earlier helpers by name in
 * `ctx.nativeStrHelpers`, so the fixed call sequence preserves every baked-in
 * sibling funcIdx.
 *
 * This is a pure mechanical relocation: the emitted Wasm bytes are byte-identical
 * to the pre-split inline blocks (verified via `prove-emit-identity`).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * #1588 PR-B part 2: the cons-string flatten body — `__str_flatten`'s `else`
 * arm for a non-flat, non-Utf8String input (i.e. a ConsString rope). Extracted
 * so the Utf8String dispatch arm can wrap it. Operates on locals: s(0), len(1),
 * buf(2). Returns the rope flattened to a `NativeString`.
 */
function flattenConsBody(
  ctx: CodegenContext,
  strDataTypeIdx: number,
  strTypeIdx: number,
  anyStrTypeIdx: number,
  copyTreeIdx: number,
): Instr[] {
  const consTypeIdx = ctx.consStrTypeIdx;
  // (#3673) Interned "" literal — the memoization writes it into `right`.
  const emptyInstrs = nativeStringLiteralInstrs(ctx, "");
  return [
    // (#3673) Memoized-cons fast path: a previously-flattened cons was
    // rewritten in place to (left=flat, right=""). Return the flat left
    // without re-copying. Also catches a natural `x + ""` whose left is
    // already flat.
    { op: "local.get", index: 0 },
    { op: "ref.test", typeIdx: consTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // right.len == 0 ?
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: consTypeIdx },
        { op: "struct.get", typeIdx: consTypeIdx, fieldIdx: 2 },
        { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // left is flat ?
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: consTypeIdx },
            { op: "struct.get", typeIdx: consTypeIdx, fieldIdx: 1 },
            { op: "ref.test", typeIdx: strTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "ref.cast", typeIdx: consTypeIdx },
                { op: "struct.get", typeIdx: consTypeIdx, fieldIdx: 1 },
                { op: "ref.cast", typeIdx: strTypeIdx },
                { op: "return" },
              ],
            },
          ],
        },
      ],
    },
    // len = s.len (field 0 of AnyString)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 1 },
    // buf = array.new_default(len)
    { op: "local.get", index: 1 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: 2 },
    // copy_tree(s, buf, 0)
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: copyTreeIdx },
    { op: "drop" },
    // flat = struct.new $HashedString(len, 0, buf, 0) — (#3673 round 9) the
    // memoized flat copy carries an uncomputed (0) hash slot so `__obj_hash`
    // can cache into it on first probe; plain $NativeString when the hashed
    // subtype isn't registered. Subtype of $NativeString — every consumer
    // (incl. the memoized-cons fast path's `ref.test`/`ref.cast`) unchanged.
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 2 },
    ...(ctx.hashedStrTypeIdx >= 0
      ? ([
          { op: "i32.const", value: 0 }, // hash: uncomputed
          { op: "i32.const", value: 0 }, // cacheGen: never populated
          { op: "ref.null", typeIdx: -18 }, // cacheOwner
          { op: "ref.null", typeIdx: -18 }, // cacheEntry
          { op: "ref.null", typeIdx: -18 }, // cacheProps (round 21)
          { op: "struct.new", typeIdx: ctx.hashedStrTypeIdx },
        ] satisfies Instr[])
      : ([{ op: "struct.new", typeIdx: strTypeIdx }] satisfies Instr[])),
    { op: "local.set", index: 3 },
    // (#3673) Memoize: rewrite the cons in place to (left=flat, right="") so
    // the next flatten of this rope takes the fast path above. `len` is
    // untouched (flat.len == s.len).
    { op: "local.get", index: 0 },
    { op: "ref.test", typeIdx: consTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: consTypeIdx },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: consTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: consTypeIdx },
        ...emptyInstrs,
        { op: "struct.set", typeIdx: consTypeIdx, fieldIdx: 2 },
      ],
    },
    // return flat
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
  ];
}

/**
 * Rope flattening: `__str_copy_tree` (iterative rope→buffer copy),
 * `__str_utf8_to_flat` (UTF-8 decode) and `__str_flatten` (AnyString→NativeString).
 */
export function emitStrFlattenHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx, strRef, flatStrRef, strDataRef } = shared;

  // --- $__str_copy_tree(node: ref $AnyString, buf: ref $__str_data, pos: i32) -> i32 ---
  // Iteratively copies rope tree into a flat buffer. Returns next write position.
  //
  // Previously this used self-recursion to traverse the rope tree, which caused
  // a wasm `call stack exhausted` trap on left-leaning ropes built by `text +=
  // expr` patterns over many thousands of iterations (#1178). The deep
  // left-spine of `Cons(Cons(Cons(..., c2), c1), c0)` made one stack frame per
  // cons node.
  //
  // The iterative version uses an explicit worklist of right-children. We
  // descend the leftmost spine (pushing right-children onto the worklist),
  // copy each flat leaf, then pop and resume from the most recently pushed
  // right-child. Stack usage is now O(1); heap usage is O(node.len) for the
  // worklist (overestimate; depth ≤ leaves ≤ len since each leaf has ≥ 1 char).
  {
    // Register the worklist's array type: (array (mut (ref null $AnyString))).
    // Reuses the same registration as `__str_split` (keyed by `ref_<anyStr>`).
    const wlElemKey = `ref_${anyStrTypeIdx}`;
    const wlElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const wlArrTypeIdx = getOrRegisterArrayType(ctx, wlElemKey, wlElemType);
    const wlArrRefNull: ValType = { kind: "ref_null", typeIdx: wlArrTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strDataRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_copy_tree", funcIdx);

    // params: node(0), buf(1), pos(2)
    // locals:
    //   flat(3): ref_null $NativeString — current flat node being copied
    //   flatOff(4): i32
    //   flatLen(5): i32
    //   cur(6): ref_null $AnyString — current node in the descent
    //   worklist(7): ref_null $AnyString_arr — pending right-children
    //   wlTop(8): i32 — number of items currently on the worklist
    //   newWl(9): ref_null $AnyString_arr — scratch slot for grow-on-push reallocation (#1184)
    const FLAT = 3;
    const FLAT_OFF = 4;
    const FLAT_LEN = 5;
    const CUR = 6;
    const WL = 7;
    const WL_TOP = 8;
    const NEW_WL = 9;

    const body: Instr[] = [
      // Fast path: if node is already a FlatString, copy directly and return.
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
          { op: "local.set", index: FLAT },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.set", index: FLAT_OFF },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
          { op: "local.set", index: FLAT_LEN },

          // array.copy(buf, pos, flat.data, flatOff, flatLen)
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: FLAT_OFF },
          { op: "local.get", index: FLAT_LEN },
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // return pos + flatLen
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT_LEN },
          { op: "i32.add" },
          { op: "return" },
        ],
      },

      // Slow path: rope traversal with an explicit worklist of right-children.
      //
      // #1184: pre-#1184, this allocated a worklist sized at `node.len` (a generous
      // upper bound on rope depth — depth ≤ leaves ≤ chars). For balanced ropes
      // (depth ~log N) on a long string, that's a huge over-allocation: a 1MB
      // ConsString with a balanced rope has depth ~20 but allocates 1M ref slots
      // (≈8MB on 64-bit WasmGC). Each `String.prototype.charAt` / `charCodeAt` /
      // `substring` etc. on a ConsString triggers a fresh flatten → copy_tree →
      // huge allocation, producing severe GC pressure on string-heavy workloads.
      //
      // Strategy: dynamic growth. Start with a small fixed initial capacity (16
      // slots — enough for any rope of depth ≤ 16, which covers virtually all
      // balanced ropes up to ~1MB). When the worklist would overflow on push,
      // double its capacity via array.copy. Final capacity is at most the rope
      // depth; geometric reallocation gives O(depth) total allocation.
      //
      // Worst-case (left-leaning rope of depth N): log2(N/16) reallocations,
      // total slots allocated = 2N (geometric series). Same order as the
      // pre-#1184 N-slot single-allocation, but spread across log N small
      // allocations. The common case (depth ≤ 16) does ONE 16-slot allocation
      // — orders of magnitude smaller than `node.len`.
      //
      // worklist = array.new_default<ref_null $AnyString>(16)
      { op: "i32.const", value: 16 },
      { op: "array.new_default", typeIdx: wlArrTypeIdx },
      { op: "local.set", index: WL },

      // wlTop = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: WL_TOP },

      // cur = node
      { op: "local.get", index: 0 },
      { op: "local.set", index: CUR },

      // Outer loop: descend left, copy a flat segment, pop next right-child.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Inner loop: walk left while cur is a ConsString, pushing
              // right-children onto the worklist. Exits when cur is FlatString.
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if cur is FlatString: br to end of inner block (depth 1)
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.test", typeIdx: strTypeIdx },
                      { op: "br_if", depth: 1 },

                      // #1184: grow worklist if full (wlTop >= worklist.len).
                      // Doubling-grow: array.new_default(len * 2), array.copy old → new.
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "array.len" },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // newWl = array.new_default(worklist.len << 1)
                          { op: "local.get", index: WL },
                          { op: "ref.as_non_null" },
                          { op: "array.len" },
                          { op: "i32.const", value: 1 },
                          { op: "i32.shl" },
                          {
                            op: "array.new_default",
                            typeIdx: wlArrTypeIdx,
                          },
                          { op: "local.set", index: NEW_WL },

                          // array.copy(newWl, 0, worklist, 0, wlTop)
                          { op: "local.get", index: NEW_WL },
                          { op: "ref.as_non_null" },
                          { op: "i32.const", value: 0 },
                          { op: "local.get", index: WL },
                          { op: "ref.as_non_null" },
                          { op: "i32.const", value: 0 },
                          { op: "local.get", index: WL_TOP },
                          {
                            op: "array.copy",
                            dstTypeIdx: wlArrTypeIdx,
                            srcTypeIdx: wlArrTypeIdx,
                          },

                          // worklist = newWl
                          { op: "local.get", index: NEW_WL },
                          { op: "local.set", index: WL },
                        ],
                      },

                      // worklist[wlTop] = (cur as ConsString).right
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 2,
                      },
                      { op: "array.set", typeIdx: wlArrTypeIdx },

                      // wlTop++
                      { op: "local.get", index: WL_TOP },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: WL_TOP },

                      // cur = (cur as ConsString).left
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 1,
                      },
                      { op: "local.set", index: CUR },

                      // continue inner loop
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // cur is a FlatString — copy its contents into buf at pos.
              { op: "local.get", index: CUR },
              { op: "ref.as_non_null" },
              { op: "ref.cast", typeIdx: strTypeIdx },
              { op: "local.set", index: FLAT },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
              { op: "local.set", index: FLAT_OFF },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
              { op: "local.set", index: FLAT_LEN },

              // array.copy(buf, pos, flat.data, flatOff, flatLen)
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: FLAT_OFF },
              { op: "local.get", index: FLAT_LEN },
              {
                op: "array.copy",
                dstTypeIdx: strDataTypeIdx,
                srcTypeIdx: strDataTypeIdx,
              },

              // pos += flatLen
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT_LEN },
              { op: "i32.add" },
              { op: "local.set", index: 2 },

              // if wlTop == 0: br to end of outer block (depth 1) — done
              { op: "local.get", index: WL_TOP },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },

              // wlTop--
              { op: "local.get", index: WL_TOP },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: WL_TOP },

              // cur = worklist[wlTop]
              { op: "local.get", index: WL },
              { op: "ref.as_non_null" },
              { op: "local.get", index: WL_TOP },
              { op: "array.get", typeIdx: wlArrTypeIdx },
              { op: "local.set", index: CUR },

              // continue outer loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return pos
      { op: "local.get", index: 2 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_copy_tree",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatOff", type: { kind: "i32" } },
        { name: "flatLen", type: { kind: "i32" } },
        { name: "cur", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "worklist", type: wlArrRefNull },
        { name: "wlTop", type: { kind: "i32" } },
        { name: "newWl", type: wlArrRefNull },
      ],
      body,
      exported: false,
    });
  }

  // #1588 PR-B part 2: $__str_utf8_to_flat(u: ref $Utf8String) -> ref $NativeString
  // Decode the i8 UTF-8 bytes back to i16 WTF-16 code units. Only emitted when
  // --utf8-storage is on (the Utf8String type exists). The output array is
  // pre-sized to `u.len` (the code-unit count stored at allocation time), so no
  // resize is needed. Well-formed UTF-8 is assumed (the encoder only produces it
  // for ascii/utf8-guaranteed strings; lone surrogates never reach i8 storage).
  if (ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0) {
    const u8StrRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrTypeIdx };
    const typeIdx = addFuncType(ctx, [u8StrRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_utf8_to_flat", funcIdx);
    // params: u(0)
    // locals: len(1) code-unit count, byteLen(2), data(3) i8 array, out(4) i16 array,
    //         b(5) byte index, o(6) out index, c0(7) lead byte, cp(8) code point
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 0 }, // len
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 1 }, // byteLen
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 3 }, // data (ref $__str_data_u8)
      { op: "local.set", index: 3 },
      // out = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 }, // b = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 }, // o = 0
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if b >= byteLen break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // c0 = data[b] & 0xFF (array.get_u zero-extends an i8 lane)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.set", index: 7 },
              // dispatch on c0
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 0x80 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 1-byte: cp = c0
                  { op: "local.get", index: 7 },
                  { op: "local.set", index: 8 },
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 5 },
                ],
                else: [
                  { op: "local.get", index: 7 },
                  { op: "i32.const", value: 0xe0 },
                  { op: "i32.lt_u" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // 2-byte: cp = ((c0 & 0x1F)<<6) | (data[b+1] & 0x3F)
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0x1f },
                      { op: "i32.and" },
                      { op: "i32.const", value: 6 },
                      { op: "i32.shl" },
                      { op: "local.get", index: 3 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
                      { op: "i32.const", value: 0x3f },
                      { op: "i32.and" },
                      { op: "i32.or" },
                      { op: "local.set", index: 8 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                    ],
                    else: [
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0xf0 },
                      { op: "i32.lt_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // 3-byte: cp = ((c0&0x0F)<<12)|((b1&0x3F)<<6)|(b2&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x0f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                        else: [
                          // 4-byte: cp = ((c0&0x07)<<18)|((b1&0x3F)<<12)|((b2&0x3F)<<6)|(b3&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x07 },
                          { op: "i32.and" },
                          { op: "i32.const", value: 18 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 4 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // emit cp into out: BMP → one code unit; astral → surrogate pair
              { op: "local.get", index: 8 },
              { op: "i32.const", value: 0xffff },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // cp -= 0x10000; high = 0xD800 | (cp>>10); low = 0xDC00 | (cp&0x3FF)
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x10000 },
                  { op: "i32.sub" },
                  { op: "local.set", index: 8 },
                  // out[o] = 0xD800 | (cp>>10)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xd800 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 10 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                  // out[o] = 0xDC00 | (cp & 0x3FF)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xdc00 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x3ff },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
                else: [
                  // out[o] = cp
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "local.get", index: 8 },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return struct.new $NativeString(len, 0, out)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_utf8_to_flat",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        {
          name: "data",
          type: { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx },
        },
        { name: "out", type: strDataRef },
        { name: "b", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "c0", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_flatten(s: ref $AnyString) -> ref $NativeString ---
  // If s is already a FlatString, returns it. Otherwise flattens the rope tree.
  {
    const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_flatten", funcIdx);
    // Also register in funcMap so the deferred late-import shift
    // (flushLateImportShifts walks ctx.funcMap) keeps __str_flatten's index
    // correct when imports are added after this registration. Internal callers
    // that emit a `call __str_flatten` between flatten's registration and a
    // late-import addition (notably ensureNativeStringExternBridge's
    // __str_to_extern, which adds 3 fd-bridge imports first) would otherwise
    // read a stale-low nativeStrHelpers index. funcMap is the authoritative,
    // shift-maintained map; no code looks up __str_flatten via funcMap so adding
    // it is side-effect-free. (#1618)
    ctx.funcMap.set("__str_flatten", funcIdx);

    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;
    // #1588 PR-B part 2: present iff --utf8-storage is on.
    const utf8ToFlatIdx = ctx.nativeStrHelpers.get("__str_utf8_to_flat");

    // params: s(0)
    // locals: len(1), buf(2)
    const body: Instr[] = [
      // if s is already a FlatString, return it
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: flatStrRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
        ],
        else:
          ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined
            ? [
                // #1588 PR-B part 2: if s is a Utf8String, decode it to a NativeString.
                { op: "local.get", index: 0 },
                { op: "ref.test", typeIdx: ctx.utf8StrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: flatStrRef },
                  then: [
                    { op: "local.get", index: 0 },
                    { op: "ref.cast", typeIdx: ctx.utf8StrTypeIdx },
                    { op: "call", funcIdx: utf8ToFlatIdx },
                  ],
                  else: flattenConsBody(ctx, strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
                },
              ]
            : flattenConsBody(ctx, strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_flatten",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "buf", type: strDataRef },
        // (#3673) holds the freshly-built flat result across the memoization
        // writeback (flattenConsBody local index 3).
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }
}

/**
 * `__str_to_utf8` — serialize a NativeString to a UTF-8 `$__str_data_u8` array.
 */
export function emitStrToUtf8Helper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, flatStrRef, strDataRef } = shared;

  // #1588 PR-C: $__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8
  //
  // Standalone (pure-Wasm, no JS host call) WTF-16 → UTF-8 transcoder. Takes any
  // string value (NativeString, ConsString, or Utf8String), flattens it to a
  // contiguous i16 buffer, then encodes the code units to a freshly-allocated i8
  // UTF-8 byte array. This is the missing primitive the Component-Model boundary
  // (Edge B, deferred — see ADR-0015) will eventually call instead of a host
  // `TextEncoder` import, satisfying the "JS host optional" architecture rule.
  //
  // Semantics: this is the *conservative* encoder. Unlike the compile-time
  // `utf8Encode` (which asserts well-formedness for ascii/utf8-guaranteed
  // literals), this runtime helper handles arbitrary WTF-16 input. A lone
  // surrogate is encoded with the WTF-8 generalization (3-byte form of the raw
  // code unit 0xD800–0xDFFF) so the function is total and never traps. The
  // Component-Model fast path is only ever selected for values the encoding
  // analysis proved `utf8-guaranteed`, so a lone surrogate never reaches the
  // boundary fast path; this helper's surrogate handling is a defensive
  // totality guarantee, not a correctness path.
  //
  // Two passes over the flattened i16 buffer: pass 1 sums the UTF-8 byte length
  // so the output array is allocated exactly once (no realloc); pass 2 writes
  // the bytes. Only emitted when `--utf8-storage` is on (the i8 backing array
  // type `__str_data_u8` is registered only then).
  if (ctx.utf8Storage && ctx.utf8StrDataTypeIdx >= 0) {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const u8DataRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx };
    const typeIdx = addFuncType(ctx, [strRef], [u8DataRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_utf8", funcIdx);

    // params: s(0)
    // locals:
    //   flat(1): ref $NativeString — flattened input
    //   data(2): ref $__str_data — i16 code units
    //   off(3): i32 — flat.off
    //   len(4): i32 — flat.len (code-unit count)
    //   out(5): ref $__str_data_u8 — UTF-8 output array
    //   i(6): i32 — code-unit cursor (shared by both passes)
    //   o(7): i32 — output byte cursor
    //   byteLen(8): i32 — total UTF-8 byte length (pass 1 result)
    //   cu(9): i32 — current code unit
    //   cp(10): i32 — current code point (after surrogate-pair decode)
    //   lo(11): i32 — trailing low surrogate scratch
    const FLAT = 1;
    const DATA = 2;
    const OFF = 3;
    const LEN = 4;
    const OUT = 5;
    const I = 6;
    const O = 7;
    const BYTELEN = 8;
    const CU = 9;
    const CP = 10;
    const LO = 11;

    // Shared sub-sequence: read the code point starting at code-unit index I of
    // `data`+`off`, advancing I past the consumed unit(s). Leaves cp in CP.
    // Handles a well-formed high+low surrogate pair (astral scalar) and treats a
    // lone surrogate as its raw code-unit value (WTF-8). `bodyAfterCp` is emitted
    // after CP is set and I is advanced; it differs between the two passes.
    const decodeCp = (bodyAfterCp: Instr[]): Instr[] => [
      // cu = data[off + i]
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      // cp = cu (default)
      { op: "local.get", index: CU },
      { op: "local.set", index: CP },
      // i++ (consume the lead unit)
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
      // if cu is a high surrogate (0xD800..0xDBFF) and a low surrogate follows,
      // combine into an astral code point and consume the low unit too.
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // && i < len (a low unit exists)
      { op: "local.get", index: I },
      { op: "local.get", index: LEN },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // lo = data[off + i]
          { op: "local.get", index: DATA },
          { op: "local.get", index: OFF },
          { op: "local.get", index: I },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: LO },
          // if lo in 0xDC00..0xDFFF: cp = 0x10000 + ((cu-0xD800)<<10) + (lo-0xDC00); i++
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0x10000 },
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0xd800 },
              { op: "i32.sub" },
              { op: "i32.const", value: 10 },
              { op: "i32.shl" },
              { op: "i32.add" },
              { op: "local.get", index: LO },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.set", index: CP },
              // i++ (consume the low unit)
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
            ],
          },
        ],
      },
      ...bodyAfterCp,
    ];

    // Byte-length contribution of cp (UTF-8 / WTF-8): 1/2/3/4 bytes.
    // <=0x7F → 1; <=0x7FF → 2; <=0xFFFF → 3 (incl. lone surrogates); else 4.
    const cpByteLen = (onResult: Instr[]): Instr[] => [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, ...onResult],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 2 }, ...onResult],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 3 }, ...onResult],
                else: [{ op: "i32.const", value: 4 }, ...onResult],
              },
            ],
          },
        ],
      },
    ];

    // Write cp as UTF-8 bytes into out[o..], advancing o.
    const writeBytes: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // out[o] = cp; o += 1
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "local.get", index: CP },
          { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 2-byte: 0xC0|(cp>>6), 0x80|(cp&0x3F)
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 0xc0 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 6 },
              { op: "i32.shr_u" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 0x80 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: O },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.set", index: O },
            ],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 3-byte: 0xE0|(cp>>12), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xe0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
                else: [
                  // 4-byte: 0xF0|(cp>>18), 0x80|((cp>>12)&0x3F), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xf0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 4 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
              },
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      // off = flat.off, len = flat.len, data = flat.data
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },

      // --- Pass 1: compute byteLen ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: BYTELEN },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len break
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // decode cp (advances i), then byteLen += cpByteLen(cp)
              ...decodeCp(
                cpByteLen([
                  { op: "local.get", index: BYTELEN },
                  { op: "i32.add" },
                  { op: "local.set", index: BYTELEN },
                ]),
              ),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // out = array.new_default $__str_data_u8(byteLen)
      { op: "local.get", index: BYTELEN },
      { op: "array.new_default", typeIdx: ctx.utf8StrDataTypeIdx },
      { op: "local.set", index: OUT },

      // --- Pass 2: write bytes ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: O },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...decodeCp(writeBytes),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return out
      { op: "local.get", index: OUT },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_utf8",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: u8DataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        { name: "cu", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
        { name: "lo", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}
