// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Indexed representation for runtime-built, no-flags
 * `^(?:literal|literal|...)$` programs.
 *
 * The dynamic compiler stores the literal source body plus one
 * `(start,length,FNV)` record per alternative. The search helper hashes the
 * subject once, then uses length/hash as a rejection filter before an
 * authoritative UTF-16 comparison. Hash collisions therefore cannot change
 * RegExp semantics.
 */
import type { Instr, LocalDef, ValType } from "../ir/types.js";

export const REGEX_ANCHORED_LITERAL_ALT_HASH_MARKER = -0x3fffffff;
export const REGEX_ALT_HASH_OFFSET = 0x811c9dc5 | 0;
export const REGEX_ALT_HASH_PRIME = 0x01000193;

const I32: ValType = { kind: "i32" };

function enabled(): boolean {
  return process.env.JS2WASM_REGEX_ANCHORED_ALT_HASH !== "0";
}

function programCell(arrayTypeIdx: number, index: Instr[], value: Instr[]): Instr[] {
  return [
    { op: "local.get", index: 21 }, // PROG
    ...index,
    ...value,
    { op: "array.set", typeIdx: arrayTypeIdx },
  ];
}

/**
 * Emit the construction-time replacement for the legacy raw alternation
 * payload. Local indices intentionally mirror
 * `ensureDynamicStandaloneRegExpCompiler`; keeping this large emission block
 * isolated prevents that already-large orchestration function from regrowing.
 */
export function buildIndexedAnchoredLiteralAltProgram(arrayTypeIdx: number, stringDataTypeIdx: number): Instr[] {
  if (!enabled()) return [];

  const FBITS = 10;
  const I = 11;
  const CH = 12;
  const SIMPLE = 13;
  const ANCHORED = 14;
  const START = 15;
  const END = 16;
  const PIPES = 17;
  const CHARS = 18;
  const NINSTR = 19;
  const PROG = 21;
  const PC = 22;
  const J = 23;
  const K = 24;
  const ALTN = 29;
  const PLAIN = 30;
  const PDATA = 3;
  const POFF = 4;

  return [
    // Replace the raw pipe-delimited payload with an indexed sibling. The
    // source body stays intact for authoritative equality; metadata is built
    // once when the runtime RegExp is constructed.
    { op: "local.get", index: SIMPLE },
    { op: "local.get", index: ANCHORED },
    { op: "i32.and" },
    { op: "local.get", index: FBITS },
    { op: "i32.eqz" },
    { op: "i32.and" },
    { op: "local.get", index: PLAIN },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: END },
        { op: "local.get", index: START },
        { op: "i32.sub" },
        { op: "local.set", index: CHARS },
        { op: "local.get", index: PIPES },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: NINSTR },
        { op: "local.get", index: CHARS },
        { op: "local.get", index: NINSTR },
        { op: "i32.const", value: 3 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "i32.const", value: 3 },
        { op: "i32.add" },
        { op: "array.new_default", typeIdx: arrayTypeIdx },
        { op: "local.set", index: PROG },
        ...programCell(
          arrayTypeIdx,
          [{ op: "i32.const", value: 0 }],
          [{ op: "i32.const", value: REGEX_ANCHORED_LITERAL_ALT_HASH_MARKER }],
        ),
        ...programCell(arrayTypeIdx, [{ op: "i32.const", value: 1 }], [{ op: "local.get", index: CHARS }]),
        ...programCell(arrayTypeIdx, [{ op: "i32.const", value: 2 }], [{ op: "local.get", index: NINSTR }]),
        // PLAIN proves every source unit is the unit the regexp matches (no
        // escapes, wildcard, or other source-to-value transformation).
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: I },
                { op: "local.get", index: CHARS },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...programCell(
                  arrayTypeIdx,
                  [{ op: "i32.const", value: 3 }, { op: "local.get", index: I }, { op: "i32.add" }],
                  [
                    { op: "local.get", index: PDATA },
                    { op: "local.get", index: POFF },
                    { op: "local.get", index: START },
                    { op: "i32.add" },
                    { op: "local.get", index: I },
                    { op: "i32.add" },
                    { op: "array.get_u", typeIdx: stringDataTypeIdx },
                  ],
                ),
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Scan the copied body once and append metadata per alternative.
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I }, // raw cursor
        { op: "i32.const", value: 0 },
        { op: "local.set", index: J }, // current alternative start
        { op: "i32.const", value: 0 },
        { op: "local.set", index: K }, // alternative ordinal
        { op: "i32.const", value: REGEX_ALT_HASH_OFFSET },
        { op: "local.set", index: ALTN },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: I },
                { op: "local.get", index: CHARS },
                { op: "i32.gt_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: I },
                { op: "local.get", index: CHARS },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: -1 }],
                  else: [
                    { op: "local.get", index: PROG },
                    { op: "i32.const", value: 3 },
                    { op: "local.get", index: I },
                    { op: "i32.add" },
                    { op: "array.get", typeIdx: arrayTypeIdx },
                  ],
                },
                { op: "local.set", index: CH },
                { op: "local.get", index: I },
                { op: "local.get", index: CHARS },
                { op: "i32.eq" },
                { op: "local.get", index: CH },
                { op: "i32.const", value: 0x7c },
                { op: "i32.eq" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 3 },
                    { op: "local.get", index: CHARS },
                    { op: "i32.add" },
                    { op: "local.get", index: K },
                    { op: "i32.const", value: 3 },
                    { op: "i32.mul" },
                    { op: "i32.add" },
                    { op: "local.set", index: PC },
                    ...programCell(arrayTypeIdx, [{ op: "local.get", index: PC }], [{ op: "local.get", index: J }]),
                    ...programCell(
                      arrayTypeIdx,
                      [{ op: "local.get", index: PC }, { op: "i32.const", value: 1 }, { op: "i32.add" }],
                      [{ op: "local.get", index: I }, { op: "local.get", index: J }, { op: "i32.sub" }],
                    ),
                    ...programCell(
                      arrayTypeIdx,
                      [{ op: "local.get", index: PC }, { op: "i32.const", value: 2 }, { op: "i32.add" }],
                      [{ op: "local.get", index: ALTN }],
                    ),
                    { op: "local.get", index: K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: K },
                    { op: "local.get", index: I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: J },
                    { op: "i32.const", value: REGEX_ALT_HASH_OFFSET },
                    { op: "local.set", index: ALTN },
                  ],
                  else: [
                    { op: "local.get", index: ALTN },
                    { op: "local.get", index: CH },
                    { op: "i32.xor" },
                    { op: "i32.const", value: REGEX_ALT_HASH_PRIME },
                    { op: "i32.mul" },
                    { op: "local.set", index: ALTN },
                  ],
                },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Emit the search-time indexed matcher and its private locals. Indices 16–21
 * immediately follow `ensureRegexSearch`'s existing parameters and locals.
 */
export function buildIndexedAnchoredLiteralAltSearch(
  arrayTypeIdx: number,
  stringDataTypeIdx: number,
): { body: Instr[]; locals: LocalDef[] } {
  if (!enabled()) return { body: [], locals: [] };

  const PROG = 0;
  const SDATA = 3;
  const SOFF = 4;
  const SLEN = 5;
  const START = 6;
  const CAPS = 8;
  const ALT_POS = 12;
  const ALT_INDEX = 13;
  const ALT_MATCH = 14;
  const ALT_BODY_LEN = 15;
  const ALT_START = 16;
  const ALT_LEN = 17;
  const ALT_HASH = 18;
  const SUBJECT_HASH = 19;
  const ALT_COUNT = 20;
  const ALT_META = 21;

  const body: Instr[] = [
    // [marker, rawBodyLen, altCount, ...rawBody,
    //  start0, len0, hash0, start1, len1, hash1, ...]
    { op: "local.get", index: PROG },
    { op: "array.len" },
    { op: "i32.const", value: 3 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: PROG },
        { op: "i32.const", value: 0 },
        { op: "array.get", typeIdx: arrayTypeIdx },
        { op: "i32.const", value: REGEX_ANCHORED_LITERAL_ALT_HASH_MARKER },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // A non-multiline ^ can only match at index zero. Negative starts
            // are ToLength-clamped to zero by the ordinary path.
            { op: "local.get", index: START },
            { op: "i32.const", value: 0 },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
            { op: "local.get", index: PROG },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: arrayTypeIdx },
            { op: "local.set", index: ALT_BODY_LEN },
            { op: "local.get", index: PROG },
            { op: "i32.const", value: 2 },
            { op: "array.get", typeIdx: arrayTypeIdx },
            { op: "local.set", index: ALT_COUNT },
            // Hash the subject once, over its UTF-16 code units.
            { op: "i32.const", value: REGEX_ALT_HASH_OFFSET },
            { op: "local.set", index: SUBJECT_HASH },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: ALT_INDEX },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: ALT_INDEX },
                    { op: "local.get", index: SLEN },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: SUBJECT_HASH },
                    { op: "local.get", index: SDATA },
                    { op: "local.get", index: SOFF },
                    { op: "local.get", index: ALT_INDEX },
                    { op: "i32.add" },
                    { op: "array.get_u", typeIdx: stringDataTypeIdx },
                    { op: "i32.xor" },
                    { op: "i32.const", value: REGEX_ALT_HASH_PRIME },
                    { op: "i32.mul" },
                    { op: "local.set", index: SUBJECT_HASH },
                    { op: "local.get", index: ALT_INDEX },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: ALT_INDEX },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: ALT_POS },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: ALT_POS },
                    { op: "local.get", index: ALT_COUNT },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    // meta = 3 + rawBodyLen + 3 * alternativeIndex
                    { op: "i32.const", value: 3 },
                    { op: "local.get", index: ALT_BODY_LEN },
                    { op: "i32.add" },
                    { op: "local.get", index: ALT_POS },
                    { op: "i32.const", value: 3 },
                    { op: "i32.mul" },
                    { op: "i32.add" },
                    { op: "local.set", index: ALT_META },
                    { op: "local.get", index: PROG },
                    { op: "local.get", index: ALT_META },
                    { op: "array.get", typeIdx: arrayTypeIdx },
                    { op: "local.set", index: ALT_START },
                    { op: "local.get", index: PROG },
                    { op: "local.get", index: ALT_META },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "array.get", typeIdx: arrayTypeIdx },
                    { op: "local.set", index: ALT_LEN },
                    { op: "local.get", index: PROG },
                    { op: "local.get", index: ALT_META },
                    { op: "i32.const", value: 2 },
                    { op: "i32.add" },
                    { op: "array.get", typeIdx: arrayTypeIdx },
                    { op: "local.set", index: ALT_HASH },
                    { op: "local.get", index: ALT_LEN },
                    { op: "local.get", index: SLEN },
                    { op: "i32.eq" },
                    { op: "local.get", index: ALT_HASH },
                    { op: "local.get", index: SUBJECT_HASH },
                    { op: "i32.eq" },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "i32.const", value: 0 },
                        { op: "local.set", index: ALT_INDEX },
                        { op: "i32.const", value: 1 },
                        { op: "local.set", index: ALT_MATCH },
                        {
                          op: "block",
                          blockType: { kind: "empty" },
                          body: [
                            {
                              op: "loop",
                              blockType: { kind: "empty" },
                              body: [
                                { op: "local.get", index: ALT_INDEX },
                                { op: "local.get", index: ALT_LEN },
                                { op: "i32.ge_s" },
                                { op: "br_if", depth: 1 },
                                { op: "local.get", index: PROG },
                                { op: "i32.const", value: 3 },
                                { op: "local.get", index: ALT_START },
                                { op: "i32.add" },
                                { op: "local.get", index: ALT_INDEX },
                                { op: "i32.add" },
                                { op: "array.get", typeIdx: arrayTypeIdx },
                                { op: "local.get", index: SDATA },
                                { op: "local.get", index: SOFF },
                                { op: "local.get", index: ALT_INDEX },
                                { op: "i32.add" },
                                { op: "array.get_u", typeIdx: stringDataTypeIdx },
                                { op: "i32.ne" },
                                {
                                  op: "if",
                                  blockType: { kind: "empty" },
                                  then: [
                                    { op: "i32.const", value: 0 },
                                    { op: "local.set", index: ALT_MATCH },
                                    { op: "local.get", index: ALT_LEN },
                                    { op: "local.set", index: ALT_INDEX },
                                  ],
                                },
                                { op: "local.get", index: ALT_INDEX },
                                { op: "i32.const", value: 1 },
                                { op: "i32.add" },
                                { op: "local.set", index: ALT_INDEX },
                                { op: "br", depth: 0 },
                              ],
                            },
                          ],
                        },
                        { op: "local.get", index: ALT_MATCH },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: CAPS },
                            { op: "i32.const", value: 0 },
                            { op: "i32.const", value: 0 },
                            { op: "array.set", typeIdx: arrayTypeIdx },
                            { op: "local.get", index: CAPS },
                            { op: "i32.const", value: 1 },
                            { op: "local.get", index: SLEN },
                            { op: "array.set", typeIdx: arrayTypeIdx },
                            { op: "i32.const", value: 1 },
                            { op: "return" },
                          ],
                        },
                      ],
                    },
                    { op: "local.get", index: ALT_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: ALT_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "i32.const", value: 0 },
            { op: "return" },
          ],
        },
      ],
    },
  ];

  return {
    body,
    locals: [
      { name: "altStart", type: I32 },
      { name: "altLen", type: I32 },
      { name: "altHash", type: I32 },
      { name: "subjectHash", type: I32 },
      { name: "altCount", type: I32 },
      { name: "altMeta", type: I32 },
    ],
  };
}
