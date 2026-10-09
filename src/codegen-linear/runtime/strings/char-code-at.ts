// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import { LINEAR_STRING_LENGTH_OFFSET, LINEAR_STRING_ELEMENTS_OFFSET } from "../../../ir/analysis/linear-memory-plan.js";

/** Build fresh decoder instructions using the caller-resolved ASCII helper and five i32 locals. */
export function buildLinearCharCodeAtBody(asciiFuncIdx: number, firstLocalIdx: number): Instr[] {
  const byteLen = firstLocalIdx;
  const bytePos = firstLocalIdx + 1;
  const unitPos = firstLocalIdx + 2;
  const lead = firstLocalIdx + 3;
  const codePoint = firstLocalIdx + 4;

  const loadByte = (delta: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "local.get", index: bytePos },
    { op: "i32.add" },
    { op: "i32.load8_u", align: 0, offset: LINEAR_STRING_ELEMENTS_OFFSET + delta },
  ];
  const returnIfRequested = (value: readonly Instr[], unitDelta = 0): Instr[] => {
    const unitDeltaOps: Instr[] = unitDelta === 0 ? [] : [{ op: "i32.const", value: unitDelta }, { op: "i32.add" }];
    return [
      { op: "local.get", index: unitPos },
      ...unitDeltaOps,
      { op: "local.get", index: 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...value, { op: "f64.convert_i32_u" }, { op: "return" }],
      },
    ];
  };
  const advance = (bytes: number, units: number): Instr[] => [
    { op: "local.get", index: bytePos },
    { op: "i32.const", value: bytes },
    { op: "i32.add" },
    { op: "local.set", index: bytePos },
    { op: "local.get", index: unitPos },
    { op: "i32.const", value: units },
    { op: "i32.add" },
    { op: "local.set", index: unitPos },
  ];

  const decodeTwo: Instr[] = [
    { op: "local.get", index: lead },
    { op: "i32.const", value: 0x1f },
    { op: "i32.and" },
    { op: "i32.const", value: 6 },
    { op: "i32.shl" },
    ...loadByte(1),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.set", index: codePoint },
    ...returnIfRequested([{ op: "local.get", index: codePoint }]),
    ...advance(2, 1),
  ];
  const decodeThree: Instr[] = [
    { op: "local.get", index: lead },
    { op: "i32.const", value: 0x0f },
    { op: "i32.and" },
    { op: "i32.const", value: 12 },
    { op: "i32.shl" },
    ...loadByte(1),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.const", value: 6 },
    { op: "i32.shl" },
    { op: "i32.or" },
    ...loadByte(2),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.set", index: codePoint },
    ...returnIfRequested([{ op: "local.get", index: codePoint }]),
    ...advance(3, 1),
  ];
  const decodeFour: Instr[] = [
    { op: "local.get", index: lead },
    { op: "i32.const", value: 0x07 },
    { op: "i32.and" },
    { op: "i32.const", value: 18 },
    { op: "i32.shl" },
    ...loadByte(1),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.const", value: 12 },
    { op: "i32.shl" },
    { op: "i32.or" },
    ...loadByte(2),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.const", value: 6 },
    { op: "i32.shl" },
    { op: "i32.or" },
    ...loadByte(3),
    { op: "i32.const", value: 0x3f },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.set", index: codePoint },
    ...returnIfRequested([
      { op: "local.get", index: codePoint },
      { op: "i32.const", value: 0x10000 },
      { op: "i32.sub" },
      { op: "i32.const", value: 10 },
      { op: "i32.shr_u" },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.add" },
    ]),
    ...returnIfRequested(
      [
        { op: "local.get", index: codePoint },
        { op: "i32.const", value: 0x10000 },
        { op: "i32.sub" },
        { op: "i32.const", value: 0x03ff },
        { op: "i32.and" },
        { op: "i32.const", value: 0xdc00 },
        { op: "i32.add" },
      ],
      1,
    ),
    ...advance(4, 2),
  ];

  return [
    // Negative indices are immediately out of range.
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: Number.NaN }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: LINEAR_STRING_LENGTH_OFFSET },
    { op: "local.set", index: byteLen },
    // A UTF-8 sequence never encodes more code units than it occupies
    // bytes (4 bytes -> at most 2 units), so unitLen <= byteLen and an
    // index at or past byteLen is out of range for *any* string. This
    // replaces a full walk-to-the-end with one compare (§22.1.3.3 NaN).
    { op: "local.get", index: 1 },
    { op: "local.get", index: byteLen },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: Number.NaN }, { op: "return" }],
    },
    // ── ASCII fast path ────────────────────────────────────────────────
    // Indexing the i-th UTF-16 code unit by decoding UTF-8 from byte 0 is
    // O(i), so an N-character scan — a tokenizer — costs O(N^2). That is
    // an implementation choice, not a property of linear memory: the GC
    // lane stores fixed-width i16 and indexes in O(1). For a pure-ASCII
    // string the byte index *is* the code-unit index, so the whole decode
    // collapses to one `i32.load8_u`. `__str_is_ascii` memoises its verdict
    // in the header, which is what removes the quadratic term rather than
    // merely shrinking its constant.
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: asciiFuncIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // `index < byteLen` is already established above, so this load is
        // in bounds.
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "i32.add" },
        { op: "i32.load8_u", align: 0, offset: LINEAR_STRING_ELEMENTS_OFFSET },
        { op: "f64.convert_i32_u" },
        { op: "return" },
      ],
    },
    // ── Slow path: mixed-width string, decode sequence by sequence ─────
    { op: "i32.const", value: 0 },
    { op: "local.set", index: bytePos },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: unitPos },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: bytePos },
            { op: "local.get", index: byteLen },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...loadByte(0),
            { op: "local.set", index: lead },
            { op: "local.get", index: lead },
            { op: "i32.const", value: 0x80 },
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...returnIfRequested([{ op: "local.get", index: lead }]), ...advance(1, 1)],
              else: [
                { op: "local.get", index: lead },
                { op: "i32.const", value: 0xe0 },
                { op: "i32.lt_u" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: decodeTwo,
                  else: [
                    { op: "local.get", index: lead },
                    { op: "i32.const", value: 0xf0 },
                    { op: "i32.lt_u" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: decodeThree,
                      else: decodeFour,
                    },
                  ],
                },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "f64.const", value: Number.NaN },
  ];
}
