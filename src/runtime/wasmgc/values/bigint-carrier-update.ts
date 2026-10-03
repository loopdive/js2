// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { BigIntCarrierTypes } from "./bigint-carrier-body.js";

const VALUE = 0;
const DELTA = 1;
const WIDE = 2;
const SOURCE = 3;
const OUTPUT = 4;
const LENGTH = 5;
const USED = 6;
const INDEX = 7;
const SIGN = 8;
const GROW = 9;
const CARRY = 10;
const LIMB = 11;
const SUM = 12;
const LOW = 13;
const TRIMMED = 14;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const i32 = (value: number): Instr => ({ op: "i32.const", value });
const i64 = (value: bigint): Instr => ({ op: "i64.const", value });

function loop(body: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: [...body, { op: "br", depth: 0 }] }],
  };
}

function narrow(types: BigIntCarrierTypes): Instr[] {
  return [get(LOW), { op: "struct.new", typeIdx: types.narrow }, { op: "extern.convert_any" }, { op: "return" }];
}

/** Internal ABI: a proven BigInt carrier and delta exactly +1 or -1.
 * Old carriers and their limb arrays are immutable from this helper's view.
 * Results always use the canonical narrow-or-trimmed-wide representation. */
export function buildBigIntCarrierUpdateDefinition(types: BigIntCarrierTypes): { locals: LocalDef[]; body: Instr[] } {
  const read = (array: number, index: Instr[]): Instr[] => [
    get(array),
    ...index,
    { op: "array.get", typeIdx: types.limbs },
  ];
  const body: Instr[] = [
    get(VALUE),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: types.wide },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(VALUE),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: types.narrow },
        { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
        set(LOW),
        get(LOW),
        get(DELTA),
        i32(1),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i64" } },
          then: [i64(9223372036854775807n)],
          else: [i64(-9223372036854775808n)],
        },
        { op: "i64.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // The only two narrow overflows are +/-2^63, with magnitude one
            // greater for decrementing the minimum signed value.
            get(LOW),
            get(DELTA),
            { op: "i64.extend_i32_s" },
            { op: "i64.add" },
            get(DELTA),
            get(DELTA),
            i32(-1),
            { op: "i32.eq" },
            i32(-2147483648),
            { op: "array.new_fixed", typeIdx: types.limbs, length: 2 },
            { op: "struct.new", typeIdx: types.wide },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
        },
        get(LOW),
        get(DELTA),
        { op: "i64.extend_i32_s" },
        { op: "i64.add" },
        set(LOW),
        ...narrow(types),
      ],
    },
    get(VALUE),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: types.wide },
    set(WIDE),
    get(WIDE),
    { op: "struct.get", typeIdx: types.wide, fieldIdx: 1 },
    set(SIGN),
    get(WIDE),
    { op: "struct.get", typeIdx: types.wide, fieldIdx: 2 },
    set(SOURCE),
    get(SOURCE),
    { op: "array.len" },
    { op: "local.tee", index: LENGTH },
    set(USED),
    get(LENGTH),
    i32(1),
    { op: "i32.add" },
    { op: "array.new_default", typeIdx: types.limbs },
    set(OUTPUT),
    get(SIGN),
    get(DELTA),
    { op: "i32.eq" },
    set(GROW),
    i64(1n),
    set(CARRY),
    loop([
      get(INDEX),
      get(LENGTH),
      { op: "i32.ge_u" },
      { op: "br_if", depth: 1 },
      ...read(SOURCE, [get(INDEX)]),
      { op: "i64.extend_i32_u" },
      set(LIMB),
      get(GROW),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          get(LIMB),
          get(CARRY),
          { op: "i64.add" },
          { op: "local.tee", index: SUM },
          i64(32n),
          { op: "i64.shr_u" },
          set(CARRY),
        ],
        else: [
          get(LIMB),
          get(CARRY),
          { op: "i64.sub" },
          set(SUM),
          get(LIMB),
          get(CARRY),
          { op: "i64.lt_u" },
          { op: "i64.extend_i32_u" },
          set(CARRY),
        ],
      },
      get(OUTPUT),
      get(INDEX),
      get(SUM),
      { op: "i32.wrap_i64" },
      { op: "array.set", typeIdx: types.limbs },
      get(INDEX),
      i32(1),
      { op: "i32.add" },
      set(INDEX),
    ]),
    get(GROW),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(OUTPUT),
        get(LENGTH),
        get(CARRY),
        { op: "i32.wrap_i64" },
        { op: "array.set", typeIdx: types.limbs },
        get(LENGTH),
        get(CARRY),
        { op: "i32.wrap_i64" },
        { op: "i32.add" },
        set(USED),
      ],
      else: [
        loop([
          get(USED),
          i32(1),
          { op: "i32.le_u" },
          { op: "br_if", depth: 1 },
          ...read(OUTPUT, [get(USED), i32(1), { op: "i32.sub" }]),
          { op: "br_if", depth: 1 },
          get(USED),
          i32(1),
          { op: "i32.sub" },
          set(USED),
        ]),
      ],
    },
    // OUTPUT has at least three capacity limbs for every canonical wide
    // input, so both low limbs can be read even after narrowing its used size.
    ...read(OUTPUT, [i32(0)]),
    { op: "i64.extend_i32_u" },
    ...read(OUTPUT, [i32(1)]),
    { op: "i64.extend_i32_u" },
    i64(32n),
    { op: "i64.shl" },
    { op: "i64.or" },
    set(LOW),
    get(SIGN),
    i32(0),
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: [i64(0n), get(LOW), { op: "i64.sub" }, set(LOW)] },
    get(USED),
    i32(2),
    { op: "i32.le_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(SIGN),
        i32(0),
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          // Negative magnitude fits iff the negated low bits are negative
          // (including MIN). Positive magnitude fits iff the low bits aren't.
          then: [get(LOW), i64(0n), { op: "i64.lt_s" }],
          else: [get(LOW), i64(0n), { op: "i64.ge_s" }],
        },
        { op: "if", blockType: { kind: "empty" }, then: narrow(types) },
      ],
    },
    get(USED),
    { op: "array.new_default", typeIdx: types.limbs },
    set(TRIMMED),
    get(TRIMMED),
    i32(0),
    get(OUTPUT),
    i32(0),
    get(USED),
    { op: "array.copy", dstTypeIdx: types.limbs, srcTypeIdx: types.limbs },
    get(LOW),
    get(SIGN),
    get(TRIMMED),
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: types.wide },
    { op: "extern.convert_any" },
  ];
  return {
    body,
    locals: [
      { name: "wide", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "source", type: { kind: "ref_null", typeIdx: types.limbs } },
      { name: "output", type: { kind: "ref_null", typeIdx: types.limbs } },
      { name: "length", type: { kind: "i32" } },
      { name: "used", type: { kind: "i32" } },
      { name: "index", type: { kind: "i32" } },
      { name: "sign", type: { kind: "i32" } },
      { name: "grow", type: { kind: "i32" } },
      { name: "carry", type: { kind: "i64" } },
      { name: "limb", type: { kind: "i64" } },
      { name: "sum", type: { kind: "i64" } },
      { name: "low", type: { kind: "i64" } },
      { name: "trimmed", type: { kind: "ref_null", typeIdx: types.limbs } },
    ],
  };
}
