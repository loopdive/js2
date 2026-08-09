// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — case transforms (#3182 Wave B, slice 1).
 *
 * Extracted verbatim from the tail of `ensureNativeStringHelpers` in
 * `native-strings.ts` (which had grown to ~4.8k LOC). This module emits the
 * case mapping (`toLowerCase`/`toUpperCase`, the full-Unicode
 * `emitNativeCaseConversion`, and `isWellFormed`/`toWellFormed`).
 *
 * (#3256) The length-shaping methods that used to live here (`repeat`,
 * `padStart`, `padEnd`) are SELF-HOSTED now: TS source in
 * src/stdlib/strings.ts compiled through the compiler's own IR pipeline
 * (see native-strings-selfhost.ts), with the legacy i32 ABIs preserved by
 * hand thunks.
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
import { emitNativeCaseConversion } from "./case-convert-native.js";
import { emitNativeWellFormedHelpers } from "./wellformed-native.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/**
 * Case-mapping methods: the ASCII `toLowerCase`/`toUpperCase` blocks, then
 * the full-Unicode case mapping (`emitNativeCaseConversion`, which re-points the
 * public names) and the `isWellFormed`/`toWellFormed` helpers.
 */
export function emitStrCaseHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  // --- $__str_toLowerCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps A-Z (65-90) to a-z (97-122), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toLowerCase", funcIdx);
    // Retain an explicit handle after the public name is re-pointed at the
    // full-Unicode helper below. Proven-ASCII call sites can safely use this
    // compact implementation without paying for the Unicode bail-out path.
    ctx.nativeStrHelpers.set("__str_toLowerCase_ascii", funcIdx);
    ctx.funcMap.set("__str_toLowerCase_ascii", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop over each code unit
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 65 && ch <= 90) ? ch + 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 65 },
              { op: "i32.sub" },
              { op: "i32.const", value: 25 },
              { op: "i32.le_u" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.add" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toLowerCase_ascii",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_toUpperCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps a-z (97-122) to A-Z (65-90), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toUpperCase", funcIdx);
    ctx.nativeStrHelpers.set("__str_toUpperCase_ascii", funcIdx);
    ctx.funcMap.set("__str_toUpperCase_ascii", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 97 && ch <= 122) ? ch - 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 97 },
              { op: "i32.sub" },
              { op: "i32.const", value: 25 },
              { op: "i32.le_u" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.sub" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toUpperCase_ascii",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // (#40) Replace the ASCII-only toUpperCase/toLowerCase above with full Unicode
  // simple + special (1:N) case mapping. emitNativeCaseConversion appends the
  // Unicode helpers and re-points the public `__str_to{Upper,Lower}Case` names in
  // nativeStrHelpers at them (the ASCII blocks become dead, wasm-opt drops them).
  // Emitted here, AFTER __str_flatten is registered, so the Unicode helpers can
  // flatten a cons-string input.
  emitNativeCaseConversion(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);

  // (#3068) String.prototype.isWellFormed / toWellFormed — pure UTF-16
  // code-unit scans over the flattened NativeString. Emitted here (after
  // __str_flatten + the NativeString types exist) so the method arms in
  // string-ops.ts find `__str_isWellFormed` / `__str_toWellFormed` in
  // nativeStrHelpers without a mid-body late-import shift.
  emitNativeWellFormedHelpers(ctx, strTypeIdx, strDataTypeIdx);
}
