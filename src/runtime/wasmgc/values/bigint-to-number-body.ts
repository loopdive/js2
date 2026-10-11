// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { BigIntCarrierTypes } from "./bigint-carrier-body.js";

// Parameter 0 is the actual BigInt carrier as externref. The wide carrier's
// magnitude is little-endian base 2^32; field 0 is only its wrapped low i64.
const ANY = 1,
  MAG = 2,
  SIGN = 3,
  LENGTH = 4,
  EXPONENT = 5,
  BIT = 6,
  STOP = 7,
  SIGNIFICAND = 8,
  GUARD = 9,
  STICKY = 10,
  INDEX = 11;

function magnitudeWord(types: BigIntCarrierTypes, index: Instr[]): Instr[] {
  return [{ op: "local.get", index: MAG }, ...index, { op: "array.get", typeIdx: types.limbs }];
}

function magnitudeBit(types: BigIntCarrierTypes): Instr[] {
  return [
    ...magnitudeWord(types, [{ op: "local.get", index: BIT }, { op: "i32.const", value: 5 }, { op: "i32.shr_u" }]),
    { op: "local.get", index: BIT },
    { op: "i32.const", value: 31 },
    { op: "i32.and" },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
  ];
}

/** Collect the leading 53 bits exactly in i64, leaving BIT at the guard bit. */
function collectSignificand(types: BigIntCarrierTypes): Instr[] {
  return [
    { op: "local.get", index: EXPONENT },
    { op: "local.tee", index: BIT },
    { op: "i32.const", value: 52 },
    { op: "i32.sub" },
    { op: "local.set", index: STOP },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: SIGNIFICAND },
        { op: "i64.const", value: 1n },
        { op: "i64.shl" },
        ...magnitudeBit(types),
        { op: "i64.extend_i32_u" },
        { op: "i64.or" },
        { op: "local.set", index: SIGNIFICAND },
        { op: "local.get", index: BIT },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.tee", index: BIT },
        { op: "local.get", index: STOP },
        { op: "i32.ge_s" },
        { op: "br_if", depth: 0 },
      ],
    },
  ];
}

/** Every discarded bit below the guard participates, including whole low limbs. */
function collectRoundingBits(types: BigIntCarrierTypes): Instr[] {
  return [
    ...magnitudeBit(types),
    { op: "local.set", index: GUARD },
    { op: "local.get", index: BIT },
    { op: "i32.const", value: 5 },
    { op: "i32.shr_u" },
    { op: "local.set", index: INDEX },
    ...magnitudeWord(types, [{ op: "local.get", index: INDEX }]),
    { op: "i32.const", value: 1 },
    { op: "local.get", index: BIT },
    { op: "i32.const", value: 31 },
    { op: "i32.and" },
    { op: "i32.shl" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "i32.and" },
    { op: "local.set", index: STICKY },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: INDEX },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: INDEX },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: INDEX },
            { op: "local.get", index: STICKY },
            ...magnitudeWord(types, [{ op: "local.get", index: INDEX }]),
            { op: "i32.or" },
            { op: "local.set", index: STICKY },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** One round-to-nearest/ties-even operation, then assemble binary64 bits. */
function roundedNumber(): Instr[] {
  return [
    { op: "local.get", index: GUARD },
    { op: "local.get", index: STICKY },
    { op: "i32.eqz" },
    { op: "i32.eqz" },
    { op: "local.get", index: SIGNIFICAND },
    { op: "i64.const", value: 1n },
    { op: "i64.and" },
    { op: "i32.wrap_i64" },
    { op: "i32.or" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: SIGNIFICAND },
        { op: "i64.const", value: 1n },
        { op: "i64.add" },
        { op: "local.set", index: SIGNIFICAND },
      ],
    },
    { op: "local.get", index: EXPONENT },
    { op: "i32.const", value: 1023 },
    { op: "i32.add" },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 52n },
    { op: "i64.shl" },
    { op: "local.get", index: SIGNIFICAND },
    { op: "i64.const", value: 1n << 52n },
    { op: "i64.sub" },
    // ADD deliberately carries an overflowing rounded significand into the
    // exponent, including 0x7ff (infinity) at the largest finite boundary.
    { op: "i64.add" },
    { op: "local.get", index: SIGN },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "i64.const", value: -(1n << 63n) }],
      else: [{ op: "i64.const", value: 0n }],
    },
    { op: "i64.or" },
    { op: "f64.reinterpret_i64" },
  ];
}

function wideNumber(types: BigIntCarrierTypes): Instr[] {
  const field = (index: number): Instr[] => [
    { op: "local.get", index: ANY },
    { op: "ref.cast", typeIdx: types.wide },
    { op: "struct.get", typeIdx: types.wide, fieldIdx: index },
  ];
  return [
    ...field(1),
    { op: "local.set", index: SIGN },
    ...field(2),
    { op: "ref.as_non_null" },
    { op: "local.tee", index: MAG },
    { op: "array.len" },
    { op: "local.tee", index: LENGTH },
    // Canonical wide magnitudes have no leading zero limb and are outside
    // signed i64. More than 32 limbs therefore has exponent >= 1024.
    { op: "i32.const", value: 32 },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: SIGN },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "f64.const", value: -Infinity }],
          else: [{ op: "f64.const", value: Infinity }],
        },
        { op: "return" },
      ],
    },
    { op: "local.get", index: LENGTH },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: INDEX },
    { op: "i32.const", value: 5 },
    { op: "i32.shl" },
    { op: "i32.const", value: 31 },
    { op: "i32.add" },
    ...magnitudeWord(types, [{ op: "local.get", index: INDEX }]),
    { op: "i32.clz" },
    { op: "i32.sub" },
    { op: "local.set", index: EXPONENT },
    ...collectSignificand(types),
    ...collectRoundingBits(types),
    ...roundedNumber(),
  ];
}

/**
 * Number(canonical BigInt), (externref) -> f64. No conversion of other JS values.
 * The owner supplies the actual narrow/limbs/finalized-wide layouts and ensures
 * canonical carriers; this pure recipe does not issue that authority.
 *
 * Narrow i64 uses Wasm's correctly rounded signed conversion. For a wide value
 * with exponent e <= 1023, the top 53 bits q and remaining guard/sticky bits
 * determine q' = q + (guard && (sticky || odd(q))). Integer bit assembly is
 * exact, including exponent carry/overflow. No floating accumulation or double
 * rounding occurs. BigInt has no negative zero; canonical zero takes i64's +0.
 */
export function buildBigIntToNumberDefinition(input: BigIntCarrierTypes): { locals: LocalDef[]; body: Instr[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BigInt number: invalid layouts");
  const proto = Object.getPrototypeOf(input);
  const fields = Object.getOwnPropertyDescriptors(input);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(fields).length !== 3)
    throw new Error("BigInt number: invalid layouts");
  const types = {} as { narrow: number; limbs: number; wide: number };
  for (const key of ["narrow", "limbs", "wide"] as const) {
    const field = fields[key];
    if (
      !field ||
      !Object.hasOwn(field, "value") ||
      !field.enumerable ||
      typeof field.value !== "number" ||
      !Number.isInteger(field.value) ||
      field.value < 0 ||
      field.value > 0xffffffff
    )
      throw new Error("BigInt number: invalid layout " + key);
    types[key] = field.value;
  }
  return {
    locals: [
      { name: "any", type: { kind: "anyref" } },
      { name: "magnitude", type: { kind: "ref_null", typeIdx: types.limbs } },
      ...["sign", "length", "exponent", "bit", "stop"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
      { name: "significand", type: { kind: "i64" } },
      ...["guard", "sticky", "index"].map((name): LocalDef => ({ name, type: { kind: "i32" } })),
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: ANY },
      { op: "ref.test", typeIdx: types.wide },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: wideNumber(types),
        else: [
          { op: "local.get", index: ANY },
          { op: "ref.cast", typeIdx: types.narrow },
          { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
          { op: "f64.convert_i64_s" },
        ],
      },
    ],
  };
}
