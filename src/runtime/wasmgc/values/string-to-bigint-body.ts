// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6642, S61) Native StringToBigInt — ECMA-262 §7.1.14 / StringIntegerLiteral.
 *
 * WHY THIS EXISTS. Under `--target standalone` there is no JS host to satisfy a
 * `BigInt(string)` import, and `__bigint_ctor`'s native body (registry/imports.ts)
 * ended in `throw SyntaxError "Cannot convert string to a BigInt in standalone
 * mode"` for every non-number, non-boolean, non-bigint operand. That terminal is
 * what stops `@js-temporal/polyfill` from ever handing a real BigInt back: its
 * JSBI→BigInt converter is
 *
 *     void 0 !== globalThis.BigInt ? globalThis.BigInt(t.toString(10)) : t
 *
 * i.e. it always passes a decimal STRING. (The `globalThis.BigInt` half of that
 * gap is fixed separately — see #6642's S61 section.)
 *
 * WHY NOT `__str_to_number` + `i64.trunc_sat_f64_s`. Precision is the entire
 * point. A nanosecond epoch (`217175010123456789`) has 18 significant decimal
 * digits; an f64 carries ~15.95. Routing through the double parser answers
 * `217175010123456792` — the bug this is meant to fix, re-introduced one layer
 * down. This scanner accumulates straight into i64.
 *
 * GRAMMAR (§7.1.14 StringToBigInt → StringIntegerLiteral):
 *
 *     StringIntegerLiteral ::: StrWhiteSpace?
 *                            | StrWhiteSpace? StrIntegerLiteral StrWhiteSpace?
 *     StrIntegerLiteral    ::: SignedInteger | NonDecimalIntegerLiteral
 *     SignedInteger        ::: DecimalDigits | + DecimalDigits | - DecimalDigits
 *     NonDecimalIntegerLiteral ::: 0x… | 0o… | 0b…  (NO leading sign)
 *
 * so: empty / all-whitespace → `0n`; a leading sign is decimal-only (`-0x10` is
 * a SyntaxError, exactly as `Number("-0x10")` is NaN, #3570's rule for the
 * sibling scanner); the WHOLE trimmed string must be consumed (`"12abc"` is a
 * SyntaxError, not `12n` — this is not `parseInt`'s longest-prefix rule); and a
 * radix prefix with no digits after it (`"0x"`) is a SyntaxError.
 *
 * RANGE. The standalone BigInt carrier is a single immutable i64
 * (`$BigInt`, registry/imports.ts), so this scanner is exact for
 * [-2^63, 2^63-1] and WRAPS modulo 2^64 above it — `i64.mul`/`i64.add` are
 * wrapping ops and neither traps. That is deliberately the SAME answer the rest
 * of the standalone BigInt lane already gives for arithmetic overflow
 * (`(2n**62n)*4n` wraps there too), so a literal and a parsed string agree; it
 * is not spec-arbitrary-precision, and making the parser trap or throw where
 * `*`/`+` silently wrap would be the surprising choice. Arbitrary precision is
 * a whole-lane change (a limb representation), not a parser change.
 *
 * Shape follows `string-number-bodies.ts`: a body-builder over caller-owned
 * locals, so the scan can be spliced INLINE into `__bigint_ctor` rather than
 * minted as its own function — inlining adds no entry to the function index
 * space, so no already-emitted `call` immediate shifts (the #6642/S59 Fix 1
 * hazard) and no module that does not reach `__bigint_ctor` moves a byte.
 */
import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";
import {
  C_MINUS,
  C_PLUS,
  C_ZERO,
  C_UC_B,
  C_UC_O,
  C_UC_X,
  C_LC_B,
  C_LC_O,
  C_LC_X,
  isWsBody,
  emitDigitValue,
} from "./string-number-grammar.js";

/** Local slots this scanner owns, relative to the caller-supplied base index. */
const O_FLAT = 0;
const O_DATA = 1;
const O_END = 2;
const O_I = 3;
const O_C = 4;
const O_NEG = 5;
const O_ACC = 6;
const O_RADIX = 7;
const O_DIG = 8;
const O_OK = 9;
const O_SAWDIGIT = 10;
const O_SAWSIGN = 11;

/** The locals `buildStringToBigIntBody` assumes, in order, starting at `base`. */
export function buildStringToBigIntLocals(layout: NativeStringLayout): LocalDef[] {
  const i32: ValType = { kind: "i32" };
  return [
    { name: "b2i_flat", type: { kind: "ref", typeIdx: layout.nativeStrTypeIdx } },
    { name: "b2i_data", type: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx } },
    { name: "b2i_end", type: i32 },
    { name: "b2i_i", type: i32 },
    { name: "b2i_c", type: i32 },
    { name: "b2i_neg", type: i32 },
    { name: "b2i_acc", type: { kind: "i64" } },
    { name: "b2i_radix", type: i32 },
    { name: "b2i_dig", type: i32 },
    { name: "b2i_ok", type: i32 },
    { name: "b2i_sawDigit", type: i32 },
    { name: "b2i_sawSign", type: i32 },
  ];
}

/**
 * Scan the `$AnyString` in `anyLocal` (an `anyref`-typed local already holding
 * `any.convert_extern` of the operand) as a StringIntegerLiteral.
 *
 * Leaves ONE `i64` on the stack. On a grammar violation it splices `onInvalid`
 * (the caller's SyntaxError throw) instead — the caller owns the error
 * machinery so this leaf module keeps no dependency on the import registry.
 *
 * @param base index of the first of `buildStringToBigIntLocals`' slots.
 */
export function buildStringToBigIntBody(
  layout: NativeStringLayout,
  flattenHandle: FuncHandle,
  anyLocal: number,
  base: number,
  onInvalid: Instr[],
): Instr[] {
  const strTypeIdx = layout.nativeStrTypeIdx;
  const dataTypeIdx = layout.nativeStrDataTypeIdx;
  const L = (offset: number): number => base + offset;
  const get = (offset: number): Instr => ({ op: "local.get", index: L(offset) });
  const set = (offset: number): Instr => ({ op: "local.set", index: L(offset) });
  const i32c = (value: number): Instr => ({ op: "i32.const", value });

  /** `c = data[i]` */
  const getC: Instr[] = [get(O_DATA), get(O_I), { op: "array.get_u", typeIdx: dataTypeIdx }, set(O_C)];
  /** `data[i + k]` on the stack. */
  const charAt = (k: number): Instr[] => [
    get(O_DATA),
    get(O_I),
    i32c(k),
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: dataTypeIdx },
  ];
  /** `i += k` */
  const advance = (k: number): Instr[] => [get(O_I), i32c(k), { op: "i32.add" }, set(O_I)];

  /** One `0<p>` radix-prefix arm; `elseArm` chains the next letter pair. */
  const radixArm = (upper: number, lower: number, radix: number, elseArm: Instr[]): Instr[] => [
    ...charAt(1),
    i32c(upper),
    { op: "i32.eq" },
    ...charAt(1),
    i32c(lower),
    { op: "i32.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [i32c(radix), set(O_RADIX), ...advance(2)],
      else: elseArm,
    },
  ];

  // flatten; data/i/end over the logical string (a flat string may carry a
  // nonzero `off`, exactly as the StringToNumber prelude handles).
  const body: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: layout.anyStrTypeIdx },
    { op: "call", funcIdx: flattenHandle },
    set(O_FLAT),
    get(O_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    set(O_DATA),
    get(O_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    set(O_I), // i = off
    get(O_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    get(O_I),
    { op: "i32.add" },
    set(O_END), // end = off + len

    // --- trim leading whitespace ---
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(O_I),
            get(O_END),
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            ...isWsBody(L(O_C)),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            ...advance(1),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // --- trim trailing whitespace ---
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(O_END),
            get(O_I),
            { op: "i32.le_s" },
            { op: "br_if", depth: 1 },
            get(O_DATA),
            get(O_END),
            i32c(1),
            { op: "i32.sub" },
            { op: "array.get_u", typeIdx: dataTypeIdx },
            set(O_C),
            ...isWsBody(L(O_C)),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            get(O_END),
            i32c(1),
            { op: "i32.sub" },
            set(O_END),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // acc = 0; neg = 0; sawSign = 0; sawDigit = 0; radix = 10; ok = 1
    // `ok` starts TRUE so the empty / all-whitespace string falls straight
    // out as `0n` (§7.1.14 step 2) without a dedicated arm.
    { op: "i64.const", value: 0n },
    set(O_ACC),
    i32c(0),
    set(O_NEG),
    i32c(0),
    set(O_SAWSIGN),
    i32c(0),
    set(O_SAWDIGIT),
    i32c(10),
    set(O_RADIX),
    i32c(1),
    set(O_OK),

    get(O_I),
    get(O_END),
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // --- optional sign (decimal only) ---
        ...getC,
        get(O_C),
        i32c(C_MINUS),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [i32c(1), set(O_NEG), i32c(1), set(O_SAWSIGN), ...advance(1)],
          else: [
            get(O_C),
            i32c(C_PLUS),
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [i32c(1), set(O_SAWSIGN), ...advance(1)],
            },
          ],
        },

        // --- NonDecimalIntegerLiteral prefix: no sign, "0" + x/o/b, >=2 left ---
        get(O_SAWSIGN),
        { op: "i32.eqz" },
        get(O_I),
        i32c(1),
        { op: "i32.add" },
        get(O_END),
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            get(O_DATA),
            get(O_I),
            { op: "array.get_u", typeIdx: dataTypeIdx },
            i32c(C_ZERO),
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: radixArm(C_UC_X, C_LC_X, 16, radixArm(C_UC_O, C_LC_O, 8, radixArm(C_UC_B, C_LC_B, 2, []))),
            },
          ],
        },

        // --- digit loop; every code unit up to `end` must be a digit of
        //     `radix`, and there must be at least one.
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                get(O_I),
                get(O_END),
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...getC,
                ...emitDigitValue(L(O_C), L(O_DIG)),
                get(O_DIG),
                i32c(0),
                { op: "i32.lt_s" },
                get(O_DIG),
                get(O_RADIX),
                { op: "i32.ge_s" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  // depth 2 = out of the enclosing `loop` AND its `block`.
                  then: [i32c(0), set(O_OK), { op: "br", depth: 2 }],
                },
                get(O_ACC),
                get(O_RADIX),
                { op: "i64.extend_i32_s" },
                { op: "i64.mul" },
                get(O_DIG),
                { op: "i64.extend_i32_s" },
                { op: "i64.add" },
                set(O_ACC),
                i32c(1),
                set(O_SAWDIGIT),
                ...advance(1),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },

        // A trimmed-non-empty literal with no digit at all ("+", "0x", "-")
        // is a SyntaxError, not 0n.
        get(O_SAWDIGIT),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [i32c(0), set(O_OK)],
        },

        get(O_NEG),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i64.const", value: 0n }, get(O_ACC), { op: "i64.sub" }, set(O_ACC)],
        },
      ],
    },

    get(O_OK),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: onInvalid },
    get(O_ACC),
  ];
  return body;
}
