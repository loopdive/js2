// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType, FuncHandle } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";

function flattenConsBody(
  layout: NativeStringLayout,
  strDataTypeIdx: number,
  strTypeIdx: number,
  anyStrTypeIdx: number,
  copyTreeIdx: FuncHandle,
  emptyLiteralGlobalIndex: number,
): Instr[] {
  const consTypeIdx = layout.consStrTypeIdx;
  // (#3673) Interned "" literal — the memoization writes it into `right`.
  const emptyInstrs: Instr[] = [{ op: "global.get", index: emptyLiteralGlobalIndex }];
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
    ...(layout.hashedStrTypeIdx >= 0
      ? ([
          { op: "i32.const", value: 0 }, // hash: uncomputed
          { op: "i32.const", value: 0 }, // cacheGen: never populated
          { op: "ref.null", typeIdx: -18 }, // cacheOwner
          { op: "ref.null", typeIdx: -18 }, // cacheEntry
          { op: "ref.null", typeIdx: -18 }, // cacheProps (round 21)
          { op: "struct.new", typeIdx: layout.hashedStrTypeIdx },
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
export function buildStringCopyTreeDefinition(
  layout: NativeStringLayout,
  worklistTypeIndex: number,
): { locals: LocalDef[]; body: Instr[] } {
  const { nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx } = layout;
  const wlArrTypeIdx = worklistTypeIndex;
  const wlArrRefNull: ValType = { kind: "ref_null", typeIdx: wlArrTypeIdx };
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
  return {
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
  };
}
export interface StringFlattenResources {
  readonly copyTree: FuncHandle;
  readonly emptyLiteralGlobalIndex: number;
  readonly utf8Decoder: { readonly kind: "absent" } | { readonly kind: "present"; readonly handle: FuncHandle };
}
export function buildStringFlattenDefinition(
  layout: NativeStringLayout,
  resources: StringFlattenResources,
): { locals: LocalDef[]; body: Instr[] } {
  const { nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx, anyStrTypeIdx } = layout;
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const copyTreeIdx = resources.copyTree;
  const utf8ToFlatIdx = resources.utf8Decoder.kind === "present" ? resources.utf8Decoder.handle : undefined;
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
        layout.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined
          ? [
              // #1588 PR-B part 2: if s is a Utf8String, decode it to a NativeString.
              { op: "local.get", index: 0 },
              { op: "ref.test", typeIdx: layout.utf8StrTypeIdx },
              {
                op: "if",
                blockType: { kind: "val", type: flatStrRef },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "ref.cast", typeIdx: layout.utf8StrTypeIdx },
                  { op: "call", funcIdx: utf8ToFlatIdx },
                ],
                else: flattenConsBody(
                  layout,
                  strDataTypeIdx,
                  strTypeIdx,
                  anyStrTypeIdx,
                  copyTreeIdx,
                  resources.emptyLiteralGlobalIndex,
                ),
              },
            ]
          : flattenConsBody(
              layout,
              strDataTypeIdx,
              strTypeIdx,
              anyStrTypeIdx,
              copyTreeIdx,
              resources.emptyLiteralGlobalIndex,
            ),
    },
  ];
  return {
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "buf", type: strDataRef },
      // (#3673) holds the freshly-built flat result across the memoization
      // writeback (flattenConsBody local index 3).
      { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
    ],
    body,
  };
}
