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
import type { WasmFunction } from "../wasm/model/module-records.js";
import {
  buildStringCopyTreeDefinition,
  buildStringFlattenDefinition,
  type StringFlattenResources,
} from "../runtime/wasmgc/values/string-flatten-bodies.js";
import { buildStringUtf8ToFlatDefinition } from "../runtime/wasmgc/values/string-utf8-decode-bodies.js";
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

/**
 * Rope flattening: `__str_copy_tree` (iterative rope→buffer copy),
 * `__str_utf8_to_flat` (UTF-8 decode) and `__str_flatten` (AnyString→NativeString).
 */
export function emitStrFlattenHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx, strRef, flatStrRef, strDataRef } = shared;
  let copyTreeFunction: WasmFunction;
  let copyTreeWorklistType: number;
  let utf8Decoder: StringFlattenResources["utf8Decoder"] = { kind: "absent" };

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

    // Reserve the actual function object in its historical slot. It is pending,
    // not executable, until the optional decoder has been registered below.
    copyTreeWorklistType = wlArrTypeIdx;
    copyTreeFunction = {
      name: "__str_copy_tree",
      typeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, copyTreeFunction);
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
    const definition = buildStringUtf8ToFlatDefinition(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_utf8_to_flat",
      typeIdx,
      locals: definition.locals,
      body: definition.body,
      exported: false,
    });
    utf8Decoder = { kind: "present", handle: funcIdx };
  }

  // Fill the same pushed object once, using only the decoder minted above.
  // A decoder construction failure propagates before any completion is claimed.
  const copyTreeDefinition = buildStringCopyTreeDefinition(ctx, copyTreeWorklistType, utf8Decoder);
  copyTreeFunction.locals = copyTreeDefinition.locals;
  copyTreeFunction.body = copyTreeDefinition.body;

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

    // params: s(0)
    // locals: len(1), buf(2)
    const emptyInstrs = nativeStringLiteralInstrs(ctx, "");
    if (emptyInstrs.length !== 1 || emptyInstrs[0]?.op !== "global.get")
      throw new Error("native string flatten: empty literal must be a global");
    const definition = buildStringFlattenDefinition(ctx, {
      copyTree: copyTreeIdx,
      emptyLiteralGlobalIndex: emptyInstrs[0].index,
      utf8Decoder,
    });

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_flatten",
      typeIdx,
      locals: definition.locals,
      body: definition.body,
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
