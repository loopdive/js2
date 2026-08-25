// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4065 / #4042 — the *tokenisation* of a runtime-built RegExp pattern.
 *
 * `ensureDynamicStandaloneRegExpCompiler` (regexp-standalone.ts) parses a
 * pattern that is only known at run time. It walks the pattern **three
 * times**: once to count program records (`CHARS`/`PIPES`), once to find the
 * next alternation `|`, and once to emit the records. Every one of those walks
 * used to advance **one source code unit at a time** and re-derive the
 * character semantics itself — and only the *third* one knew that `.` means
 * `ReOp.ANY`. That was safe purely because every construct the runtime grammar
 * accepted happened to be exactly one code unit wide, so "source units" and
 * "program records" were the same number. The invariant was never written
 * down; it was implicit in `CHARS` on one side and the expression `J - I` on
 * the other — two independent derivations of the same quantity.
 *
 * A `CharacterEscape` breaks it: `\x41` is four source units and **one**
 * record. Adding escapes to the emitter alone would have desynchronised the
 * record count from the allocated `NINSTR * 3` program array, i.e. produced a
 * silently wrong program rather than a loud refusal.
 *
 * So the token decision lives here, once, and all three walks call it. The
 * module owns the *grammar* question ("what is the next token, and how wide is
 * it?"); regexp-standalone.ts keeps the program-emission plumbing.
 *
 * The decoder is deliberately **conservative**: anything it is not certain of
 * decodes as `TOKEN_UNSUPPORTED`, which makes the caller fall back to the
 * existing catchable `TypeError`. A refusal is recoverable; a wrong match is
 * not.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import {
  ReOp,
  RE_FLAG_D,
  RE_FLAG_G,
  RE_FLAG_I,
  RE_FLAG_M,
  RE_FLAG_S,
  RE_FLAG_U,
  RE_FLAG_V,
  RE_FLAG_Y,
} from "./regex/bytecode.js";

/** Token kinds, packed into bits 0..3 of the decoder's result. */
export const TOKEN_UNSUPPORTED = 0;
/** A single literal code unit; the unit is in bits 9..24. */
export const TOKEN_LITERAL = 1;
/** `.` — compiles to `ReOp.ANY`. */
export const TOKEN_ANY = 2;
/** `|` — alternation separator. */
export const TOKEN_PIPE = 3;
/** `*` — greedy zero-or-more quantifier (Annex B `\\c` fallback only). */
export const TOKEN_STAR = 4;
/** `+` — greedy one-or-more quantifier (Annex B `\\c` fallback only). */
export const TOKEN_PLUS = 5;
/** `?` — greedy zero-or-one quantifier (Annex B `\\c` fallback only). */
export const TOKEN_OPT = 6;
/** `(` or `(?:` — a group opener; value 1 denotes non-capturing `(?:`. */
export const TOKEN_GROUP_OPEN = 7;
/** `)` — a group closer. */
export const TOKEN_GROUP_CLOSE = 8;

/**
 * The decoder packs its answer into one i32 so the callers need no
 * multi-value plumbing:
 *
 *   bits 0..3   kind      (TOKEN_*)
 *   bits 4..8   len       source code units consumed (always >= 1)
 *   bits 9..24  value     literal code unit, for TOKEN_LITERAL
 */
export const TOKEN_KIND_MASK = 0xf;
export const TOKEN_LEN_SHIFT = 4;
export const TOKEN_LEN_MASK = 0x1f;
export const TOKEN_VALUE_SHIFT = 9;

const DYN_TOKEN_HELPER = "__regex_dyn_token";
const DYN_NAMED_GROUP_HELPER = "__regex_dyn_named_group";

/** `kind | len << 4 | value << 9`, as a constant-folded i32 where possible. */
function packConst(kind: number, len: number, value: number): Instr[] {
  return [{ op: "i32.const", value: kind | (len << TOKEN_LEN_SHIFT) | (value << TOKEN_VALUE_SHIFT) }];
}

/** `kind | len << 4 | (<value instrs>) << 9` for a runtime-computed unit. */
function packDynamic(kind: number, len: number, value: Instr[]): Instr[] {
  return [
    ...value,
    { op: "i32.const", value: TOKEN_VALUE_SHIFT },
    { op: "i32.shl" },
    { op: "i32.const", value: kind | (len << TOKEN_LEN_SHIFT) },
    { op: "i32.or" },
  ];
}

/** Value-producing `if` chain — the idiom already used by `flagBit()`. */
function cond(test: Instr[], thenV: Instr[], elseV: Instr[]): Instr[] {
  return [...test, { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: thenV, else: elseV }];
}

const eqConst = (local: number, ch: number): Instr[] => [
  { op: "local.get", index: local },
  { op: "i32.const", value: ch },
  { op: "i32.eq" },
];

const inRange = (local: number, lo: number, hi: number): Instr[] => [
  { op: "local.get", index: local },
  { op: "i32.const", value: lo },
  { op: "i32.ge_s" },
  { op: "local.get", index: local },
  { op: "i32.const", value: hi },
  { op: "i32.le_s" },
  { op: "i32.and" },
];

/** Decode a conservative ASCII IdentifierName in `(?<name>` to a group token. */
// prettier-ignore
function ensureDynamicNamedGroupTokenDecoder(ctx: CodegenContext, strDataRef: ValType): number {
  const existing = ctx.nativeRegexHelpers.get(DYN_NAMED_GROUP_HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [strDataRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set(DYN_NAMED_GROUP_HELPER, funcIdx); ctx.funcMap.set(DYN_NAMED_GROUP_HELPER, funcIdx);
  const [PDATA, POFF, I, END, START, NAME, CH, VALID, LEN] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const dataTypeIdx = (strDataRef as { typeIdx: number }).typeIdx;
  const load = (local: number): Instr[] => [{ op: "local.get", index: local }];
  const read = (local: number): Instr[] => [{ op: "local.get", index: PDATA }, { op: "local.get", index: POFF }, { op: "local.get", index: local }, { op: "i32.add" }, { op: "array.get_u", typeIdx: dataTypeIdx }];
  const set = (local: number): Instr[] => [{ op: "local.set", index: local }];
  const c = (value: number): Instr[] => [{ op: "i32.const", value }];
  const anyOf = (local: number, units: number[]): Instr[] => units.flatMap((unit, n) => [...eqConst(local, unit), ...(n ? ([{ op: "i32.or" }] as Instr[]) : [])]);
  const letters = [...Array.from({ length: 26 }, (_, n) => 0x41 + n), ...Array.from({ length: 26 }, (_, n) => 0x61 + n)];
  const start = anyOf(CH, [...letters, 0x24, 0x5f]);
  const cont = anyOf(CH, [...letters, 0x24, 0x5f, ...Array.from({ length: 10 }, (_, n) => 0x30 + n)]);
  const loopBody: Instr[] = [
    ...load(NAME), ...load(END), { op: "i32.ge_s" }, { op: "br_if", depth: 1 }, ...read(NAME), ...set(CH), ...eqConst(CH, 0x3e),
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 }], else: [
      ...eqConst(NAME, START), { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: start, else: cont },
      { op: "local.get", index: VALID }, { op: "i32.and" }, ...set(VALID), ...load(NAME), ...c(1), { op: "i32.add" }, ...set(NAME),
    ] },
    { op: "br", depth: 0 },
  ];
  const scan: Instr[] = [
    ...load(I), ...c(3), { op: "i32.add" }, ...set(START), ...load(START), ...set(NAME), ...c(1), ...set(VALID),
    { op: "block", blockType: { kind: "empty" }, body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }] },
    ...load(NAME), ...load(I), { op: "i32.sub" }, ...c(1), { op: "i32.add" }, ...set(LEN),
    { op: "local.get", index: VALID },
    { op: "local.get", index: NAME }, { op: "local.get", index: END }, { op: "i32.lt_s" }, { op: "i32.and" },
    { op: "local.get", index: NAME }, { op: "local.get", index: START }, { op: "i32.gt_s" }, { op: "i32.and" },
    { op: "local.get", index: LEN }, ...c(TOKEN_LEN_MASK), { op: "i32.le_s" }, { op: "i32.and" },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [...load(LEN), ...c(TOKEN_LEN_SHIFT), { op: "i32.shl" }, ...c(TOKEN_GROUP_OPEN), { op: "i32.or" }], else: packConst(TOKEN_UNSUPPORTED, 1, 0) },
  ];
  pushDefinedFunc(ctx, funcIdx, { name: DYN_NAMED_GROUP_HELPER, typeIdx, locals: [{ name: "start", type: { kind: "i32" } }, { name: "name", type: { kind: "i32" } }, { name: "ch", type: { kind: "i32" } }, { name: "valid", type: { kind: "i32" } }, { name: "len", type: { kind: "i32" } }], body: scan, exported: false });
  return funcIdx;
}

/**
 * Emit (once) `__regex_dyn_token(pdata, poff, i, end) -> i32`.
 *
 * Grammar recognised, all of it §22.2.1 `CharacterEscape` plus the two atoms
 * the pre-existing runtime grammar already had:
 *
 * | source            | token                        | len |
 * | ----------------- | ---------------------------- | --- |
 * | `\|`              | PIPE                         | 1   |
 * | `.`               | ANY                          | 1   |
 * | `\xHH`            | LITERAL(hex)                 | 4   |
 * | `\uHHHH`          | LITERAL(hex)                 | 6   |
 * | `\cA`..`\cz`      | LITERAL(letter % 32)         | 3   |
 * | `\c` + other      | LITERAL(`\`)  (Annex B)      | 1   |
 * | `\f\n\r\t\v`      | LITERAL(control)             | 2   |
 * | `\` + non-alnum   | LITERAL(that unit)           | 2   |
 * | `\\c` + `*+?`       | STAR/PLUS/OPT quantifier      | 1   |
 * | `\\c` + `{}`        | LITERAL(that unit)            | 1   |
 * | `(`                 | GROUP_OPEN (capturing)        | 1   |
 * | `(?:`               | GROUP_OPEN (non-capturing)    | 3   |
 * | `)`                 | GROUP_CLOSE                   | 1   |
 * | ordinary unit     | LITERAL(unit)                | 1   |
 * | anything else     | UNSUPPORTED                  | 1   |
 *
 * Deliberately UNSUPPORTED (each would need engine features this runtime
 * grammar does not have, and guessing would risk a wrong match):
 * `\d \D \s \S \w \W \b \B \k \p \P`, octal / back-references (`\1`),
 * every other `\`+alphanumeric, and the metacharacters `^ $ * + ? [ ] { }`.
 * Plain and non-capturing group envelopes are tokenised explicitly; the
 * runtime compiler validates their nesting before emitting SAVE records.
 *
 * `\c` not followed by an ASCII letter decodes as a **literal backslash of
 * width 1**, so the trailing `c` is re-scanned as its own literal token. That
 * is Annex B `SourceCharacterIdentityEscape` behaviour and is what makes
 * `new RegExp("\\c" + cyrillicLetter)` match a literal `\c…` instead of a
 * control character.
 */
export function ensureDynamicPatternTokenDecoder(ctx: CodegenContext, strDataRef: ValType): number {
  const existing = ctx.nativeRegexHelpers.get(DYN_TOKEN_HELPER);
  if (existing !== undefined) return existing;

  const typeIdx = addFuncType(ctx, [strDataRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set(DYN_TOKEN_HELPER, funcIdx);
  ctx.funcMap.set(DYN_TOKEN_HELPER, funcIdx);
  const namedGroupDecoderIdx = ensureDynamicNamedGroupTokenDecoder(ctx, strDataRef);

  const PDATA = 0;
  const POFF = 1;
  const I = 2;
  const END = 3;
  // Lookahead units 0..5 relative to `i`; -1 when past `end`.
  const C = 4;
  const D = 5;
  const E = 6;
  const F = 7;
  const G = 8;
  const H = 9;
  // Hex values of E/F/G/H; -1 when the unit is not a hex digit.
  const HE = 10;
  const HF = 11;
  const HG = 12;
  const HH = 13;

  const dataTypeIdx = (strDataRef as { typeIdx: number }).typeIdx;

  /** `pdata[poff + i + delta]`, or -1 when `i + delta >= end`. */
  const readAhead = (delta: number): Instr[] => [
    { op: "local.get", index: I },
    { op: "i32.const", value: delta },
    { op: "i32.add" },
    { op: "local.get", index: END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: PDATA },
        { op: "local.get", index: POFF },
        { op: "local.get", index: I },
        { op: "i32.add" },
        { op: "i32.const", value: delta },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: dataTypeIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
  ];

  /** Read a preceding source unit, or -1 before the pattern start. */
  const readBehind = (delta: number): Instr[] => [
    { op: "local.get", index: I },
    { op: "i32.const", value: delta },
    { op: "i32.add" },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: PDATA },
        { op: "local.get", index: POFF },
        { op: "local.get", index: I },
        { op: "i32.const", value: delta },
        { op: "i32.add" },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: dataTypeIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
  ];

  /** Hex digit value of `local`, or -1. */
  const hexOf = (local: number): Instr[] =>
    cond(
      inRange(local, 0x30, 0x39),
      [{ op: "local.get", index: local }, { op: "i32.const", value: 0x30 }, { op: "i32.sub" }],
      cond(
        inRange(local, 0x41, 0x46),
        [{ op: "local.get", index: local }, { op: "i32.const", value: 0x37 }, { op: "i32.sub" }],
        cond(
          inRange(local, 0x61, 0x66),
          [{ op: "local.get", index: local }, { op: "i32.const", value: 0x57 }, { op: "i32.sub" }],
          [{ op: "i32.const", value: -1 }],
        ),
      ),
    );

  const isAsciiLetter = (local: number): Instr[] => [
    ...inRange(local, 0x41, 0x5a),
    ...inRange(local, 0x61, 0x7a),
    { op: "i32.or" },
  ];

  /** Letters and digits — `\`+these is refused rather than guessed. */
  const isAlnum = (local: number): Instr[] => [
    ...isAsciiLetter(local),
    ...inRange(local, 0x30, 0x39),
    { op: "i32.or" },
  ];

  const UNSUPPORTED = packConst(TOKEN_UNSUPPORTED, 1, 0);

  // ---- `\` escapes ------------------------------------------------------
  const hexPairOk: Instr[] = [
    { op: "local.get", index: HE },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: HF },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "i32.and" },
  ];
  const hexQuadOk: Instr[] = [
    ...hexPairOk,
    { op: "local.get", index: HG },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "i32.and" },
    { op: "local.get", index: HH },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "i32.and" },
  ];

  // \xHH  -> HE*16 + HF
  const hexEscape = cond(
    hexPairOk,
    packDynamic(TOKEN_LITERAL, 4, [
      { op: "local.get", index: HE },
      { op: "i32.const", value: 4 },
      { op: "i32.shl" },
      { op: "local.get", index: HF },
      { op: "i32.or" },
    ]),
    UNSUPPORTED,
  );

  // \uHHHH -> HE<<12 | HF<<8 | HG<<4 | HH
  const unicodeEscape = cond(
    hexQuadOk,
    packDynamic(TOKEN_LITERAL, 6, [
      { op: "local.get", index: HE },
      { op: "i32.const", value: 12 },
      { op: "i32.shl" },
      { op: "local.get", index: HF },
      { op: "i32.const", value: 8 },
      { op: "i32.shl" },
      { op: "i32.or" },
      { op: "local.get", index: HG },
      { op: "i32.const", value: 4 },
      { op: "i32.shl" },
      { op: "i32.or" },
      { op: "local.get", index: HH },
      { op: "i32.or" },
    ]),
    UNSUPPORTED,
  );

  // \cX -> X % 32 when X is an ASCII letter; otherwise Annex B literal `\`.
  const controlEscape = cond(
    isAsciiLetter(E),
    packDynamic(TOKEN_LITERAL, 3, [{ op: "local.get", index: E }, { op: "i32.const", value: 31 }, { op: "i32.and" }]),
    packConst(TOKEN_LITERAL, 1, 0x5c),
  );

  // \f \n \r \t \v
  const controlLetterEscape = cond(
    eqConst(D, 0x66),
    packConst(TOKEN_LITERAL, 2, 0x0c),
    cond(
      eqConst(D, 0x6e),
      packConst(TOKEN_LITERAL, 2, 0x0a),
      cond(
        eqConst(D, 0x72),
        packConst(TOKEN_LITERAL, 2, 0x0d),
        cond(
          eqConst(D, 0x74),
          packConst(TOKEN_LITERAL, 2, 0x09),
          cond(
            eqConst(D, 0x76),
            packConst(TOKEN_LITERAL, 2, 0x0b),
            // Any other letter/digit after `\` is a class escape, an
            // assertion, a back-reference or an octal escape — refuse.
            // Everything else is an Annex B IdentityEscape.
            cond(isAlnum(D), UNSUPPORTED, packDynamic(TOKEN_LITERAL, 2, [{ op: "local.get", index: D }])),
          ),
        ),
      ),
    ),
  );

  const backslash = cond(
    [{ op: "local.get", index: D }, { op: "i32.const", value: 0 }, { op: "i32.lt_s" }],
    UNSUPPORTED, // trailing `\`
    cond(
      eqConst(D, 0x78),
      hexEscape,
      cond(eqConst(D, 0x75), unicodeEscape, cond(eqConst(D, 0x63), controlEscape, controlLetterEscape)),
    ),
  );

  // ---- metacharacters the runtime grammar cannot compile ----------------
  const isMeta: Instr[] = (() => {
    const units = "^$*+?()[]{}".split("").map((ch) => ch.charCodeAt(0));
    const out: Instr[] = [];
    units.forEach((u, idx) => {
      out.push({ op: "local.get", index: C }, { op: "i32.const", value: u }, { op: "i32.eq" });
      if (idx > 0) out.push({ op: "i32.or" });
    });
    return out;
  })();

  // Annex B's `\\c` fallback consumes only the backslash. The following `c`
  // is an ordinary atom, so `\\c*`, `\\c+`, and `\\c?` quantify that `c`;
  // unmatched braces remain literal identity escapes. Keep this context local
  // to the fallback so ordinary dynamic `a*b` remains a loud refusal.
  const annexBControlFallbackMeta: Instr[] = [
    ...readBehind(-1),
    { op: "i32.const", value: 0x63 },
    { op: "i32.eq" },
    ...readBehind(-2),
    { op: "i32.const", value: 0x5c },
    { op: "i32.eq" },
    { op: "i32.and" },
  ];

  const annexBControlFallbackLiteral = cond(
    annexBControlFallbackMeta,
    packDynamic(TOKEN_LITERAL, 1, [{ op: "local.get", index: C }]),
    cond(isMeta, UNSUPPORTED, packDynamic(TOKEN_LITERAL, 1, [{ op: "local.get", index: C }])),
  );

  const annexBControlFallbackQuantifier = (kind: number): Instr[] =>
    cond(annexBControlFallbackMeta, packConst(kind, 1, 0), annexBControlFallbackLiteral);

  const body: Instr[] = [
    ...readAhead(0),
    { op: "local.set", index: C },
    ...readAhead(1),
    { op: "local.set", index: D },
    ...readAhead(2),
    { op: "local.set", index: E },
    ...readAhead(3),
    { op: "local.set", index: F },
    ...readAhead(4),
    { op: "local.set", index: G },
    ...readAhead(5),
    { op: "local.set", index: H },
    // For `\xHH` the hex pair is at E,F; for `\uHHHH` it is E,F,G,H.
    ...hexOf(E),
    { op: "local.set", index: HE },
    ...hexOf(F),
    { op: "local.set", index: HF },
    ...hexOf(G),
    { op: "local.set", index: HG },
    ...hexOf(H),
    { op: "local.set", index: HH },
    ...cond(
      eqConst(C, 0x7c),
      packConst(TOKEN_PIPE, 1, 0),
      cond(
        eqConst(C, 0x2e),
        packConst(TOKEN_ANY, 1, 0),
        cond(
          eqConst(C, 0x28),
          cond(
            eqConst(D, 0x3f),
            cond(
              eqConst(E, 0x3a),
              packConst(TOKEN_GROUP_OPEN, 3, 1),
              cond(
                eqConst(E, 0x3c),
                [
                  { op: "local.get", index: PDATA },
                  { op: "local.get", index: POFF },
                  { op: "local.get", index: I },
                  { op: "local.get", index: END },
                  { op: "call", funcIdx: namedGroupDecoderIdx },
                ],
                UNSUPPORTED,
              ),
            ),
            packConst(TOKEN_GROUP_OPEN, 1, 0),
          ),
          cond(
            eqConst(C, 0x29),
            packConst(TOKEN_GROUP_CLOSE, 1, 0),
            cond(
              eqConst(C, 0x2a),
              annexBControlFallbackQuantifier(TOKEN_STAR),
              cond(
                eqConst(C, 0x2b),
                annexBControlFallbackQuantifier(TOKEN_PLUS),
                cond(
                  eqConst(C, 0x3f),
                  annexBControlFallbackQuantifier(TOKEN_OPT),
                  cond(eqConst(C, 0x5c), backslash, annexBControlFallbackLiteral),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: DYN_TOKEN_HELPER,
    typeIdx,
    locals: [
      { name: "c", type: { kind: "i32" } },
      { name: "d", type: { kind: "i32" } },
      { name: "e", type: { kind: "i32" } },
      { name: "f", type: { kind: "i32" } },
      { name: "g", type: { kind: "i32" } },
      { name: "h", type: { kind: "i32" } },
      { name: "he", type: { kind: "i32" } },
      { name: "hf", type: { kind: "i32" } },
      { name: "hg", type: { kind: "i32" } },
      { name: "hh", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Caller locals the accessors below read. */
export interface DynamicPatternLocals {
  /** `ref $NativeStrData` holding the pattern's code units. */
  pdata: number;
  /** Offset of the pattern's first unit within `pdata`. */
  poff: number;
  /** One past the last pattern unit to consider. */
  end: number;
  /** i32 scratch holding the packed token most recently decoded. */
  tok: number;
  /** i32 scratch holding a decoded literal code unit. */
  ch: number;
  /** i32 holding the parsed flag bits. */
  fbits: number;
}

/**
 * The read side of the token format, kept next to the writer so the packing
 * and unpacking cannot drift apart. Returned as builders over the caller's
 * own local indices; the caller owns the traversal, this owns the encoding.
 */
export interface DynamicPatternAccessors {
  /** `tok = __regex_dyn_token(pdata, poff, <indexLocal>, end)` */
  readToken(indexLocal: number): Instr[];
  /** `(tok & KIND_MASK) == kind` */
  kindIs(kind: number): Instr[];
  /** the token's source width, always >= 1 */
  len(): Instr[];
  /** the token's literal code unit */
  value(): Instr[];
  /** `<indexLocal> += len` — the ONLY sanctioned way to advance a walk */
  advance(indexLocal: number): Instr[];
  /**
   * The match operand for a literal unit in `ch`: folded to lower case when
   * the `i` flag is set, so `ReOp.CHARI` compares case-insensitively.
   */
  charOperand(): Instr[];
  /** Maps the flag character in `ch` to its `RE_FLAG_*` bit, or 0. */
  flagBit(): Instr[];
  /** `ReOp.ANY` for a `.` token, else `ReOp.CHARI`/`ReOp.CHAR` per the `i` flag. */
  recordOp(): Instr[];
}

export function makeDynamicPatternAccessors(decoderIdx: number, L: DynamicPatternLocals): DynamicPatternAccessors {
  const kind = (): Instr[] => [
    { op: "local.get", index: L.tok },
    { op: "i32.const", value: TOKEN_KIND_MASK },
    { op: "i32.and" },
  ];
  const len = (): Instr[] => [
    { op: "local.get", index: L.tok },
    { op: "i32.const", value: TOKEN_LEN_SHIFT },
    { op: "i32.shr_u" },
    { op: "i32.const", value: TOKEN_LEN_MASK },
    { op: "i32.and" },
  ];
  const kindIs = (k: number): Instr[] => [...kind(), { op: "i32.const", value: k }, { op: "i32.eq" }];
  return {
    readToken: (indexLocal: number) => [
      { op: "local.get", index: L.pdata },
      { op: "local.get", index: L.poff },
      { op: "local.get", index: indexLocal },
      { op: "local.get", index: L.end },
      { op: "call", funcIdx: decoderIdx },
      { op: "local.set", index: L.tok },
    ],
    kindIs,
    len,
    value: () => [
      { op: "local.get", index: L.tok },
      { op: "i32.const", value: TOKEN_VALUE_SHIFT },
      { op: "i32.shr_u" },
      { op: "i32.const", value: 0xffff },
      { op: "i32.and" },
    ],
    advance: (indexLocal: number) => [
      { op: "local.get", index: indexLocal },
      ...len(),
      { op: "i32.add" },
      { op: "local.set", index: indexLocal },
    ],
    charOperand: () => [
      { op: "local.get", index: L.fbits },
      { op: "i32.const", value: RE_FLAG_I },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          ...inRange(L.ch, 0x41, 0x5a),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "local.get", index: L.ch }, { op: "i32.const", value: 0x20 }, { op: "i32.add" }],
            else: [{ op: "local.get", index: L.ch }],
          },
        ],
        else: [{ op: "local.get", index: L.ch }],
      },
    ],
    flagBit: () => {
      const entries: Array<[number, number]> = [
        ["g".charCodeAt(0), RE_FLAG_G],
        ["i".charCodeAt(0), RE_FLAG_I],
        ["m".charCodeAt(0), RE_FLAG_M],
        ["s".charCodeAt(0), RE_FLAG_S],
        ["u".charCodeAt(0), RE_FLAG_U],
        ["y".charCodeAt(0), RE_FLAG_Y],
        ["d".charCodeAt(0), RE_FLAG_D],
        ["v".charCodeAt(0), RE_FLAG_V],
      ];
      let tail: Instr[] = [{ op: "i32.const", value: 0 }];
      for (let idx = entries.length - 1; idx >= 0; idx--) {
        const [unit, bit] = entries[idx]!;
        tail = [
          ...eqConst(L.ch, unit),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: bit }],
            else: tail,
          },
        ];
      }
      return tail;
    },
    recordOp: () => [
      ...kindIs(TOKEN_ANY),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ReOp.ANY }],
        else: [
          { op: "local.get", index: L.fbits },
          { op: "i32.const", value: RE_FLAG_I },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: ReOp.CHARI }],
            else: [{ op: "i32.const", value: ReOp.CHAR }],
          },
        ],
      },
    ],
  };
}
