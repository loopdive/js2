// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";

export function buildStringUtf8ToFlatDefinition(layout: NativeStringLayout): { locals: LocalDef[]; body: Instr[] } {
  const { nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx } = layout;
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 0 }, // len
    { op: "local.set", index: 1 },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 1 }, // byteLen
    { op: "local.set", index: 2 },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 3 }, // data (ref $__str_data_u8)
    { op: "local.set", index: 3 },
    // out = array.new_default $__str_data(len)
    { op: "local.get", index: 1 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: 4 },
    // b is the absolute byte offset; local 2 becomes the exclusive byte end.
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 2 },
    { op: "local.tee", index: 5 },
    { op: "local.get", index: 2 },
    { op: "i32.add" },
    { op: "local.set", index: 2 }, // end = off + byteLen
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
            // if b >= end break
            { op: "local.get", index: 5 },
            { op: "local.get", index: 2 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // c0 = data[b] & 0xFF (array.get_u zero-extends an i8 lane)
            { op: "local.get", index: 3 },
            { op: "local.get", index: 5 },
            { op: "array.get_u", typeIdx: layout.utf8StrDataTypeIdx },
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
                    { op: "array.get_u", typeIdx: layout.utf8StrDataTypeIdx },
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
                          typeIdx: layout.utf8StrDataTypeIdx,
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
                          typeIdx: layout.utf8StrDataTypeIdx,
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
                          typeIdx: layout.utf8StrDataTypeIdx,
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
                          typeIdx: layout.utf8StrDataTypeIdx,
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
                          typeIdx: layout.utf8StrDataTypeIdx,
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
  return {
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "byteLen", type: { kind: "i32" } },
      {
        name: "data",
        type: { kind: "ref", typeIdx: layout.utf8StrDataTypeIdx },
      },
      { name: "out", type: strDataRef },
      { name: "b", type: { kind: "i32" } },
      { name: "o", type: { kind: "i32" } },
      { name: "c0", type: { kind: "i32" } },
      { name: "cp", type: { kind: "i32" } },
    ],
    body,
  };
}
