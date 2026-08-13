// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — concat, comparison, slice & char access (#3182 Wave B, slice 2).
 *
 * Extracted verbatim from the head of `ensureNativeStringHelpers` in
 * `native-strings.ts`. This module emits the fundamental value operations: concatenation (`__str_concat`,
 * `__str_buf_next_cap`), ordering/equality (`__str_equals`, `__str_compare`) and
 * substring/character access (`__str_substring`, `__str_charAt`, `__str_charAt_cp`,
 * `__str_slice`, `__str_substr`).
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
import type { Instr } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { lazyStrFlattenEnabled, relocatedFlattenPreamble } from "./lazy-str-flatten.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * Concatenation: `__str_concat` (builds a ConsString) and the
 * `__str_buf_next_cap` growth helper.
 */
export function emitStrConcatHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx, strRef } = shared;

  // --- $__str_concat(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString ---
  // For short strings (combined length < 64), copies into a flat string.
  // For longer strings, creates a ConsString node in O(1).
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_concat", funcIdx);

    // params: a(0), b(1)
    // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
    const body: Instr[] = [
      // lenA = a.len (field 0 of AnyString)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // lenA

      // lenB = b.len (field 0 of AnyString)
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // lenB

      // Empty strings are the identity element for concatenation. Returning
      // the other immutable string directly avoids allocating and copying a
      // fresh flat string for common accumulator shapes such as
      // `let out = ""; out += value`. Keep a compile-time kill switch so the
      // optimization can be measured against the identical compiler tree.
      ...(process.env.JS2WASM_STR_CONCAT_EMPTY_IDENTITY === "0"
        ? []
        : [
            { op: "local.get" as const, index: 2 },
            { op: "i32.eqz" as const },
            {
              op: "if" as const,
              blockType: { kind: "empty" as const },
              then: [{ op: "local.get" as const, index: 1 }, { op: "return" as const }],
            },
            { op: "local.get" as const, index: 3 },
            { op: "i32.eqz" as const },
            {
              op: "if" as const,
              blockType: { kind: "empty" as const },
              then: [{ op: "local.get" as const, index: 0 }, { op: "return" as const }],
            },
          ]),

      // newLen = lenA + lenB
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 4 }, // newLen

      // if newLen >= 64, create ConsString (O(1) rope node)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 64 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // struct.new $ConsString(newLen, a, b)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "local.get", index: 0 }, // left = a
          { op: "local.get", index: 1 }, // right = b
          { op: "struct.new", typeIdx: consStrTypeIdx },
        ],
        else: [
          // Short string: flatten both sides and copy
          // flatA = flatten(a)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 6 },

          // flatB = flatten(b)
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 7 },

          // newArr = array.new_default(newLen)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 }, // dstOffset
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
          { op: "local.get", index: 2 }, // lenA
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 }, // dstOffset = lenA
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
          { op: "local.get", index: 3 }, // lenB
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // result = struct.new $NativeString(newLen, 0, newArr)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "i32.const", value: 0 }, // off = 0
          { op: "local.get", index: 5 }, // data = newArr
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_concat",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_buf_next_cap(curCap: i32, needed: i32) -> i32 ---
  // Returns a capacity at least as large as `needed`, doubling `curCap` until
  // the requirement is met. Used by the #1210 string-builder rewrite to size
  // the growable i16 buffer with O(log N) reallocations instead of O(N) per
  // `s += <expr>`. If `needed` exceeds INT32 doubling, returns `needed`
  // directly (caller traps on out-of-memory at the array.new_default site).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_buf_next_cap", funcIdx);

    // params: curCap(0), needed(1)
    // Strategy: ensure at least 16 bytes, then double until >= needed.
    const body: Instr[] = [
      // if curCap < 16 then curCap = 16 (ensures starting size)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 16 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 16 },
          { op: "local.set", index: 0 },
        ],
      },
      // while (curCap < needed) curCap = curCap * 2
      // block { loop { if (curCap >= needed) br outer; curCap *= 2; br inner } }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if curCap >= needed: br outer (depth 1)
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // curCap *= 2
              { op: "local.get", index: 0 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.set", index: 0 },
              // restart loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return curCap
      { op: "local.get", index: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_buf_next_cap",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  emitStrConcatOwnedHelper(shared);
}

/**
 * `__str_concat_owned` — IR-only owned-append fast path (#3740 / #3744),
 * called by `string.concat` in `owned-append` mode (`ir/integration.ts`; shape
 * license in `src/ir/string-builder-shape.ts`). Split out of
 * `emitStrConcatHelpers` for the #3400 per-function LOC ceiling; emission
 * order (and thus every minted funcIdx) is unchanged — this runs as that
 * builder's final step.
 */
function emitStrConcatOwnedHelper(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef } = shared;

  // --- $__str_concat_owned(lhs: ref $AnyString, rhs: ref $AnyString) -> ref $AnyString ---
  // (#3740 follow-up) IR-only fast path for a `string.concat` whose LHS is
  // proven "owned-append" — the caller (`ir/from-ast.ts`'s
  // `collectOwnedStringAppendSymbols`) has established that `lhs`'s PRIOR
  // value is never observed again once this call returns, i.e. exactly the
  // `let s = ""; for (...) s += <expr>` builder-loop shape. That license lets
  // this helper grow `lhs`'s backing array in place (geometric doubling via
  // `__str_buf_next_cap`, matching the legacy #1210/#1761 string-builder
  // rewrite) instead of always allocating+copying a full fresh array the way
  // the general-purpose `__str_concat` does. The RESULT is still an ordinary,
  // fully valid `$NativeString` — every existing consumer (length, charAt,
  // equality, return, ...) works unchanged; only the growth strategy differs.
  //
  // Safety argument for "grow lhs's array in place": lhs is always either the
  // empty-string literal (capacity 0 — always takes the grow-a-fresh-array
  // branch below on the first append) or this same helper's own prior result
  // (a data array WE allocated ourselves via `__str_buf_next_cap`, never
  // shared with an interned literal or any other value). Any earlier struct
  // wrapper over that same array only ever reads indices below ITS OWN
  // recorded `len`, so writing into cells at `[lhsLen, newLen)` — strictly
  // past every earlier wrapper's own length — never changes what an earlier
  // observer would see. The in-place branch is additionally gated on
  // `lhsOff === 0` so a genuine sliced/offset view (not something this
  // builder chain produces, but defensive) always falls through to the copy
  // path instead.
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const nextCapIdx = ctx.nativeStrHelpers.get("__str_buf_next_cap")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_concat_owned", funcIdx);

    // params: lhs(0), rhs(1)
    // locals: flatLhs(2), flatRhs(3), lhsLen(4), rhsLen(5), newLen(6),
    //         lhsOff(7), data(8), cap(9), newData(10)
    const body: Instr[] = [
      // flatLhs = __str_flatten(lhs)  (cheap ref.test+ref.cast identity when
      // lhs is already flat, which it always is for this call's callers)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: 2 },

      // flatRhs = __str_flatten(rhs)
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: 3 },

      // lhsLen = flatLhs.len
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // rhsLen = flatRhs.len
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 5 },

      // newLen = lhsLen + rhsLen
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
      { op: "i32.add" },
      { op: "local.set", index: 6 },

      // lhsOff = flatLhs.off
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // data = flatLhs.data
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },

      // cap = array.len(data)
      { op: "local.get", index: 8 },
      { op: "ref.as_non_null" },
      { op: "array.len" },
      { op: "local.set", index: 9 },

      // if (cap >= newLen) && (lhsOff == 0)
      { op: "local.get", index: 9 },
      { op: "local.get", index: 6 },
      { op: "i32.ge_s" },
      { op: "local.get", index: 7 },
      { op: "i32.eqz" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // in-place append: array.copy(data, lhsLen, flatRhs.data, flatRhs.off, rhsLen)
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 5 },
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // result = struct.new $NativeString(newLen, 0, data)
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // newCap = __str_buf_next_cap(cap, newLen)
          { op: "local.get", index: 9 },
          { op: "local.get", index: 6 },
          { op: "call", funcIdx: nextCapIdx },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 10 },

          // array.copy(newData, 0, data, lhsOff, lhsLen)
          { op: "local.get", index: 10 },
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 7 },
          { op: "local.get", index: 4 },
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // array.copy(newData, lhsLen, flatRhs.data, flatRhs.off, rhsLen)
          { op: "local.get", index: 10 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 5 },
          { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },

          // result = struct.new $NativeString(newLen, 0, newData)
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 10 },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_concat_owned",
      typeIdx,
      locals: [
        { name: "flatLhs", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatRhs", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "lhsLen", type: { kind: "i32" } },
        { name: "rhsLen", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "lhsOff", type: { kind: "i32" } },
        { name: "data", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "cap", type: { kind: "i32" } },
        { name: "newData", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      ],
      body,
      exported: false,
    });
  }
}

/**
 * Ordering & equality: `__str_equals`, `__str_compare` (UTF-16 code-unit order).
 */
export function emitStrCompareHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, strRef, strDataRef, getFlattenIdx, wrapBodyWithFlatten } =
    shared;

  // --- $__str_equals(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  {
    // (#4157) OFF: `wrapBodyWithFlatten([0, 1])` materializes BOTH operands at
    // the top of the function, ahead of three answers that need no flat buffer.
    // ON: `relocatedFlattenPreamble` emits the SAME guarded preamble further
    // down (just before the character loop), and the length compare reads
    // `$AnyString` field 0. See `lazy-str-flatten.ts`.
    const lazy = lazyStrFlattenEnabled();
    const lenTypeIdx = lazy ? anyStrTypeIdx : strTypeIdx;
    const lazyFlattenPreamble = relocatedFlattenPreamble(lazy, strTypeIdx, getFlattenIdx, [0, 1]);
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_equals", funcIdx);

    // locals: len(2), i(3), aData(4), bData(5), aOff(6), bOff(7)
    const body: Instr[] = [
      // (#3673) identity fast path: same ref → equal. Literal interning gives
      // every literal site one shared struct, so comparisons against the same
      // interned literal (property-name probes, keyword checks) exit here
      // without touching the character data.
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // len = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: lenTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // len

      // if a.len != b.len return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: lenTypeIdx, fieldIdx: 0 },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },

      // (#3673 round 9) Hash fast-reject: when BOTH sides are `$HashedString`
      // with computed hashes (interned literals bake theirs at compile time)
      // and the hashes differ, the strings cannot be equal — O(1) instead of
      // the char loop. Equal hashes (match or collision) fall through to the
      // authoritative char compare. The `__extern_get` member-ladder arms
      // compare an interned probe key against interned field-name constants
      // bucketed by length + first char, so this reject does the real work.
      ...(ctx.hashedStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 0 },
            { op: "ref.test", typeIdx: ctx.hashedStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.test", typeIdx: ctx.hashedStrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 0 },
                    { op: "ref.cast", typeIdx: ctx.hashedStrTypeIdx },
                    { op: "struct.get", typeIdx: ctx.hashedStrTypeIdx, fieldIdx: 3 },
                    { op: "local.tee", index: 8 },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: 1 },
                        { op: "ref.cast", typeIdx: ctx.hashedStrTypeIdx },
                        { op: "struct.get", typeIdx: ctx.hashedStrTypeIdx, fieldIdx: 3 },
                        { op: "local.tee", index: 9 },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: 8 },
                            { op: "local.get", index: 9 },
                            { op: "i32.ne" },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ] satisfies Instr[])
        : []),

      // (#4157) Everything above answered without a flat buffer; the loop below
      // is the first consumer of `off`/`data`.
      ...lazyFlattenPreamble,

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 4 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (strings are equal)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // if aData[aOff + i] != bData[bOff + i], return 0
              { op: "local.get", index: 4 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },

              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return 1 (equal)
      { op: "i32.const", value: 1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_equals",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        // (#3673 round 9) hash fast-reject scratch (locals 8/9).
        { name: "aHash", type: { kind: "i32" } },
        { name: "bHash", type: { kind: "i32" } },
      ],
      // (#4157) Under the flag the preamble is already spliced into `body`, so
      // no params are declared here — the wrapper still runs for its second
      // job, inserting `ref.cast $NativeString` before each `struct.get`.
      body: wrapBodyWithFlatten(body, lazy ? [] : [0, 1]),
      exported: false,
    });
  }

  // --- $__str_compare(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  // Lexicographic comparison: returns -1 (a < b), 0 (a == b), or 1 (a > b)
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_compare", funcIdx);

    // locals: lenA(2), lenB(3), minLen(4), i(5), aData(6), bData(7), aOff(8), bOff(9), ca(10), cb(11)
    const body: Instr[] = [
      // lenA = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // lenB = b.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // minLen = min(lenA, lenB)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "local.set", index: 4 },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= minLen, break (common prefix is equal)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ca = aData[aOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 10 },

              // cb = bData[bOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 11 },

              // if ca < cb return -1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },

              // if ca > cb return 1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
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

      // Common prefix is equal; compare by length
      // if lenA < lenB return -1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },

      // if lenA > lenB return 1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },

      // return 0 (equal)
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_compare",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "minLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        { name: "ca", type: { kind: "i32" } },
        { name: "cb", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }
}

/**
 * Substring & character access: `__str_substring`, `__str_charAt`,
 * `__str_charAt_cp` (code-point), `__str_slice`, `__str_substr`.
 */
export function emitStrSliceCharHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, wrapBodyWithFlatten } = shared;

  // --- $__str_substring(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substring", funcIdx);

    // O(1) substring: creates a view sharing the backing array.
    // locals: sOff(3), sLen(4)
    const body: Instr[] = [
      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // Clamp start: max(0, min(start, sLen))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 1 }, // start = max(0, start)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 1 }, // start = min(start, sLen)

      // Clamp end: max(0, min(end, sLen))
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 2 }, // end = max(0, end)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 }, // end = min(end, sLen)

      // Swap if start > end (JS substring semantics)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.set", index: 2 },
          { op: "local.set", index: 1 },
        ],
      },

      // struct.new(len = end - start, off = sOff + start, s.data)
      { op: "local.get", index: 2 }, // end
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len = end - start
      { op: "local.get", index: 3 }, // sOff
      { op: "local.get", index: 1 }, // start
      { op: "i32.add" }, // off = sOff + start
      { op: "local.get", index: 0 }, // s
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // s.data
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substring",
      typeIdx,
      locals: [
        { name: "sOff", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt", funcIdx);

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: off=0, len=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // Single-char string: len=1, off=0, [char]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.get", index: 1 },
          { op: "i32.add" }, // off + idx
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // Create single-element array
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt_cp(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  // (#1470) Code-POINT charAt: like __str_charAt but when the code unit at
  // `idx` is a high surrogate followed by a low surrogate, returns the whole
  // 2-code-unit pair (§22.1.5.1 String iteration / §11.1.4 CodePointAt).
  // Lone surrogates and BMP scalars return the single unit. Used by the
  // for-of / spread / Array.from string-iteration lowerings; callers advance
  // their cursor by the returned string's `len`.
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt_cp", funcIdx);
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // __str_substring(s, idx, idx + 1 + isPair)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          // isPair = (data[off+idx] & 0xFC00) == 0xD800 && idx + 1 < len
          //          && (data[off+idx+1] & 0xFC00) == 0xDC00
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
          { op: "local.get", index: 1 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.const", value: 0xfc00 },
          { op: "i32.and" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // .len
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              // The low-surrogate read is guarded: only reached when
              // idx + 1 < len, so data[off+idx+1] is in bounds.
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.const", value: 0xfc00 },
              { op: "i32.and" },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
          { op: "i32.add" }, // end = idx + 1 + isPair
          { op: "call", funcIdx: substringIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt_cp",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_slice(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  // Like substring but handles negative indices
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_slice", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = len + start
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" },
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to >= 0
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 1 },
        ],
      },

      // Resolve negative end: if end < 0, end = len + end
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 2 }, // end (negative)
          { op: "i32.add" },
          { op: "local.set", index: 2 },
        ],
      },
      // Clamp end to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // §22.1.3.21 String.prototype.slice: unlike substring, slice does NOT
      // swap when start > end — it returns the empty string. __str_substring
      // swaps, so guard here: if (start >= end) return "" instead of
      // delegating. (#2123)
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // end
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty backing array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // start < end: __str_substring clamps to len; no swap occurs.
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: substringIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_slice",
      typeIdx,
      locals: [{ name: "len", type: { kind: "i32" } }],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_substr(s: ref $NativeString, start: i32, length: i32) -> ref $NativeString ---
  // Annex B §B.2.2.1 String.prototype.substr(start, length):
  //   len = s.length
  //   if start < 0: start = max(len + start, 0)   (negative counts from end)
  //   length = max(min(length, len - start), 0)   (clamp; absent → len sentinel)
  //   return substring(start, start + length)
  // Unlike `substring`/`slice`, the SECOND argument is a *count*, not an end
  // index, and is never negative-relative. The caller passes 0x7fffffff for an
  // absent length so the min() clamps it to `len - start` (to the end).
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substr", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = max(len + start, 0)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" }, // len + start
          { op: "local.set", index: 1 }, // start = len + start
          // max(start, 0): (start < 0) ? 0 : start
          { op: "i32.const", value: 0 }, // a = 0
          { op: "local.get", index: 1 }, // b = start
          { op: "local.get", index: 1 }, // start
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" }, // c = (start < 0)
          { op: "select" }, // c ? 0 : start
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to <= len (a start past the end yields the empty string).
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "local.set", index: 1 },
        ],
      },

      // tail = len - start (chars available from `start` to the end)
      { op: "local.get", index: 3 }, // len
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len - start
      { op: "local.set", index: 4 }, // tail = len - start
      // length = min(length, tail): (length < tail) ? length : tail
      { op: "local.get", index: 2 }, // a = length
      { op: "local.get", index: 4 }, // b = tail
      { op: "local.get", index: 2 }, // length
      { op: "local.get", index: 4 }, // tail
      { op: "i32.lt_s" }, // c = (length < tail)
      { op: "select" }, // c ? length : tail
      { op: "local.set", index: 2 }, // length = min(length, tail)
      // Clamp length to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // return __str_substring(s, start, start + length)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // length
      { op: "i32.add" }, // end = start + length
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substr",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "tail", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }
}
