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

const WIDE_FIELD_SIGN = 1;
const WIDE_FIELD_MAG = 2;

/** Accessors over carriers held in locals: the wide test, a wide field, and the narrow i64 view. */
function carrierAccess(types: BigIntCarrierTypes) {
  return {
    isWide: (index: number): Instr[] => [
      { op: "local.get", index },
      { op: "ref.test", typeIdx: types.wide },
    ],
    field: (local: number, fieldIdx: number): Instr[] => [
      { op: "local.get", index: local },
      { op: "struct.get", typeIdx: types.wide, fieldIdx },
    ],
    low64: (index: number): Instr[] => [
      { op: "local.get", index },
      { op: "ref.cast", typeIdx: types.narrow },
      { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
    ],
  };
}

/** Main's exact canonical carrier equality; callers must supply actual BigInt carriers. */
export function buildBigIntCarrierEqualityDefinition(types: BigIntCarrierTypes): { locals: LocalDef[]; body: Instr[] } {
  const WA = 2;
  const WB = 3;
  const N = 4;
  const I = 5;
  const { isWide, field, low64 } = carrierAccess(types);
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
    ...low64(0),
    ...low64(1),
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

/** `(x > y) - (x < y)`: -1, 0 or 1. */
function ordering(
  x: Instr[],
  y: Instr[],
  gt: "i64.gt_s" | "i32.gt_s" | "i32.gt_u",
  lt: "i64.lt_s" | "i32.lt_s" | "i32.lt_u",
): Instr[] {
  return [...x, ...y, { op: gt }, ...x, ...y, { op: lt }, { op: "i32.sub" }] as Instr[];
}

/**
 * (#7403) BigInt::lessThan as an ordering (§6.1.6.2.12): -1, 0 or 1 for `a` against `b`, both actual BigInt
 * carriers. Canonical form puts every wide value outside the i64 range, so a narrow value ranks as sign 0 between the
 * negative and positive wide ones; two wide values of one sign order by magnitude, most significant limb first.
 */
export function buildBigIntCarrierCompareDefinition(types: BigIntCarrierTypes): { locals: LocalDef[]; body: Instr[] } {
  const WA = 2;
  const WB = 3;
  const SA = 4;
  const SB = 5;
  const I = 6;
  const { isWide, field, low64 } = carrierAccess(types);
  const get = (index: number): Instr[] => [{ op: "local.get", index }];
  const signLevel = (param: number, wideLocal: number): Instr[] => [
    ...isWide(param),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: param },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.tee", index: wideLocal },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_SIGN },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  const limb = (wideLocal: number): Instr[] => [
    ...field(wideLocal, WIDE_FIELD_MAG),
    { op: "local.get", index: I },
    { op: "array.get", typeIdx: types.limbs },
  ];
  const magLen = (wideLocal: number): Instr[] => [...field(wideLocal, WIDE_FIELD_MAG), { op: "array.len" }];
  /** Return `sign × ordering` when the two magnitudes' parts differ. */
  const returnIfDiffer = (x: Instr[], y: Instr[]): Instr[] => [
    ...x,
    ...y,
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...get(SA), ...ordering(x, y, "i32.gt_u", "i32.lt_u"), { op: "i32.mul" }, { op: "return" }],
    },
  ];
  const body: Instr[] = [
    ...isWide(0),
    ...isWide(1),
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...ordering(low64(0), low64(1), "i64.gt_s", "i64.lt_s"), { op: "return" }],
    },
    ...signLevel(0, WA),
    { op: "local.set", index: SA },
    ...signLevel(1, WB),
    { op: "local.tee", index: SB },
    ...get(SA),
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...ordering(get(SA), get(SB), "i32.gt_s", "i32.lt_s"), { op: "return" }],
    },
    ...returnIfDiffer(magLen(WA), magLen(WB)),
    ...magLen(WA),
    { op: "local.set", index: I },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        ...get(I),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        ...get(I),
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: I },
        ...returnIfDiffer(limb(WA), limb(WB)),
        { op: "br", depth: 0 },
      ],
    },
    { op: "unreachable" },
  ];
  return {
    locals: [
      { name: "wa", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "wb", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "sa", type: { kind: "i32" } },
      { name: "sb", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
  };
}
