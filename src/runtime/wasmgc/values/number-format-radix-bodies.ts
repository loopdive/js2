// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, ValType } from "../../../wasm/model/instructions.js";
import type { NativeNumberFormatBody } from "./number-format-bodies.js";

export interface NumberFormatStringTypes {
  readonly dataTypeIdx: number;
  readonly nativeStringTypeIdx: number;
  readonly anyStringTypeIdx: number;
}
const L = (i: number): Instr => ({ op: "local.get", index: i });
const TRUNC: Instr = { op: "i32.trunc_sat_f64_s" };

export function buildNumberFormatNewBody(types: NumberFormatStringTypes): NativeNumberFormatBody {
  return { locals: [], body: [L(0), TRUNC, { op: "array.new_default", typeIdx: types.dataTypeIdx }] };
}
export function buildNumberFormatGetBody(types: NumberFormatStringTypes): NativeNumberFormatBody {
  return {
    locals: [],
    body: [L(0), L(1), TRUNC, { op: "array.get_u", typeIdx: types.dataTypeIdx }, { op: "f64.convert_i32_u" }],
  };
}
export function buildNumberFormatSetBody(types: NumberFormatStringTypes): NativeNumberFormatBody {
  return { locals: [], body: [L(0), L(1), TRUNC, L(2), TRUNC, { op: "array.set", typeIdx: types.dataTypeIdx }] };
}
export function buildNumberFormatTrapBody(): NativeNumberFormatBody {
  return { locals: [], body: [{ op: "unreachable" }] };
}
export function buildNumberFormatFinBody(types: NumberFormatStringTypes): NativeNumberFormatBody {
  const strTypeIdx = types.nativeStringTypeIdx;
  const strDataTypeIdx = types.dataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const L_BUF = 0;
  const L_LENF = 1;
  const L_LEN = 2;
  const L_OUT = 3;
  const L_I = 4;
  return {
    locals: [
      { name: "len", type: i32 },
      { name: "out", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "i", type: i32 },
    ],
    body: [
      L(L_LENF),
      TRUNC,
      { op: "local.set", index: L_LEN },
      L(L_LEN),
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: L_OUT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              L(L_I),
              L(L_LEN),
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              L(L_OUT),
              { op: "ref.as_non_null" },
              L(L_I),
              L(L_BUF),
              L(L_I),
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "array.set", typeIdx: strDataTypeIdx },
              L(L_I),
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      L(L_LEN),
      { op: "i32.const", value: 0 },
      L(L_OUT),
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: strTypeIdx },
    ],
  };
}
export function buildNumberFormatRadixThunkBody(radixBody: FuncHandle): NativeNumberFormatBody {
  return { locals: [], body: [L(0), L(1), { op: "call", funcIdx: radixBody }, { op: "extern.convert_any" }] };
}
