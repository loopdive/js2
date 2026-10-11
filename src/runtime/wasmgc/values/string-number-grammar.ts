// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";

export const C_TAB = 9;
export const C_LF = 10;
export const C_VT = 11;
export const C_FF = 12;
export const C_CR = 13;
export const C_SPACE = 32;
export const C_NBSP = 0xa0;
// §11.2 WhiteSpace (Zs category beyond NBSP) + §11.3 LineTerminator extras and
// the BOM/ZWNBSP. StrWhiteSpace for ToNumber/parseInt/parseFloat (§19.2.4/.5,
// §7.1.4.1) is WhiteSpace ∪ LineTerminator.
export const C_OGHAM_SP = 0x1680; // Zs OGHAM SPACE MARK
export const C_ENQUAD = 0x2000; // Zs range start (EN QUAD … HAIR SPACE)
export const C_HAIR_SP = 0x200a; // Zs range end
export const C_LS = 0x2028; // LINE SEPARATOR (LineTerminator)
export const C_PS = 0x2029; // PARAGRAPH SEPARATOR (LineTerminator)
export const C_NNBSP = 0x202f; // Zs NARROW NO-BREAK SPACE
export const C_MMSP = 0x205f; // Zs MEDIUM MATHEMATICAL SPACE
export const C_IDEO_SP = 0x3000; // Zs IDEOGRAPHIC SPACE
export const C_BOM = 0xfeff; // ZERO WIDTH NO-BREAK SPACE (BOM)
export const C_PLUS = 43;
export const C_MINUS = 45;
export const C_DOT = 46;
export const C_ZERO = 48;
export const C_NINE = 57;
export const C_UC_A = 65;
export const C_UC_B = 66;
export const C_UC_E = 69;
export const C_UC_O = 79;
export const C_UC_X = 88;
export const C_UC_Z = 90;
export const C_LC_A = 97;
export const C_LC_B = 98;
export const C_LC_E = 101;
export const C_LC_O = 111;
export const C_LC_X = 120;
export const C_LC_Z = 122;

/**
 * `isWhiteSpace(c)` inline test — the StrWhiteSpace set consumed by ToNumber /
 * parseInt / parseFloat (ECMA-262 §19.2.4/.5, §7.1.4.1) = WhiteSpace (§11.2) ∪
 * LineTerminator (§11.3): TAB, LF, VT, FF, CR, SP, NBSP, the BOM/ZWNBSP, the
 * LS/PS line terminators, and the Zs (space-separator) category — OGHAM SPACE,
 * the EN-QUAD..HAIR-SPACE range (U+2000–U+200A), NARROW/MEDIUM/IDEOGRAPHIC space.
 * Leaves i32 bool. Operand: the code unit is consumed via a local.
 */
export function isWsBody(cLocal: number): Instr[] {
  const get = (): Instr => ({ op: "local.get", index: cLocal });
  const eq = (code: number): Instr[] => [get(), { op: "i32.const", value: code }, { op: "i32.eq" }];
  // c >= lo && c <= hi  (the contiguous Zs run U+2000..U+200A).
  const inRange = (lo: number, hi: number): Instr[] => [
    get(),
    { op: "i32.const", value: lo },
    { op: "i32.ge_u" },
    get(),
    { op: "i32.const", value: hi },
    { op: "i32.le_u" },
    { op: "i32.and" },
  ];
  return [
    ...eq(C_SPACE),
    ...eq(C_TAB),
    { op: "i32.or" },
    ...eq(C_LF),
    { op: "i32.or" },
    ...eq(C_VT),
    { op: "i32.or" },
    ...eq(C_FF),
    { op: "i32.or" },
    ...eq(C_CR),
    { op: "i32.or" },
    ...eq(C_NBSP),
    { op: "i32.or" },
    ...eq(C_BOM),
    { op: "i32.or" },
    ...eq(C_LS),
    { op: "i32.or" },
    ...eq(C_PS),
    { op: "i32.or" },
    ...eq(C_OGHAM_SP),
    { op: "i32.or" },
    ...inRange(C_ENQUAD, C_HAIR_SP),
    { op: "i32.or" },
    ...eq(C_NNBSP),
    { op: "i32.or" },
    ...eq(C_MMSP),
    { op: "i32.or" },
    ...eq(C_IDEO_SP),
    { op: "i32.or" },
  ];
}

/**
 * `if (data[i..end] === "Infinity") return sign*Infinity`. Requires the match
 * to span exactly to `end` (StringToNumber is a full-match grammar).
 */
export function emitInfinityExact(
  L_I: number,
  L_END: number,
  L_DATA: number,
  L_SIGN: number,
  strDataTypeIdx: number,
): Instr[] {
  const word = "Infinity";
  const charChecks: Instr[] = [];
  for (let k = 0; k < word.length; k++) {
    charChecks.push({ op: "local.get", index: L_DATA });
    charChecks.push({ op: "local.get", index: L_I });
    charChecks.push({ op: "i32.const", value: k });
    charChecks.push({ op: "i32.add" });
    charChecks.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    charChecks.push({ op: "i32.const", value: word.charCodeAt(k) });
    charChecks.push({ op: "i32.eq" });
    if (k > 0) charChecks.push({ op: "i32.and" });
  }
  return [
    // require exactly word.length chars remaining: i + 8 == end
    { op: "local.get", index: L_I },
    { op: "i32.const", value: word.length },
    { op: "i32.add" },
    { op: "local.get", index: L_END },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charChecks,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_SIGN },
            { op: "f64.const", value: Infinity },
            { op: "f64.mul" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/**
 * Detect a `0x`/`0X`/`0o`/`0O`/`0b`/`0B` prefix at `L_I` and, if present, parse
 * the remainder as a NonDecimalIntegerLiteral in radix 16/8/2. The entire
 * remaining range must be valid digits, else NaN. Only fires when no sign was
 * consumed (sign==1) — a signed non-decimal literal is NaN per spec. Returns
 * directly from the enclosing function on a match (value or NaN).
 */
export function emitRadixPrefixParse(
  L_I: number,
  L_END: number,
  L_DATA: number,
  L_C: number,
  L_SAWSIGN: number,
  L_RADIX: number,
  L_DIG: number,
  L_RESULT: number,
  L_SAW: number,
  strDataTypeIdx: number,
): Instr[] {
  // Build a single prefix arm. Self-conditioned: it reads data[i+1] and uses
  // the (== lc || == uc) test as its own `if` condition, so multiple arms can
  // be sequenced inside the shared `0`-prefix guard — a non-matching arm is a
  // no-op and control falls through to the next arm.
  const buildArm = (lc: number, uc: number, radix: number): Instr[] => [
    // second char is lc/uc?
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.tee", index: L_C },
    { op: "i32.const", value: lc },
    { op: "i32.eq" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: uc },
    { op: "i32.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: radix },
        { op: "local.set", index: L_RADIX },
        // advance past "0x"/"0o"/"0b"
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 2 },
        { op: "i32.add" },
        { op: "local.set", index: L_I },
        // require at least one digit
        { op: "local.get", index: L_I },
        { op: "local.get", index: L_END },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: NaN }, { op: "return" }],
        },
        { op: "f64.const", value: 0 },
        { op: "local.set", index: L_RESULT },
        // digit loop over [i, end)
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_END },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...([
                  { op: "local.get", index: L_DATA },
                  { op: "local.get", index: L_I },
                  { op: "array.get_u", typeIdx: strDataTypeIdx },
                  { op: "local.set", index: L_C },
                ] satisfies Instr[]),
                ...emitDigitValue(L_C, L_DIG),
                // invalid digit or >= radix → NaN
                { op: "local.get", index: L_DIG },
                { op: "i32.const", value: 0 },
                { op: "i32.lt_s" },
                { op: "local.get", index: L_DIG },
                { op: "i32.const", value: radix },
                { op: "i32.ge_s" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "f64.const", value: NaN }, { op: "return" }],
                },
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: radix },
                { op: "f64.mul" },
                { op: "local.get", index: L_DIG },
                { op: "f64.convert_i32_s" },
                { op: "f64.add" },
                { op: "local.set", index: L_RESULT },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: L_RESULT },
        { op: "return" },
      ],
    },
  ];
  void L_SAW;
  return [
    // guard: NO sign char consumed (sawSign==0) && i+1 < end && data[i]=='0'.
    // (#3570) A NonDecimalIntegerLiteral admits no leading sign, so both
    // '+0x10' and '-0x10' must fall through to the decimal scanner → NaN. The
    // old `sign==1` test let '+' through (it leaves sign=+1); keying on the
    // explicit sawSign flag rejects both signs.
    { op: "local.get", index: L_SAWSIGN },
    { op: "i32.eqz" },
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    { op: "i32.and" },
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "i32.const", value: C_ZERO },
    { op: "i32.eq" },
    { op: "i32.and" },
    // §7.1.4.1 StringToNumber: 0x/0X → hex, 0o/0O → octal, 0b/0B → binary.
    // Each arm re-reads data[i+1] and only acts on its prefix letter, so a
    // non-matching arm is a no-op and control falls through to the next.
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...buildArm(C_LC_X, C_UC_X, 16), ...buildArm(C_LC_O, C_UC_O, 8), ...buildArm(C_LC_B, C_UC_B, 2)],
    },
  ];
}

/** Emit `if (substring starting at i == "Infinity") return sign*Infinity`. */
export function emitInfinityCheck(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_SIGN: number,
  strDataTypeIdx: number,
): Instr[] {
  const word = "Infinity";
  // The array reads must be guarded by the length check FIRST — Wasm `i32.and`
  // does not short-circuit, so reading data[i+k] before confirming i+8<=len
  // would trap (array OOB). Structure: if (i+8<=len) { chained char compare; if
  // (allMatch) return sign*Infinity }.
  const charChecks: Instr[] = [];
  for (let k = 0; k < word.length; k++) {
    charChecks.push({ op: "local.get", index: L_DATA });
    charChecks.push({ op: "local.get", index: L_I });
    charChecks.push({ op: "i32.const", value: k });
    charChecks.push({ op: "i32.add" });
    charChecks.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    charChecks.push({ op: "i32.const", value: word.charCodeAt(k) });
    charChecks.push({ op: "i32.eq" });
    if (k > 0) charChecks.push({ op: "i32.and" });
  }
  void L_C;
  return [
    { op: "local.get", index: L_I },
    { op: "i32.const", value: word.length },
    { op: "i32.add" },
    { op: "local.get", index: L_LEN },
    { op: "i32.le_s" }, // i+8 <= len
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charChecks,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_SIGN },
            { op: "f64.const", value: Infinity },
            { op: "f64.mul" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Scan optional exponent `[eE][+-]?digits`, accumulating into L_EXP / L_EXPSIGN. */
export function emitExponent(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_EXP: number,
  L_EXPSIGN: number,
  strDataTypeIdx: number,
  getC: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_LC_E },
        { op: "i32.eq" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_E },
        { op: "i32.eq" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // tentatively consume 'e'
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            // optional sign
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...getC,
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_MINUS },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: L_EXPSIGN },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                  ],
                  else: [
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_PLUS },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: L_I },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: L_I },
                      ],
                    },
                  ],
                },
              ],
            },
            // exponent digits
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: L_I },
                    { op: "local.get", index: L_LEN },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_DATA },
                    { op: "local.get", index: L_I },
                    { op: "array.get_u", typeIdx: strDataTypeIdx },
                    { op: "local.set", index: L_C },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.lt_s" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_NINE },
                    { op: "i32.gt_s" },
                    { op: "i32.or" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_EXP },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: L_EXP },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Map code unit in L_C to its digit value in L_DIG: '0'-'9' → 0-9,
 * 'A'-'Z'/'a'-'z' → 10-35, else -1.
 */
export function emitDigitValue(L_C: number, L_DIG: number): Instr[] {
  return [
    { op: "i32.const", value: -1 },
    { op: "local.set", index: L_DIG },
    // 0-9
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_ZERO },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_NINE },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_ZERO },
        { op: "i32.sub" },
        { op: "local.set", index: L_DIG },
      ],
      else: [
        // A-Z
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_A },
        { op: "i32.ge_s" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_Z },
        { op: "i32.le_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_UC_A - 10 },
            { op: "i32.sub" },
            { op: "local.set", index: L_DIG },
          ],
          else: [
            // a-z
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_A },
            { op: "i32.ge_s" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_Z },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_LC_A - 10 },
                { op: "i32.sub" },
                { op: "local.set", index: L_DIG },
              ],
            },
          ],
        },
      ],
    },
  ];
}
