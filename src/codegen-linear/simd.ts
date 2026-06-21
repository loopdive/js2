// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * SIMD-accelerated runtime helpers for linear memory string and array operations.
 *
 * These functions replace scalar loops with WASM SIMD (v128) vectorized operations
 * for significant speedups on string equality, string indexOf, array indexOf,
 * and array fill.
 *
 * String layout: ptr+8 = length (i32), ptr+12 = data (bytes)
 * Array layout:  ptr+8 = length (i32), ptr+12 = capacity (i32), ptr+16 = elements (i32[])
 *
 * All operations process data in 16-byte (128-bit) chunks where possible,
 * with scalar fallback for the remaining bytes/elements.
 */

import type { Instr, LocalDef, ValType, WasmModule } from "../ir/types.js";

/** Find the function index (import count + local index) by name */
function findFuncIndex(mod: WasmModule, name: string): number {
  let numImports = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") numImports++;
  }
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = mod.functions[i];
    if (fn && fn.name === name) {
      return numImports + i;
    }
  }
  throw new Error(`SIMD runtime: function not found: ${name}`);
}

/** Helper to create a v128 constant of all zeros */
function v128Zero(): Instr {
  return { op: "v128.const", bytes: new Uint8Array(16) };
}

/**
 * Add SIMD-accelerated string and array runtime functions.
 * Call this AFTER addStringRuntime / addArrayRuntime so the scalar
 * versions are available as fallbacks and for index lookups.
 */
export function addSimdRuntime(mod: WasmModule): void {
  addSimdStringEquals(mod);
  addSimdStringIndexOf(mod);
  addSimdArrayIndexOfI32(mod);
  addSimdArrayFillI32(mod);
}

/**
 * __str_eq_simd(a: i32, b: i32) → i32
 *
 * SIMD-accelerated string equality.
 * Compares 16 bytes at a time using v128.load + i8x16.eq + i8x16.all_true.
 * Falls back to byte-by-byte for the tail (<16 bytes).
 */
function addSimdStringEquals(mod: WasmModule): void {
  const params: ValType[] = [{ kind: "i32" }, { kind: "i32" }];
  const results: ValType[] = [{ kind: "i32" }];

  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___str_eq_simd", params, results });

  // params: a(0), b(1)
  // locals: lenA(2), i(3), vecA(4:v128), vecB(5:v128)
  const locals: LocalDef[] = [
    { name: "lenA", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "vecA", type: { kind: "v128" } },
    { name: "vecB", type: { kind: "v128" } },
  ];

  const lenA = 2;
  const i = 3;

  const body: Instr[] = [
    // lenA = a.len (ptr+8)
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.set", index: lenA },

    // if lenA != b.len, return 0
    { op: "local.get", index: lenA },
    { op: "local.get", index: 1 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },

    // SIMD loop: compare 16 bytes at a time
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i + 16 > lenA, break to scalar tail
            { op: "local.get", index: i },
            { op: "i32.const", value: 16 },
            { op: "i32.add" },
            { op: "local.get", index: lenA },
            { op: "i32.gt_u" },
            { op: "br_if", depth: 1 },

            // vecA = v128.load(a + 12 + i)
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "v128.load", align: 0, offset: 12 },

            // vecB = v128.load(b + 12 + i)
            { op: "local.get", index: 1 },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "v128.load", align: 0, offset: 12 },

            // if not all bytes equal, return 0
            { op: "i8x16.eq" },
            { op: "i8x16.all_true" },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },

            // i += 16
            { op: "local.get", index: i },
            { op: "i32.const", value: 16 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Scalar tail: compare remaining bytes one at a time
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= lenA, break (equal)
            { op: "local.get", index: i },
            { op: "local.get", index: lenA },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },

            // if a[12+i] != b[12+i], return 0
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 12 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 12 },
            { op: "i32.ne" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },

            // i++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // All bytes matched
    { op: "i32.const", value: 1 },
  ];

  mod.functions.push({
    name: "__str_eq_simd",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}

/**
 * __str_indexOf_simd(haystack: i32, needle: i32, fromIndex: i32) → i32
 *
 * SIMD-accelerated string indexOf using first-byte splatted search.
 * Splats the first byte of needle across a v128, then scans 16 bytes at a time
 * looking for potential match positions. On a hit, does a full byte-by-byte
 * comparison of needle length. Returns -1 if not found.
 */
function addSimdStringIndexOf(mod: WasmModule): void {
  const params: ValType[] = [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }];
  const results: ValType[] = [{ kind: "i32" }];

  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___str_indexOf_simd", params, results });

  // params: haystack(0), needle(1), fromIndex(2)
  // locals: hLen(3), nLen(4), i(5), j(6), firstByte(7), mask(8),
  //         matchVec(9:v128), needleVec(10:v128), pos(11)
  const locals: LocalDef[] = [
    { name: "hLen", type: { kind: "i32" } },
    { name: "nLen", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "j", type: { kind: "i32" } },
    { name: "firstByte", type: { kind: "i32" } },
    { name: "mask", type: { kind: "i32" } },
    { name: "matchVec", type: { kind: "v128" } },
    { name: "needleVec", type: { kind: "v128" } },
    { name: "pos", type: { kind: "i32" } },
  ];

  const hLen = 3,
    nLen = 4,
    i = 5,
    j = 6,
    firstByte = 7,
    mask = 8,
    pos = 11;

  const body: Instr[] = [
    // hLen = haystack.len
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.set", index: hLen },

    // nLen = needle.len
    { op: "local.get", index: 1 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.set", index: nLen },

    // if nLen == 0, return max(fromIndex, 0) clamped to hLen
    { op: "local.get", index: nLen },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // clamp(fromIndex, 0, hLen)
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        { op: "select" },
        { op: "local.tee", index: i },
        { op: "local.get", index: hLen },
        { op: "local.get", index: i },
        { op: "local.get", index: hLen },
        { op: "i32.lt_s" },
        { op: "select" },
        { op: "return" },
      ],
    },

    // if nLen > hLen, return -1
    { op: "local.get", index: nLen },
    { op: "local.get", index: hLen },
    { op: "i32.gt_u" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },

    // firstByte = needle[0] (first byte of needle data)
    { op: "local.get", index: 1 },
    { op: "i32.load8_u", align: 0, offset: 12 },
    { op: "local.set", index: firstByte },

    // needleVec = i8x16.splat(firstByte)
    { op: "local.get", index: firstByte },
    { op: "i8x16.splat" },
    { op: "local.set", index: 10 }, // needleVec

    // i = max(fromIndex, 0)
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
    { op: "local.set", index: i },

    // SIMD scan loop: check 16 bytes at a time for first-byte matches
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i + 16 > hLen, break to scalar fallback
            { op: "local.get", index: i },
            { op: "i32.const", value: 16 },
            { op: "i32.add" },
            { op: "local.get", index: hLen },
            { op: "i32.gt_u" },
            { op: "br_if", depth: 1 },

            // if i > hLen - nLen, break to scalar (can't match)
            { op: "local.get", index: i },
            { op: "local.get", index: hLen },
            { op: "local.get", index: nLen },
            { op: "i32.sub" },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },

            // Load 16 bytes from haystack at position i
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.add" },
            { op: "v128.load", align: 0, offset: 12 },

            // Compare with needleVec (splat of first byte)
            { op: "local.get", index: 10 }, // needleVec
            { op: "i8x16.eq" },

            // Get bitmask of matching lanes
            { op: "i8x16.bitmask" },
            { op: "local.set", index: mask },

            // If no matches in this chunk, skip ahead 16 bytes
            { op: "local.get", index: mask },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: i },
                { op: "i32.const", value: 16 },
                { op: "i32.add" },
                { op: "local.set", index: i },
                { op: "br", depth: 2 }, // continue SIMD loop
              ],
            },

            // Check each matching position in the bitmask
            { op: "i32.const", value: 0 },
            { op: "local.set", index: pos },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    // if pos >= 16, break
                    { op: "local.get", index: pos },
                    { op: "i32.const", value: 16 },
                    { op: "i32.ge_u" },
                    { op: "br_if", depth: 1 },

                    // if !(mask & (1 << pos)), skip this position
                    { op: "local.get", index: mask },
                    { op: "i32.const", value: 1 },
                    { op: "local.get", index: pos },
                    { op: "i32.shl" },
                    { op: "i32.and" },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: pos },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: pos },
                        { op: "br", depth: 2 }, // continue bitmask loop
                      ],
                    },

                    // candidate = i + pos; if candidate + nLen > hLen, skip
                    { op: "local.get", index: i },
                    { op: "local.get", index: pos },
                    { op: "i32.add" },
                    { op: "local.get", index: hLen },
                    { op: "local.get", index: nLen },
                    { op: "i32.sub" },
                    { op: "i32.gt_s" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: pos },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: pos },
                        { op: "br", depth: 2 },
                      ],
                    },

                    // Verify full needle match at haystack[i+pos]
                    { op: "i32.const", value: 1 }, // j = 1 (first byte already matched)
                    { op: "local.set", index: j },
                    {
                      op: "block",
                      blockType: { kind: "empty" },
                      body: [
                        {
                          op: "loop",
                          blockType: { kind: "empty" },
                          body: [
                            // if j >= nLen, full match found!
                            { op: "local.get", index: j },
                            { op: "local.get", index: nLen },
                            { op: "i32.ge_u" },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [
                                // return i + pos
                                { op: "local.get", index: i },
                                { op: "local.get", index: pos },
                                { op: "i32.add" },
                                { op: "return" },
                              ],
                            },

                            // if haystack[12 + i + pos + j] != needle[12 + j], mismatch
                            { op: "local.get", index: 0 },
                            { op: "local.get", index: i },
                            { op: "i32.add" },
                            { op: "local.get", index: pos },
                            { op: "i32.add" },
                            { op: "local.get", index: j },
                            { op: "i32.add" },
                            { op: "i32.load8_u", align: 0, offset: 12 },

                            { op: "local.get", index: 1 },
                            { op: "local.get", index: j },
                            { op: "i32.add" },
                            { op: "i32.load8_u", align: 0, offset: 12 },

                            { op: "i32.ne" },
                            { op: "br_if", depth: 1 }, // break inner verify loop (to block)

                            // j++
                            { op: "local.get", index: j },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: j },
                            { op: "br", depth: 0 },
                          ],
                        },
                      ],
                    },

                    // pos++
                    { op: "local.get", index: pos },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: pos },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },

            // Advance i by 16
            { op: "local.get", index: i },
            { op: "i32.const", value: 16 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Scalar fallback for remaining bytes
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i > hLen - nLen, not found
            { op: "local.get", index: i },
            { op: "local.get", index: hLen },
            { op: "local.get", index: nLen },
            { op: "i32.sub" },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },

            // j = 0; inner compare
            { op: "i32.const", value: 0 },
            { op: "local.set", index: j },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    // if j >= nLen, match found
                    { op: "local.get", index: j },
                    { op: "local.get", index: nLen },
                    { op: "i32.ge_u" },
                    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: i }, { op: "return" }] },

                    // if haystack[12+i+j] != needle[12+j], break
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: i },
                    { op: "i32.add" },
                    { op: "local.get", index: j },
                    { op: "i32.add" },
                    { op: "i32.load8_u", align: 0, offset: 12 },

                    { op: "local.get", index: 1 },
                    { op: "local.get", index: j },
                    { op: "i32.add" },
                    { op: "i32.load8_u", align: 0, offset: 12 },

                    { op: "i32.ne" },
                    { op: "br_if", depth: 1 },

                    // j++
                    { op: "local.get", index: j },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: j },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },

            // i++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // not found
    { op: "i32.const", value: -1 },
  ];

  mod.functions.push({
    name: "__str_indexOf_simd",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}

/**
 * __arr_indexOf_simd(arr: i32, val: f64) → i32
 *
 * SIMD-accelerated number[] array indexOf.
 * #1938: elements are 8-byte f64 slots, so the search value is splatted across
 * an f64x2 and 2 elements are compared per 128-bit chunk (stride 16 bytes).
 * Returns the index of the first match, or -1 if not found.
 * Array layout: ptr+8 = length, ptr+16 = element data (f64[])
 */
function addSimdArrayIndexOfI32(mod: WasmModule): void {
  const params: ValType[] = [{ kind: "i32" }, { kind: "f64" }];
  const results: ValType[] = [{ kind: "i32" }];

  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___arr_indexOf_simd", params, results });

  // params: arr(0), val(1:f64)
  // locals: len(2), i(3), valVec(4:v128), cmpVec(5:v128)
  const locals: LocalDef[] = [
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "valVec", type: { kind: "v128" } },
    { name: "cmpVec", type: { kind: "v128" } },
  ];

  const len = 2,
    i = 3,
    cmpVec = 5;

  const body: Instr[] = [
    // len = arr.len
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "local.set", index: len },

    // valVec = f64x2.splat(val)
    { op: "local.get", index: 1 },
    { op: "f64x2.splat" },
    { op: "local.set", index: 4 }, // valVec

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },

    // SIMD loop: compare 2 elements at a time (f64x2)
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i + 2 > len, break to scalar
            { op: "local.get", index: i },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.get", index: len },
            { op: "i32.gt_u" },
            { op: "br_if", depth: 1 },

            // Load 2 elements: v128.load(arr + 16 + i*8)
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.const", value: 8 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "v128.load", align: 3, offset: 16 },

            // cmpVec = f64x2.eq(loaded, valVec) — matching lanes become all-1s
            { op: "local.get", index: 4 }, // valVec
            { op: "f64x2.eq" },
            { op: "local.set", index: cmpVec },

            // lane 0 match? (i64x2.extract_lane 0 != 0)
            { op: "local.get", index: cmpVec },
            { op: "i64x2.extract_lane", lane: 0 },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: i }, { op: "return" }] },

            // lane 1 match? (i64x2.extract_lane 1 != 0)
            { op: "local.get", index: cmpVec },
            { op: "i64x2.extract_lane", lane: 1 },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: i }, { op: "i32.const", value: 1 }, { op: "i32.add" }, { op: "return" }],
            },

            // i += 2
            { op: "local.get", index: i },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Scalar tail
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= len, not found
            { op: "local.get", index: i },
            { op: "local.get", index: len },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },

            // if arr[16 + i*8] == val, return i
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.const", value: 8 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "f64.load", align: 3, offset: 16 },
            { op: "local.get", index: 1 },
            { op: "f64.eq" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: i }, { op: "return" }] },

            // i++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // not found
    { op: "i32.const", value: -1 },
  ];

  mod.functions.push({
    name: "__arr_indexOf_simd",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}

/**
 * __arr_fill_simd(arr: i32, val: f64, start: i32, end: i32) → void
 *
 * SIMD-accelerated number[] array fill.
 * #1938: elements are 8-byte f64 slots, so the fill value is splatted across an
 * f64x2 and 2 elements are stored per 128-bit chunk (stride 16 bytes). Falls
 * back to scalar for the tail.
 * Array layout: ptr+16 = element data (f64[])
 */
function addSimdArrayFillI32(mod: WasmModule): void {
  const params: ValType[] = [
    { kind: "i32" }, // arr
    { kind: "f64" }, // val
    { kind: "i32" }, // start
    { kind: "i32" }, // end
  ];
  const results: ValType[] = [];

  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___arr_fill_simd", params, results });

  // params: arr(0), val(1), start(2), end(3)
  // locals: i(4), fillVec(5:v128)
  const locals: LocalDef[] = [
    { name: "i", type: { kind: "i32" } },
    { name: "fillVec", type: { kind: "v128" } },
  ];

  const i = 4;

  const body: Instr[] = [
    // fillVec = f64x2.splat(val)
    { op: "local.get", index: 1 },
    { op: "f64x2.splat" },
    { op: "local.set", index: 5 }, // fillVec

    // i = start
    { op: "local.get", index: 2 },
    { op: "local.set", index: i },

    // SIMD loop: store 2 elements at a time (f64x2)
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i + 2 > end, break to scalar
            { op: "local.get", index: i },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.get", index: 3 }, // end
            { op: "i32.gt_u" },
            { op: "br_if", depth: 1 },

            // v128.store(arr + 16 + i*8, fillVec)
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.const", value: 8 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.get", index: 5 }, // fillVec
            { op: "v128.store", align: 3, offset: 16 },

            // i += 2
            { op: "local.get", index: i },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Scalar tail
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= end, done
            { op: "local.get", index: i },
            { op: "local.get", index: 3 }, // end
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },

            // arr[16 + i*8] = val (f64 slot)
            { op: "local.get", index: 0 },
            { op: "local.get", index: i },
            { op: "i32.const", value: 8 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.get", index: 1 }, // val (f64)
            { op: "f64.store", align: 3, offset: 16 },

            // i++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  mod.functions.push({
    name: "__arr_fill_simd",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}
