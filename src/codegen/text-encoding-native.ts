// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native (standalone / no-JS-host) TextEncoder / TextDecoder UTF-8 runtime
 * helpers — the WasmGC `encodeInto` result struct plus the
 * `__textencoder_encode` / `__textdecoder_decode_u8` runtime functions.
 *
 * Extracted verbatim from codegen/native-strings.ts (#3263, subtask of #3182).
 * Pure move, no logic changes: `ensureTextEncodingHelpers` first calls
 * `ensureNativeStringHelpers` (imported from ./native-strings.js) to guarantee
 * the native string runtime types exist, then registers the encode/decode
 * helpers on demand. `ensureNativeStringHelpers` does not call back into this
 * module, so there is no import cycle.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { typedArrayVecStorage } from "./index.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";

/**
 * (#1780) Register the WasmGC struct backing `TextEncoder.encodeInto`'s
 * `{ read, written }` result. Registered under the lib.dom.d.ts interface name
 * `TextEncoderEncodeIntoResult` so that member access on the call result
 * (`r.read`, `r.written`) resolves to this struct via `resolveStructName`
 * (which keys on `tsType.symbol?.name`). Both fields are JS numbers → f64.
 */
function ensureEncodeIntoResultStruct(ctx: CodegenContext): number {
  const name = "TextEncoderEncodeIntoResult";
  const existing = ctx.structMap.get(name);
  if (existing !== undefined) return existing;

  const fields = [
    { name: "read", type: { kind: "f64" as const }, mutable: false },
    { name: "written", type: { kind: "f64" as const }, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  // superTypeIdx: -1 emits the struct as a `(sub (struct …))` with no supertype,
  // giving it a distinct nominal identity. A plain `(struct f64 f64)` would get
  // canonical structural identity and could be merged/aliased with another
  // structurally-identical two-f64 struct, breaking `struct.new`/field access by
  // type-index (mirrors the vec-type pattern in registry/types.ts).
  ctx.mod.types.push({ kind: "struct", name, fields, superTypeIdx: -1 });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

/**
 * (#6714) The encode-result / decode-argument carrier is whatever `Uint8Array`
 * lowers to in this compilation (`typedArrayVecStorage`): the packed-`i8`
 * `$__vec_i8_byte` (the `final`-branded TypedArray carrier, #5349) under
 * standalone/WASI — the backing `new Uint8Array` / `fromHex` / `fromBase64` /
 * `toHex` use — and `$__vec_f64` elsewhere. Before #6714 it was hard-wired to
 * `$__vec_f64`, so under standalone an encode result flowing through a slot
 * typed `Uint8Array` (a closure's declared result, a parameter) was an invalid
 * module: `expected (ref null $__vec_i8_byte), got (ref null $__vec_f64)`
 * (axios `lib/adapters/fetch.js`). The `f64` arm keeps the pre-#6714 bytes.
 */
function uint8Carrier(ctx: CodegenContext): {
  packed: boolean;
  vecTypeIdx: number;
} {
  const storage = typedArrayVecStorage(ctx, "Uint8Array");
  return {
    packed: storage.type.kind === "i8",
    vecTypeIdx: getOrRegisterVecType(ctx, storage.key, storage.type),
  };
}

/** i32 byte -> element conversion before `array.set` (a packed `i8` set truncates itself). */
function byteStoreConversion(packed: boolean): Instr[] {
  return packed ? [] : [{ op: "f64.convert_i32_u" }];
}

/** `array.get` of one byte as an unsigned i32 in 0..255. */
function byteLoad(packed: boolean, arrTypeIdx: number): Instr[] {
  if (packed) return [{ op: "array.get_u", typeIdx: arrTypeIdx }];
  return [
    { op: "array.get", typeIdx: arrTypeIdx },
    { op: "i32.trunc_sat_f64_u" },
    { op: "i32.const", value: 0xff },
    { op: "i32.and" },
  ];
}

/**
 * Scratch capacity from the UTF-16 length on the stack. Packed: worst case 3
 * UTF-8 bytes per UTF-16 unit (a surrogate pair is 2 units -> 4 bytes; a lone
 * surrogate is 1 unit -> U+FFFD, 3 bytes).
 */
function encodeScratchCapacity(packed: boolean): Instr[] {
  return packed
    ? [{ op: "i32.const", value: 3 }, { op: "i32.mul" }]
    : [{ op: "i32.const", value: 2 }, { op: "i32.shl" }];
}

/**
 * Packed carrier: trim the worst-case scratch buffer to the exact byte length
 * so `.buffer.byteLength` and every `array.len`-based consumer see the encoded
 * length (as `fromBase64` does). Leaves the trimmed array in `outLocal`.
 */
function trimEncodeOutput(
  packed: boolean,
  arrTypeIdx: number,
  lenLocal: number,
  outLocal: number,
  finalLocal: number,
): Instr[] {
  if (!packed) return [];
  return [
    { op: "local.get", index: lenLocal },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: finalLocal },
    { op: "local.get", index: finalLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: outLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: lenLocal },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    { op: "local.get", index: finalLocal },
    { op: "local.set", index: outLocal },
  ];
}

export function ensureTextEncodingHelpers(ctx: CodegenContext): {
  encodeIdx: number;
  decodeU8Idx: number;
  vecTypeIdx: number;
  resultTypeIdx: number;
} {
  ensureNativeStringHelpers(ctx);

  const existingEncode = ctx.funcMap.get("__textencoder_encode");
  const existingDecode = ctx.funcMap.get("__textdecoder_decode_u8");
  const { packed, vecTypeIdx } = uint8Carrier(ctx);
  const vecArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const resultTypeIdx = ensureEncodeIntoResultStruct(ctx);
  if (existingEncode !== undefined && existingDecode !== undefined) {
    return {
      encodeIdx: existingEncode,
      decodeU8Idx: existingDecode,
      vecTypeIdx,
      resultTypeIdx,
    };
  }

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (strTypeIdx < 0 || anyStrTypeIdx < 0 || strDataTypeIdx < 0 || vecArrTypeIdx < 0) {
    throw new Error("TextEncoder/TextDecoder require native string and Uint8Array runtime types");
  }

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const vecRef: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const vecNonNullRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };
  const vecArrRef: ValType = { kind: "ref", typeIdx: vecArrTypeIdx };
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten")!;

  if (existingEncode === undefined) {
    const typeIdx = addFuncType(ctx, [strRef], [vecRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__textencoder_encode", funcIdx);
    ctx.funcMap.set("__textencoder_encode", funcIdx);

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
    const FINAL = 12;

    const writeByte = (valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: OUT },
      { op: "local.get", index: O },
      ...valueInstrs,
      ...byteStoreConversion(packed),
      { op: "array.set", typeIdx: vecArrTypeIdx },
      { op: "local.get", index: O },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: O },
    ];

    const writeCodePoint: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: writeByte([{ op: "local.get", index: CP }]),
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...writeByte([
                { op: "i32.const", value: 0xc0 },
                { op: "local.get", index: CP },
                { op: "i32.const", value: 6 },
                { op: "i32.shr_u" },
                { op: "i32.or" },
              ]),
              ...writeByte([
                { op: "i32.const", value: 0x80 },
                { op: "local.get", index: CP },
                { op: "i32.const", value: 0x3f },
                { op: "i32.and" },
                { op: "i32.or" },
              ]),
            ],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...writeByte([
                    { op: "i32.const", value: 0xe0 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 12 },
                    { op: "i32.shr_u" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 6 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                ],
                else: [
                  ...writeByte([
                    { op: "i32.const", value: 0xf0 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 18 },
                    { op: "i32.shr_u" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 12 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 6 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                ],
              },
            ],
          },
        ],
      },
    ];

    const decodeCodePoint: Instr[] = [
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      { op: "local.get", index: CU },
      { op: "local.set", index: CP },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: I },
          { op: "local.get", index: LEN },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: LO },
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
                  { op: "local.get", index: I },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: I },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
            else: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
        else: [
          { op: "local.get", index: CU },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: CU },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
      },
      ...writeCodePoint,
    ];

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: LEN },
      ...encodeScratchCapacity(packed),
      { op: "array.new_default", typeIdx: vecArrTypeIdx },
      { op: "local.set", index: OUT },
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
              ...decodeCodePoint,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...trimEncodeOutput(packed, vecArrTypeIdx, O, OUT, FINAL),
      { op: "local.get", index: O },
      { op: "local.get", index: OUT },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__textencoder_encode",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: vecArrRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "maxByteLen", type: { kind: "i32" } },
        { name: "cu", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
        { name: "lo", type: { kind: "i32" } },
        ...(packed ? [{ name: "final", type: vecArrRef }] : []),
      ],
      body,
      exported: false,
    });
  }

  if (existingDecode === undefined) {
    const typeIdx = addFuncType(ctx, [vecRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__textdecoder_decode_u8", funcIdx);
    ctx.funcMap.set("__textdecoder_decode_u8", funcIdx);

    const SRC = 1;
    const LEN = 2;
    const DATA = 3;
    const OUT = 4;
    const I = 5;
    const O = 6;
    const B0 = 7;
    const B1 = 8;
    const B2 = 9;
    const B3 = 10;
    const CP = 11;

    const readByteTo = (local: number): Instr[] => [
      { op: "local.get", index: DATA },
      { op: "local.get", index: I },
      ...byteLoad(packed, vecArrTypeIdx),
      { op: "local.set", index: local },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
    ];

    const writeCodePoint: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x10000 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "i32.const", value: 0xd800 },
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 10 },
          { op: "i32.shr_u" },
          { op: "i32.or" },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "i32.const", value: 0xdc00 },
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 0x3ff },
          { op: "i32.and" },
          { op: "i32.or" },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 2 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
        else: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "local.get", index: CP },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
      },
    ];

    const decodeMultibyte: Instr[] = [
      { op: "local.get", index: B0 },
      { op: "i32.const", value: 0xe0 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: I },
          { op: "local.get", index: LEN },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...readByteTo(B1),
              { op: "local.get", index: B0 },
              { op: "i32.const", value: 0x1f },
              { op: "i32.and" },
              { op: "i32.const", value: 6 },
              { op: "i32.shl" },
              { op: "local.get", index: B1 },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.or" },
              { op: "local.set", index: CP },
            ],
            else: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
        else: [
          { op: "local.get", index: B0 },
          { op: "i32.const", value: 0xf0 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...readByteTo(B1),
                  ...readByteTo(B2),
                  { op: "local.get", index: B0 },
                  { op: "i32.const", value: 0x0f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shl" },
                  { op: "local.get", index: B1 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B2 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "local.set", index: CP },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
            else: [
              { op: "local.get", index: I },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...readByteTo(B1),
                  ...readByteTo(B2),
                  ...readByteTo(B3),
                  { op: "local.get", index: B0 },
                  { op: "i32.const", value: 0x07 },
                  { op: "i32.and" },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shl" },
                  { op: "local.get", index: B1 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B2 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B3 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "local.set", index: CP },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "local.set", index: SRC },
      { op: "local.get", index: SRC },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: SRC },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: LEN },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: OUT },
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
              ...readByteTo(B0),
              { op: "local.get", index: B0 },
              { op: "i32.const", value: 0x80 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: B0 },
                  { op: "local.set", index: CP },
                ],
                else: decodeMultibyte,
              },
              ...writeCodePoint,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: O },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: OUT },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__textdecoder_decode_u8",
      typeIdx,
      locals: [
        { name: "src", type: vecNonNullRef },
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: vecArrRef },
        { name: "out", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "b0", type: { kind: "i32" } },
        { name: "b1", type: { kind: "i32" } },
        { name: "b2", type: { kind: "i32" } },
        { name: "b3", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  return {
    encodeIdx: ctx.funcMap.get("__textencoder_encode")!,
    decodeU8Idx: ctx.funcMap.get("__textdecoder_decode_u8")!,
    vecTypeIdx,
    resultTypeIdx,
  };
}
