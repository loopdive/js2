// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, ValType } from "../model/instructions.js";
const DATA = 3,
  LENGTH = 4,
  CAPACITY = 5,
  NEXT_CAPACITY = 6,
  NEXT_DATA = 7,
  NEXT_LENGTH = 8;
const MAXIMUM = 0x7fffffff;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const constant = (value: number): Instr => ({ op: "i32.const", value });
const trap = (): Instr => ({ op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] });

/** Caller owns the exact issued f64 carrier and backing type indices. */
export function describeGcNumericVectorAppend(
  carrierTypeIndex: number,
  arrayTypeIndex: number,
): {
  params: ValType[];
  results: ValType[];
  locals: LocalDef[];
} {
  return {
    params: [{ kind: "ref_null", typeIdx: carrierTypeIndex }, { kind: "i32" }, { kind: "f64" }],
    results: [],
    locals: [
      { name: "data", type: { kind: "ref_null", typeIdx: arrayTypeIndex } },
      ...["length", "capacity", "next_capacity"].map((name) => ({ name, type: { kind: "i32" } as ValType })),
      { name: "next_data", type: { kind: "ref_null", typeIdx: arrayTypeIndex } },
      { name: "next_length", type: { kind: "i32" } },
    ],
  };
}

/** Store into prepared backing before publishing its pointer and the new length. */
export function buildGcNumericVectorAppendBody(carrierTypeIndex: number, arrayTypeIndex: number): Instr[] {
  return [
    get(0),
    { op: "ref.is_null" },
    trap(),
    get(0),
    { op: "struct.get", typeIdx: carrierTypeIndex, fieldIdx: 1 },
    set(DATA),
    get(0),
    { op: "struct.get", typeIdx: carrierTypeIndex, fieldIdx: 0 },
    set(LENGTH),
    get(DATA),
    { op: "array.len" },
    set(CAPACITY),
    get(CAPACITY),
    constant(MAXIMUM),
    { op: "i32.gt_u" },
    trap(),
    get(LENGTH),
    get(CAPACITY),
    { op: "i32.gt_u" },
    trap(),
    get(1),
    get(LENGTH),
    { op: "i32.ne" },
    trap(),
    get(LENGTH),
    constant(MAXIMUM),
    { op: "i32.ge_u" },
    trap(),
    get(LENGTH),
    constant(1),
    { op: "i32.add" },
    set(NEXT_LENGTH),
    get(LENGTH),
    get(CAPACITY),
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(CAPACITY),
        constant(Math.floor(MAXIMUM / 2)),
        { op: "i32.gt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [constant(MAXIMUM), set(NEXT_CAPACITY)],
          else: [get(CAPACITY), constant(2), { op: "i32.mul" }, set(NEXT_CAPACITY)],
        },
        get(NEXT_CAPACITY),
        get(NEXT_LENGTH),
        { op: "i32.lt_u" },
        { op: "if", blockType: { kind: "empty" }, then: [get(NEXT_LENGTH), set(NEXT_CAPACITY)], else: [] },
        get(NEXT_CAPACITY),
        constant(4),
        { op: "i32.lt_u" },
        { op: "if", blockType: { kind: "empty" }, then: [constant(4), set(NEXT_CAPACITY)], else: [] },
        get(NEXT_CAPACITY),
        { op: "array.new_default", typeIdx: arrayTypeIndex },
        set(NEXT_DATA),
        get(NEXT_DATA),
        constant(0),
        get(DATA),
        constant(0),
        get(CAPACITY),
        { op: "array.copy", dstTypeIdx: arrayTypeIndex, srcTypeIdx: arrayTypeIndex },
        get(NEXT_DATA),
        get(LENGTH),
        get(2),
        { op: "array.set", typeIdx: arrayTypeIndex },
        // The two final field stores are typed, nonthrowing, and have no callbacks between.
        get(0),
        get(NEXT_DATA),
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: carrierTypeIndex, fieldIdx: 1 },
        get(0),
        get(NEXT_LENGTH),
        { op: "struct.set", typeIdx: carrierTypeIndex, fieldIdx: 0 },
      ],
      else: [
        get(DATA),
        get(LENGTH),
        get(2),
        { op: "array.set", typeIdx: arrayTypeIndex },
        get(0),
        get(NEXT_LENGTH),
        { op: "struct.set", typeIdx: carrierTypeIndex, fieldIdx: 0 },
      ],
    },
  ];
}
