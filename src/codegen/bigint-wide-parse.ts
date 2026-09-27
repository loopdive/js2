// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6656 slice 4) `BigInt(x)` whose result lands in a REFERENCE slot, exact
 * past 64 bits under the native (standalone) semantic providers.
 *
 * `__bigint_ctor` returns the i64 the narrow carrier holds, so a string whose
 * value leaves [-2^63, 2^63-1] wrapped (`BigInt("0b1" + "0".repeat(128))` gave
 * `0n`), and `BigInt(wide)` dropped the high limbs of a `$BigIntWide`. When
 * the call site wants an `externref` anyway, `__bigint_ctor_carrier` answers
 * the exact carrier instead:
 *
 * - it still calls `__bigint_ctor` FIRST, so every TypeError / RangeError /
 *   SyntaxError and every non-string operand keeps its exact existing
 *   behaviour, and the i64 it returns is the wide value's low 64 bits;
 * - a `$BigIntWide` operand is returned as is (BigInt of a BigInt is itself);
 * - a string operand, already validated by that call, is re-scanned into
 *   base-2^32 limbs — sign / `0x` `0o` `0b` prefix / digits, stopping at the
 *   trailing whitespace the validator allowed.
 *
 * The result is canonical: a value that fits in i64 is a plain `$BigInt`.
 */
import type { Instr, ValType } from "../ir/types.js";
import {
  C_LC_B,
  C_LC_O,
  C_LC_X,
  C_MINUS,
  C_PLUS,
  C_ZERO,
  emitDigitValue,
  isWsBody,
} from "../runtime/wasmgc/values/string-number-grammar.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { usesHostBigIntCarrier } from "./host-bigint-carrier.js";
import { addFuncType } from "./registry/types.js";

/**
 * With the `BigInt(...)` operand (externref) on the stack: when `expectedType`
 * is a reference, emit the exact carrier call and answer true (an externref is
 * then on the stack). False leaves the body untouched.
 */
export function emitBigIntCtorCarrier(ctx: CodegenContext, fctx: FunctionContext, expectedType?: ValType): boolean {
  if (expectedType?.kind !== "externref" && expectedType?.kind !== "anyref") return false;
  if (usesHostBigIntCarrier(ctx)) return false;
  const idx = ensureBigIntCtorCarrier(ctx);
  if (idx === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: idx });
  return true;
}

// Locals of `__bigint_ctor_carrier` (param 0 is the operand).
const ANY = 1;
const LO = 2;
const FLAT = 3;
const DATA = 4;
const I = 5;
const END = 6;
const C = 7;
const RADIX = 8;
const DIG = 9;
const LIMBS = 10;
const USED = 11;
const K = 12;
const CARRY = 13;
const T = 14;
const NEG = 15;
const OUT = 16;

interface ScanTypes {
  str: number;
  data: number;
  limbs: number;
  wide: number;
  narrow: number;
}

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const i32c = (value: number): Instr => ({ op: "i32.const", value });
const inc = (index: number, by: number): Instr[] => [get(index), i32c(by), { op: "i32.add" }, set(index)];
const charAt = (types: ScanTypes, offset: number): Instr[] => [
  get(DATA),
  get(I),
  ...(offset === 0 ? [] : [i32c(offset), { op: "i32.add" } as Instr]),
  { op: "array.get_u", typeIdx: types.data },
];
/** `block { loop { body; br 0 } }` — `body` leaves with `br_if 1`. */
const whileLoop = (body: Instr[]): Instr => ({
  op: "block",
  blockType: { kind: "empty" },
  body: [{ op: "loop", blockType: { kind: "empty" }, body: [...body, { op: "br", depth: 0 }] }],
});
const narrowResult = (types: ScanTypes): Instr[] => [
  get(LO),
  { op: "struct.new", typeIdx: types.narrow },
  { op: "extern.convert_any" },
];

/** Skip leading whitespace, then read a decimal sign or a radix prefix. */
function scanPrefix(types: ScanTypes): Instr[] {
  /** `if ((data[i+1] | 0x20) === letter) { radix = r; i += 2 } else …` */
  const prefixArm = (letter: number, radix: number, elseArm: Instr[]): Instr[] => [
    ...charAt(types, 1),
    i32c(0x20),
    { op: "i32.or" },
    i32c(letter),
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [i32c(radix), set(RADIX), ...inc(I, 2)], else: elseArm },
  ];
  return [
    whileLoop([
      get(I),
      get(END),
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
      ...charAt(types, 0),
      set(C),
      ...isWsBody(C),
      { op: "i32.eqz" },
      { op: "br_if", depth: 1 },
      ...inc(I, 1),
    ]),
    i32c(10),
    set(RADIX),
    get(I),
    get(END),
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charAt(types, 0),
        set(C),
        get(C),
        i32c(C_MINUS),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [i32c(1), set(NEG), ...inc(I, 1)],
          else: [
            get(C),
            i32c(C_PLUS),
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: inc(I, 1),
              else: [
                get(C),
                i32c(C_ZERO),
                { op: "i32.eq" },
                get(I),
                i32c(1),
                { op: "i32.add" },
                get(END),
                { op: "i32.lt_s" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: prefixArm(C_LC_X, 16, prefixArm(C_LC_O, 8, prefixArm(C_LC_B, 2, []))),
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** `mag = mag * radix + digit`, limb by limb, until the first non-digit. */
function accumulateDigits(types: ScanTypes): Instr[] {
  const limbs = types.limbs;
  return [
    // Room for |v|: at most 4 bits per digit, plus slack.
    get(END),
    get(I),
    { op: "i32.sub" },
    i32c(3),
    { op: "i32.shr_u" },
    i32c(2),
    { op: "i32.add" },
    { op: "array.new_default", typeIdx: limbs },
    set(LIMBS),
    whileLoop([
      get(I),
      get(END),
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
      ...charAt(types, 0),
      set(C),
      ...emitDigitValue(C, DIG),
      get(DIG),
      i32c(0),
      { op: "i32.lt_s" },
      get(DIG),
      get(RADIX),
      { op: "i32.ge_s" },
      { op: "i32.or" },
      { op: "br_if", depth: 1 },
      get(DIG),
      { op: "i64.extend_i32_u" },
      set(CARRY),
      i32c(0),
      set(K),
      whileLoop([
        get(K),
        get(USED),
        { op: "i32.ge_u" },
        { op: "br_if", depth: 1 },
        get(LIMBS),
        get(K),
        { op: "array.get", typeIdx: limbs },
        { op: "i64.extend_i32_u" },
        get(RADIX),
        { op: "i64.extend_i32_u" },
        { op: "i64.mul" },
        get(CARRY),
        { op: "i64.add" },
        set(T),
        get(LIMBS),
        get(K),
        get(T),
        { op: "i32.wrap_i64" },
        { op: "array.set", typeIdx: limbs },
        get(T),
        { op: "i64.const", value: 32n },
        { op: "i64.shr_u" },
        set(CARRY),
        ...inc(K, 1),
      ]),
      // radix <= 16, so the carry out of the top limb fits in one new limb.
      get(CARRY),
      { op: "i64.eqz" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          get(LIMBS),
          get(USED),
          get(CARRY),
          { op: "i32.wrap_i64" },
          { op: "array.set", typeIdx: limbs },
          ...inc(USED, 1),
        ],
      },
      ...inc(I, 1),
    ]),
  ];
}

/** The canonical carrier for sign `neg`, magnitude `limbs[0..used)`, low bits `lo`. */
function buildResult(types: ScanTypes): Instr[] {
  const limbs = types.limbs;
  return [
    // Fits in i64: fewer than two limbs, a high limb below 2^31, or exactly
    // -2^63 (negative, and its low 64 bits are i64 MIN).
    get(USED),
    i32c(2),
    { op: "i32.lt_u" },
    { op: "if", blockType: { kind: "empty" }, then: [...narrowResult(types), { op: "return" }] },
    get(USED),
    i32c(2),
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(LIMBS),
        i32c(1),
        { op: "array.get", typeIdx: limbs },
        i32c(0),
        { op: "i32.ge_s" },
        get(NEG),
        get(LO),
        { op: "i64.const", value: -(1n << 63n) },
        { op: "i64.eq" },
        { op: "i32.and" },
        { op: "i32.or" },
        { op: "if", blockType: { kind: "empty" }, then: [...narrowResult(types), { op: "return" }] },
      ],
    },
    // Wide: the exact magnitude, trimmed to `used` limbs.
    get(USED),
    { op: "array.new_default", typeIdx: limbs },
    set(OUT),
    get(OUT),
    i32c(0),
    get(LIMBS),
    i32c(0),
    get(USED),
    { op: "array.copy", dstTypeIdx: limbs, srcTypeIdx: limbs },
    get(LO),
    i32c(1),
    get(NEG),
    i32c(1),
    { op: "i32.shl" },
    { op: "i32.sub" },
    get(OUT),
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: types.wide },
    { op: "extern.convert_any" },
  ];
}

function ensureBigIntCtorCarrier(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__bigint_ctor_carrier");
  if (existing !== undefined) return existing;
  const ctor = ctx.funcMap.get("__bigint_ctor");
  const wide = ctx.nativeBigIntWideTypeIdx;
  const limbs = ctx.nativeBigIntLimbsTypeIdx;
  const flatten = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  if (
    ctor === undefined ||
    wide === undefined ||
    limbs === undefined ||
    flatten === undefined ||
    ctx.nativeBigIntTypeIdx < 0 ||
    !ctx.nativeStrings ||
    ctx.anyStrTypeIdx < 0 ||
    ctx.nativeStrTypeIdx < 0 ||
    ctx.nativeStrDataTypeIdx < 0
  ) {
    return undefined;
  }
  const types: ScanTypes = {
    str: ctx.nativeStrTypeIdx,
    data: ctx.nativeStrDataTypeIdx,
    limbs,
    wide,
    narrow: ctx.nativeBigIntTypeIdx,
  };
  const body: Instr[] = [
    // Validation, every error, and the low 64 bits.
    get(0),
    { op: "call", funcIdx: ctor },
    set(LO),
    get(0),
    { op: "any.convert_extern" },
    { op: "local.tee", index: ANY },
    { op: "ref.test", typeIdx: wide },
    { op: "if", blockType: { kind: "empty" }, then: [get(0), { op: "return" }] },
    get(ANY),
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...narrowResult(types), { op: "return" }] },
    // flat = flatten(s); i = off; end = off + len
    get(ANY),
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flatten },
    set(FLAT),
    get(FLAT),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 2 },
    set(DATA),
    get(FLAT),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 1 },
    set(I),
    get(FLAT),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 0 },
    get(I),
    { op: "i32.add" },
    set(END),
    ...scanPrefix(types),
    ...accumulateDigits(types),
    ...buildResult(types),
  ];

  const i32: ValType = { kind: "i32" };
  const i64: ValType = { kind: "i64" };
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__bigint_ctor_carrier", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__bigint_ctor_carrier",
    typeIdx: addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]),
    locals: [
      { name: "any", type: { kind: "anyref" } },
      { name: "lo", type: i64 },
      { name: "flat", type: { kind: "ref_null", typeIdx: types.str } },
      { name: "data", type: { kind: "ref_null", typeIdx: types.data } },
      { name: "i", type: i32 },
      { name: "end", type: i32 },
      { name: "c", type: i32 },
      { name: "radix", type: i32 },
      { name: "dig", type: i32 },
      { name: "limbs", type: { kind: "ref_null", typeIdx: limbs } },
      { name: "used", type: i32 },
      { name: "k", type: i32 },
      { name: "carry", type: i64 },
      { name: "t", type: i64 },
      { name: "neg", type: i32 },
      { name: "out", type: { kind: "ref_null", typeIdx: limbs } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
