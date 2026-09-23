// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  RYU_I32 as I32,
  RYU_I64 as I64,
  type NativeRyuBody,
  type RyuToBufferResources,
} from "./number-ryu-signatures.js";
export type { RyuToBufferResources } from "./number-ryu-signatures.js";

const C_ZERO = 48;
const C_MINUS = 45;
const C_PLUS = 43;
const C_DOT = 46;
const C_LC_E = 101;

// params
const P_VALUE = 0;
const P_NEG = 1;
const P_BUF = 2;
const P_POS = 3;
// i64 locals
const L_DIGITS = 4;
const L_W = 5; // working copy of digits during extraction
// i32 locals
const L_EXP = 6;
const L_K = 7;
const L_N = 8;
const L_J = 9; // loop counter
const L_E = 10; // exponent for scientific
const L_EABS = 11;
const L_EPOW = 12; // power of ten for exponent digit peel
const L_DIG_OFF = 13; // base offset of digit scratch within buf (write area beyond pos)
const L_TMP = 14;

// We extract the decimal digits of `digits` into a scratch region of the
// SAME buffer, parked well past the final output (offset 200), LSB-first, so
// we can then emit them MSB-first by reading dig[k-1-j]. BUF_CAP is 256 and a
// shortest decimal is ≤ 17 digits, so [200,217) is safe and never overlaps
// the ≤ ~24-char formatted output that starts at `pos` (pos ≤ a few).
const DIG_SCRATCH = 200;

// write digit char (value 0-9 already in L_TMP) at P_POS, advance P_POS
const writeDigitFromTmp = (strDataTypeIdx: number): Instr[] => [
  { op: "local.get", index: P_BUF },
  { op: "local.get", index: P_POS },
  { op: "i32.const", value: C_ZERO },
  { op: "local.get", index: L_TMP },
  { op: "i32.add" },
  { op: "array.set", typeIdx: strDataTypeIdx },
  { op: "local.get", index: P_POS },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
  { op: "local.set", index: P_POS },
];
const writeChar = (code: number, strDataTypeIdx: number): Instr[] => [
  { op: "local.get", index: P_BUF },
  { op: "local.get", index: P_POS },
  { op: "i32.const", value: code },
  { op: "array.set", typeIdx: strDataTypeIdx },
  { op: "local.get", index: P_POS },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
  { op: "local.set", index: P_POS },
];

// emit dig[idxExpr] (a stored digit value 0-9) → write as char.
// idxExpr leaves an i32 (0-based index into DIG_SCRATCH, MSB-first via k-1-j).
const writeStoredDigit = (idxExpr: Instr[], strDataTypeIdx: number): Instr[] => [
  // L_TMP = buf[DIG_SCRATCH + idx]
  { op: "local.get", index: P_BUF },
  { op: "i32.const", value: DIG_SCRATCH },
  ...idxExpr,
  { op: "i32.add" },
  { op: "array.get_u", typeIdx: strDataTypeIdx },
  { op: "local.set", index: L_TMP },
  ...writeDigitFromTmp(strDataTypeIdx),
];

// loop: emit a run of MSB-first stored digits for j in [startExpr, endExpr).
// We implement specific loops inline rather than a generic helper.

function buildPrologue(resources: RyuToBufferResources): Instr[] {
  const { digits: digitsIdx, stringDataTypeIdx: strDataTypeIdx } = resources;
  return [
    // (digits, exp) = __num_ryu_digits(value)
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: digitsIdx },
    { op: "local.set", index: L_EXP },
    { op: "local.set", index: L_DIGITS },
    // Extract decimal digits LSB-first into DIG_SCRATCH; count = k.
    { op: "local.get", index: L_DIGITS },
    { op: "local.set", index: L_W },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // buf[DIG_SCRATCH + k] = (w % 10)
            { op: "local.get", index: P_BUF },
            { op: "i32.const", value: DIG_SCRATCH },
            { op: "local.get", index: L_K },
            { op: "i32.add" },
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 10n },
            { op: "i64.rem_u" },
            { op: "i32.wrap_i64" },
            { op: "array.set", typeIdx: strDataTypeIdx },
            // w /= 10 ; k++
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_W },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            // if (w != 0) continue
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            { op: "br_if", depth: 0 },
          ],
        },
      ],
    },
    // n = exp + k
    { op: "local.get", index: L_EXP },
    { op: "local.get", index: L_K },
    { op: "i32.add" },
    { op: "local.set", index: L_N },
    // sign
    { op: "local.get", index: P_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: writeChar(C_MINUS, strDataTypeIdx),
    },
  ];
}

function buildCaseA(strDataTypeIdx: number): Instr[] {
  // --- case selection (§6.1.6.1.13) ---
  // Each case writes its output and `return`s P_POS, so the four `if`s execute
  // as a sequential dispatch; the last (exponential) is the fallthrough.
  // case A condition: (n >= k) && (n <= 21)  → integer, k digits + (n-k) zeros
  return [
    { op: "local.get", index: L_N },
    { op: "local.get", index: L_K },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 21 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // emit all k digits MSB-first: for j in [0,k): writeStoredDigit(k-1-j)
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit(
                  [
                    { op: "local.get", index: L_K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.get", index: L_J },
                    { op: "i32.sub" },
                  ],
                  strDataTypeIdx,
                ),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // (n - k) trailing zeros
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_N },
                { op: "local.get", index: L_K },
                { op: "i32.sub" },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeChar(C_ZERO, strDataTypeIdx),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  ];
}

function buildCaseB(strDataTypeIdx: number): Instr[] {
  // case B condition: (n > 0) && (n <= 21)  → fixed with point inside digits
  return [
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 21 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // first n digits, then '.', then remaining k-n digits
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_N },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit(
                  [
                    { op: "local.get", index: L_K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.get", index: L_J },
                    { op: "i32.sub" },
                  ],
                  strDataTypeIdx,
                ),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        ...writeChar(C_DOT, strDataTypeIdx),
        // remaining: j in [n, k)
        { op: "local.get", index: L_N },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit(
                  [
                    { op: "local.get", index: L_K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.get", index: L_J },
                    { op: "i32.sub" },
                  ],
                  strDataTypeIdx,
                ),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  ];
}

function buildCaseC(strDataTypeIdx: number): Instr[] {
  // case C condition: (n > -6) && (n <= 0)  → "0." (-n zeros) digits
  return [
    { op: "local.get", index: L_N },
    { op: "i32.const", value: -6 },
    { op: "i32.gt_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 0 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_ZERO, strDataTypeIdx),
        ...writeChar(C_DOT, strDataTypeIdx),
        // -n leading zeros
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: L_N },
                { op: "i32.sub" },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeChar(C_ZERO, strDataTypeIdx),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // all k digits MSB-first
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit(
                  [
                    { op: "local.get", index: L_K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.get", index: L_J },
                    { op: "i32.sub" },
                  ],
                  strDataTypeIdx,
                ),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  ];
}

function buildCaseD(strDataTypeIdx: number): Instr[] {
  // case D (fallthrough): exponential.  digits[0] ['.' digits[1..]] 'e' sign |e|, e=n-1
  return [
    // first digit (MSB) = dig[k-1]
    ...writeStoredDigit(
      [{ op: "local.get", index: L_K }, { op: "i32.const", value: 1 }, { op: "i32.sub" }],
      strDataTypeIdx,
    ),
    // if (k > 1) '.' then digits[1..k)
    { op: "local.get", index: L_K },
    { op: "i32.const", value: 1 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_DOT, strDataTypeIdx),
        { op: "i32.const", value: 1 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit(
                  [
                    { op: "local.get", index: L_K },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.get", index: L_J },
                    { op: "i32.sub" },
                  ],
                  strDataTypeIdx,
                ),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // 'e'
    ...writeChar(C_LC_E, strDataTypeIdx),
    // e = n - 1
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: L_E },
    // sign + abs
    { op: "local.get", index: L_E },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_MINUS, strDataTypeIdx),
        // eabs = -e
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_E },
        { op: "i32.sub" },
        { op: "local.set", index: L_EABS },
      ],
      else: [...writeChar(C_PLUS, strDataTypeIdx), { op: "local.get", index: L_E }, { op: "local.set", index: L_EABS }],
    },
    // write eabs as decimal (1..3 digits, no leading zeros). Find highest power
    // of ten <= eabs, then peel. eabs in [0, 323].
    // epow = 1; while (epow*10 <= eabs) epow*=10
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_EPOW },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            { op: "local.get", index: L_EABS },
            { op: "i32.le_s" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            { op: "local.set", index: L_EPOW },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // while (epow >= 1) { d = eabs/epow; write '0'+d; eabs -= d*epow; epow/=10 }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 1 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            // d = eabs / epow → L_TMP
            { op: "local.get", index: L_EABS },
            { op: "local.get", index: L_EPOW },
            { op: "i32.div_s" },
            { op: "local.set", index: L_TMP },
            ...writeDigitFromTmp(strDataTypeIdx),
            // eabs -= d*epow
            { op: "local.get", index: L_EABS },
            { op: "local.get", index: L_TMP },
            { op: "local.get", index: L_EPOW },
            { op: "i32.mul" },
            { op: "i32.sub" },
            { op: "local.set", index: L_EABS },
            // epow /= 10
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.div_s" },
            { op: "local.set", index: L_EPOW },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: P_POS },
    { op: "return" },
  ];
}

export function buildRyuToBufferBody(resources: RyuToBufferResources): NativeRyuBody {
  const body = buildPrologue(resources);
  body.push(...buildCaseA(resources.stringDataTypeIdx));
  body.push(...buildCaseB(resources.stringDataTypeIdx));
  body.push(...buildCaseC(resources.stringDataTypeIdx));
  body.push(...buildCaseD(resources.stringDataTypeIdx));
  return {
    locals: [
      { name: "digits", type: I64 },
      { name: "w", type: I64 },
      { name: "exp", type: I32 },
      { name: "k", type: I32 },
      { name: "n", type: I32 },
      { name: "j", type: I32 },
      { name: "e", type: I32 },
      { name: "eabs", type: I32 },
      { name: "epow", type: I32 },
      { name: "digoff", type: I32 },
      { name: "tmp", type: I32 },
    ],
    body,
  };
}
