// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";

/** Read the carrier's low signed 64 bits. This truncating view is not ToBigInt or value equality. */
export function buildReadBigIntCarrierBody(type: TypeHandle): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: type },
    { op: "struct.get", typeIdx: type, fieldIdx: 0 },
  ];
}

export interface BigIntCarrierTypes {
  readonly narrow: TypeHandle;
  readonly limbs: TypeHandle;
  readonly wide: TypeHandle;
}

/** Main's exact canonical carrier equality; callers must supply actual BigInt carriers. */
export function buildBigIntCarrierEqualityDefinition(types: BigIntCarrierTypes): { locals: LocalDef[]; body: Instr[] } {
  const WIDE_FIELD_SIGN = 1;
  const WIDE_FIELD_MAG = 2;
  const WA = 2;
  const WB = 3;
  const N = 4;
  const I = 5;
  const isWide = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "ref.test", typeIdx: types.wide },
  ];
  const field = (local: number, fieldIdx: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx: types.wide, fieldIdx },
  ];
  const returnFalse: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  const body: Instr[] = [
    ...isWide(0),
    ...isWide(1),
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isWide(0),
        ...isWide(1),
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.set", index: WA },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.set", index: WB },
        ...field(WA, WIDE_FIELD_SIGN),
        ...field(WB, WIDE_FIELD_SIGN),
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        ...field(WA, WIDE_FIELD_MAG),
        { op: "array.len" },
        { op: "local.tee", index: N },
        ...field(WB, WIDE_FIELD_MAG),
        { op: "array.len" },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: N },
            { op: "i32.ge_u" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            ...field(WA, WIDE_FIELD_MAG),
            { op: "local.get", index: I },
            { op: "array.get", typeIdx: types.limbs },
            ...field(WB, WIDE_FIELD_MAG),
            { op: "local.get", index: I },
            { op: "array.get", typeIdx: types.limbs },
            { op: "i32.ne" },
            { op: "if", blockType: { kind: "empty" }, then: returnFalse },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: types.narrow },
    { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
    { op: "local.get", index: 1 },
    { op: "ref.cast", typeIdx: types.narrow },
    { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
    { op: "i64.eq" },
  ];
  return {
    locals: [
      { name: "wa", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "wb", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
  };
}
