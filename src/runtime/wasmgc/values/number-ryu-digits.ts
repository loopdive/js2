// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  RYU_I32 as I32,
  RYU_I64 as I64,
  type NativeRyuBody,
  type RyuDigitsResources,
} from "./number-ryu-signatures.js";
import { DOUBLE_POW5_INV_BITCOUNT, DOUBLE_POW5_BITCOUNT } from "./number-ryu-tables.js";
export type { RyuDigitsResources } from "./number-ryu-signatures.js";

// param 0: value (f64)
const P_VALUE = 0;
// i64 locals (1..14)
const L_BITS = 1;
const L_M2 = 2;
const L_MV = 3;
const L_VR = 4;
const L_VP = 5;
const L_VM = 6;
const L_MMSHIFT = 7;
const L_OUTPUT = 8;
const L_LASTREMOVED = 9;
const L_FLO = 10;
const L_FHI = 11;
const L_PFV = 12; // pow5Factor scratch value
// i32 locals (15..27)
const L_IEEEEXP = 15;
const L_E2 = 16;
const L_Q = 17;
const L_I = 18; // shift amount i / j
const L_K = 19; // k, or pow5 table index ii (negative branch)
const L_E10 = 20;
const L_REMOVED = 21;
const L_ACCEPT = 22;
const L_VRTZ = 23;
const L_VMTZ = 24;
const L_TIDX = 25;
const L_PFCNT = 26;

const MANT_MASK = (1n << 52n) - 1n;
const EXP_MASK = 0x7ffn;
const IMPLICIT_BIT = 1n << 52n;

// load table[tidx], table[tidx+1] into L_FLO / L_FHI
const loadFactor = (globalIdx: number, arrType: number): Instr[] => [
  { op: "global.get", index: globalIdx },
  { op: "local.get", index: L_TIDX },
  { op: "array.get", typeIdx: arrType },
  { op: "local.set", index: L_FLO },
  { op: "global.get", index: globalIdx },
  { op: "local.get", index: L_TIDX },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
  { op: "array.get", typeIdx: arrType },
  { op: "local.set", index: L_FHI },
];

// call __ryu_mul_shift(<m-expr>, L_FLO, L_FHI, L_I) leaving i64 on stack.
const mulShiftCall = (mExpr: Instr[], mulShiftIdx: number): Instr[] => [
  ...mExpr,
  { op: "local.get", index: L_FLO },
  { op: "local.get", index: L_FHI },
  { op: "local.get", index: L_I },
  { op: "call", funcIdx: mulShiftIdx },
];

// multipleOfPowerOf5(<value-expr>, <p-expr i32>) -> i32 on stack.
// pow5Factor: count factors of 5 in value, compare >= p. value-expr leaves an
// i64 on the stack; p-expr leaves an i32 on the stack.
const multipleOfPow5 = (valExpr: Instr[], pExpr: Instr[]): Instr[] => [
  ...valExpr,
  { op: "local.set", index: L_PFV },
  { op: "i32.const", value: 0 },
  { op: "local.set", index: L_PFCNT },
  {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: L_PFV },
          { op: "i64.const", value: 5n },
          { op: "i64.rem_u" },
          { op: "i64.const", value: 0n },
          { op: "i64.ne" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: L_PFV },
          { op: "i64.const", value: 5n },
          { op: "i64.div_u" },
          { op: "local.set", index: L_PFV },
          { op: "local.get", index: L_PFCNT },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: L_PFCNT },
          { op: "br", depth: 0 },
        ],
      },
    ],
  },
  { op: "local.get", index: L_PFCNT },
  ...pExpr,
  { op: "i32.ge_s" },
];

// multipleOfPowerOf2(<value-expr i64>, <p-expr i32>) -> i32 on stack.
const multipleOfPow2 = (valExpr: Instr[], pExpr: Instr[]): Instr[] => [
  ...valExpr,
  { op: "i64.const", value: 1n },
  ...pExpr,
  { op: "i64.extend_i32_u" },
  { op: "i64.shl" },
  { op: "i64.const", value: 1n },
  { op: "i64.sub" },
  { op: "i64.and" },
  { op: "i64.const", value: 0n },
  { op: "i64.eq" },
];

const log10Pow2 = (eExpr: Instr[]): Instr[] => [
  ...eExpr,
  { op: "i32.const", value: 78913 },
  { op: "i32.mul" },
  { op: "i32.const", value: 18 },
  { op: "i32.shr_u" },
];
const log10Pow5 = (eExpr: Instr[]): Instr[] => [
  ...eExpr,
  { op: "i32.const", value: 732923 },
  { op: "i32.mul" },
  { op: "i32.const", value: 20 },
  { op: "i32.shr_u" },
];
const pow5bits = (eExpr: Instr[]): Instr[] => [
  ...eExpr,
  { op: "i32.const", value: 1217359 },
  { op: "i32.mul" },
  { op: "i32.const", value: 19 },
  { op: "i32.shr_u" },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
];

// (mv - 1 - mmShift) as an expression leaving i64 on stack.
const mvLessMm = (): Instr[] => [
  { op: "local.get", index: L_MV },
  { op: "i64.const", value: 1n },
  { op: "i64.sub" },
  { op: "local.get", index: L_MMSHIFT },
  { op: "i64.sub" },
];
const mvPlus2 = (): Instr[] => [{ op: "local.get", index: L_MV }, { op: "i64.const", value: 2n }, { op: "i64.add" }];

function emitE2NonNegative(resources: RyuDigitsResources): Instr[] {
  const { inverseGlobalIdx: invIdx, tableTypeIdx: arrType, mulShift: mulShiftIdx } = resources;
  return [
    // q = log10Pow2(e2) - (e2 > 3 ? 1 : 0)
    ...log10Pow2([{ op: "local.get", index: L_E2 }]),
    { op: "local.get", index: L_E2 },
    { op: "i32.const", value: 3 },
    { op: "i32.gt_s" },
    { op: "i32.sub" },
    { op: "local.set", index: L_Q },
    // e10 = q
    { op: "local.get", index: L_Q },
    { op: "local.set", index: L_E10 },
    // k = DOUBLE_POW5_INV_BITCOUNT + pow5bits(q) - 1
    { op: "i32.const", value: DOUBLE_POW5_INV_BITCOUNT },
    ...pow5bits([{ op: "local.get", index: L_Q }]),
    { op: "i32.add" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: L_K },
    // i = -e2 + q + k
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_E2 },
    { op: "i32.sub" },
    { op: "local.get", index: L_Q },
    { op: "i32.add" },
    { op: "local.get", index: L_K },
    { op: "i32.add" },
    { op: "local.set", index: L_I },
    // tidx = 2*q
    { op: "local.get", index: L_Q },
    { op: "i32.const", value: 1 },
    { op: "i32.shl" },
    { op: "local.set", index: L_TIDX },
    ...loadFactor(invIdx, arrType),
    // vr / vp / vm
    ...mulShiftCall([{ op: "local.get", index: L_MV }], mulShiftIdx),
    { op: "local.set", index: L_VR },
    ...mulShiftCall(mvPlus2(), mulShiftIdx),
    { op: "local.set", index: L_VP },
    ...mulShiftCall(mvLessMm(), mulShiftIdx),
    { op: "local.set", index: L_VM },
    // if (q <= 21)
    { op: "local.get", index: L_Q },
    { op: "i32.const", value: 21 },
    { op: "i32.le_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // if (mv % 5 == 0) vrtz = mul5(mv,q)
        { op: "local.get", index: L_MV },
        { op: "i64.const", value: 5n },
        { op: "i64.rem_u" },
        { op: "i64.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...multipleOfPow5([{ op: "local.get", index: L_MV }], [{ op: "local.get", index: L_Q }]),
            { op: "local.set", index: L_VRTZ },
          ],
          else: [
            // else if (acceptBounds) vmtz = mul5(mv-1-mmShift,q)
            { op: "local.get", index: L_ACCEPT },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...multipleOfPow5(mvLessMm(), [{ op: "local.get", index: L_Q }]),
                { op: "local.set", index: L_VMTZ },
              ],
              else: [
                // vp -= mul5(mv+2,q) ? 1 : 0
                { op: "local.get", index: L_VP },
                ...multipleOfPow5(mvPlus2(), [{ op: "local.get", index: L_Q }]),
                { op: "i64.extend_i32_u" },
                { op: "i64.sub" },
                { op: "local.set", index: L_VP },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function emitE2Negative(resources: RyuDigitsResources): Instr[] {
  const { powersGlobalIdx: powIdx, tableTypeIdx: arrType, mulShift: mulShiftIdx } = resources;
  return [
    // q = log10Pow5(-e2) - (-e2 > 1 ? 1 : 0)
    ...log10Pow5([{ op: "i32.const", value: 0 }, { op: "local.get", index: L_E2 }, { op: "i32.sub" }]),
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_E2 },
    { op: "i32.sub" },
    { op: "i32.const", value: 1 },
    { op: "i32.gt_s" },
    { op: "i32.sub" },
    { op: "local.set", index: L_Q },
    // e10 = q + e2
    { op: "local.get", index: L_Q },
    { op: "local.get", index: L_E2 },
    { op: "i32.add" },
    { op: "local.set", index: L_E10 },
    // ii = -e2 - q  (pow5 table index) → store in L_K
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_E2 },
    { op: "i32.sub" },
    { op: "local.get", index: L_Q },
    { op: "i32.sub" },
    { op: "local.set", index: L_K },
    // i = q - (pow5bits(ii) - DOUBLE_POW5_BITCOUNT)
    { op: "local.get", index: L_Q },
    ...pow5bits([{ op: "local.get", index: L_K }]),
    { op: "i32.const", value: DOUBLE_POW5_BITCOUNT },
    { op: "i32.sub" },
    { op: "i32.sub" },
    { op: "local.set", index: L_I },
    // tidx = 2 * ii
    { op: "local.get", index: L_K },
    { op: "i32.const", value: 1 },
    { op: "i32.shl" },
    { op: "local.set", index: L_TIDX },
    ...loadFactor(powIdx, arrType),
    ...mulShiftCall([{ op: "local.get", index: L_MV }], mulShiftIdx),
    { op: "local.set", index: L_VR },
    ...mulShiftCall(mvPlus2(), mulShiftIdx),
    { op: "local.set", index: L_VP },
    ...mulShiftCall(mvLessMm(), mulShiftIdx),
    { op: "local.set", index: L_VM },
    // if (q <= 1) {...} else if (q < 63) {...}
    { op: "local.get", index: L_Q },
    { op: "i32.const", value: 1 },
    { op: "i32.le_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: L_VRTZ },
        { op: "local.get", index: L_ACCEPT },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // vmtz = (mmShift == 1)
            { op: "local.get", index: L_MMSHIFT },
            { op: "i64.const", value: 1n },
            { op: "i64.eq" },
            { op: "local.set", index: L_VMTZ },
          ],
          else: [
            // vp -= 1
            { op: "local.get", index: L_VP },
            { op: "i64.const", value: 1n },
            { op: "i64.sub" },
            { op: "local.set", index: L_VP },
          ],
        },
      ],
      else: [
        { op: "local.get", index: L_Q },
        { op: "i32.const", value: 63 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...multipleOfPow2([{ op: "local.get", index: L_MV }], [{ op: "local.get", index: L_Q }]),
            { op: "local.set", index: L_VRTZ },
          ],
        },
      ],
    },
  ];
}

function emitCommonPath(): Instr[] {
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if (vp/10 <= vm/10) break
            { op: "local.get", index: L_VP },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.get", index: L_VM },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "i64.le_u" },
            { op: "br_if", depth: 1 },
            // lastRemoved = vr % 10
            { op: "local.get", index: L_VR },
            { op: "i64.const", value: 10n },
            { op: "i64.rem_u" },
            { op: "local.set", index: L_LASTREMOVED },
            // vr/=10 ; vp/=10 ; vm/=10 ; removed++
            { op: "local.get", index: L_VR },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VR },
            { op: "local.get", index: L_VP },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VP },
            { op: "local.get", index: L_VM },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VM },
            { op: "local.get", index: L_REMOVED },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_REMOVED },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // output = vr + ((vr == vm || lastRemoved >= 5) ? 1 : 0)
    { op: "local.get", index: L_VR },
    { op: "local.get", index: L_VR },
    { op: "local.get", index: L_VM },
    { op: "i64.eq" },
    { op: "local.get", index: L_LASTREMOVED },
    { op: "i64.const", value: 5n },
    { op: "i64.ge_u" },
    { op: "i32.or" },
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.set", index: L_OUTPUT },
  ];
}

function emitSlowPath(): Instr[] {
  return [
    // loop 1: while (vp/10 > vm/10)
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_VP },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.get", index: L_VM },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "i64.gt_u" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // vmtz = vmtz && (vm % 10 == 0)
            { op: "local.get", index: L_VMTZ },
            { op: "local.get", index: L_VM },
            { op: "i64.const", value: 10n },
            { op: "i64.rem_u" },
            { op: "i64.eqz" },
            { op: "i32.and" },
            { op: "local.set", index: L_VMTZ },
            // vrtz = vrtz && (lastRemoved == 0)
            { op: "local.get", index: L_VRTZ },
            { op: "local.get", index: L_LASTREMOVED },
            { op: "i64.eqz" },
            { op: "i32.and" },
            { op: "local.set", index: L_VRTZ },
            // lastRemoved = vr % 10
            { op: "local.get", index: L_VR },
            { op: "i64.const", value: 10n },
            { op: "i64.rem_u" },
            { op: "local.set", index: L_LASTREMOVED },
            // vr/=10 ; vp/=10 ; vm/=10 ; removed++
            { op: "local.get", index: L_VR },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VR },
            { op: "local.get", index: L_VP },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VP },
            { op: "local.get", index: L_VM },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_VM },
            { op: "local.get", index: L_REMOVED },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_REMOVED },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // if (vmtz) loop 2: while (vm % 10 == 0)
    { op: "local.get", index: L_VMTZ },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_VM },
                { op: "i64.const", value: 10n },
                { op: "i64.rem_u" },
                { op: "i64.const", value: 0n },
                { op: "i64.ne" },
                { op: "br_if", depth: 1 },
                // vrtz = vrtz && (lastRemoved == 0)
                { op: "local.get", index: L_VRTZ },
                { op: "local.get", index: L_LASTREMOVED },
                { op: "i64.eqz" },
                { op: "i32.and" },
                { op: "local.set", index: L_VRTZ },
                // lastRemoved = vr % 10
                { op: "local.get", index: L_VR },
                { op: "i64.const", value: 10n },
                { op: "i64.rem_u" },
                { op: "local.set", index: L_LASTREMOVED },
                { op: "local.get", index: L_VR },
                { op: "i64.const", value: 10n },
                { op: "i64.div_u" },
                { op: "local.set", index: L_VR },
                { op: "local.get", index: L_VP },
                { op: "i64.const", value: 10n },
                { op: "i64.div_u" },
                { op: "local.set", index: L_VP },
                { op: "local.get", index: L_VM },
                { op: "i64.const", value: 10n },
                { op: "i64.div_u" },
                { op: "local.set", index: L_VM },
                { op: "local.get", index: L_REMOVED },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_REMOVED },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // if (vrtz && lastRemoved == 5 && (vr & 1) == 0) lastRemoved = 4
    { op: "local.get", index: L_VRTZ },
    { op: "local.get", index: L_LASTREMOVED },
    { op: "i64.const", value: 5n },
    { op: "i64.eq" },
    { op: "i32.and" },
    { op: "local.get", index: L_VR },
    { op: "i64.const", value: 1n },
    { op: "i64.and" },
    { op: "i64.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i64.const", value: 4n },
        { op: "local.set", index: L_LASTREMOVED },
      ],
    },
    // output = vr + (( (vr==vm && (!accept || !vmtz)) || lastRemoved >= 5 ) ? 1 : 0)
    { op: "local.get", index: L_VR },
    { op: "local.get", index: L_VR },
    { op: "local.get", index: L_VM },
    { op: "i64.eq" },
    { op: "local.get", index: L_ACCEPT },
    { op: "i32.eqz" },
    { op: "local.get", index: L_VMTZ },
    { op: "i32.eqz" },
    { op: "i32.or" },
    { op: "i32.and" },
    { op: "local.get", index: L_LASTREMOVED },
    { op: "i64.const", value: 5n },
    { op: "i64.ge_u" },
    { op: "i32.or" },
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.set", index: L_OUTPUT },
  ];
}

export function buildRyuDigitsBody(resources: RyuDigitsResources): NativeRyuBody {
  const body: Instr[] = [
    // bits = reinterpret(value)
    { op: "local.get", index: P_VALUE },
    { op: "i64.reinterpret_f64" },
    { op: "local.set", index: L_BITS },
    // ieeeExponent = (bits >>u 52) & 0x7ff
    { op: "local.get", index: L_BITS },
    { op: "i64.const", value: 52n },
    { op: "i64.shr_u" },
    { op: "i64.const", value: EXP_MASK },
    { op: "i64.and" },
    { op: "i32.wrap_i64" },
    { op: "local.set", index: L_IEEEEXP },
    // if (ieeeExponent == 0) subnormal else normal
    { op: "local.get", index: L_IEEEEXP },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: -1076 },
        { op: "local.set", index: L_E2 },
        { op: "local.get", index: L_BITS },
        { op: "i64.const", value: MANT_MASK },
        { op: "i64.and" },
        { op: "local.set", index: L_M2 },
      ],
      else: [
        { op: "local.get", index: L_IEEEEXP },
        { op: "i32.const", value: 1077 },
        { op: "i32.sub" },
        { op: "local.set", index: L_E2 },
        { op: "local.get", index: L_BITS },
        { op: "i64.const", value: MANT_MASK },
        { op: "i64.and" },
        { op: "i64.const", value: IMPLICIT_BIT },
        { op: "i64.or" },
        { op: "local.set", index: L_M2 },
      ],
    },
    // acceptBounds = (m2 & 1) == 0
    { op: "local.get", index: L_M2 },
    { op: "i64.const", value: 1n },
    { op: "i64.and" },
    { op: "i64.eqz" },
    { op: "local.set", index: L_ACCEPT },
    // mv = 4 * m2
    { op: "local.get", index: L_M2 },
    { op: "i64.const", value: 4n },
    { op: "i64.mul" },
    { op: "local.set", index: L_MV },
    // mmShift = (mantissa != 0 || ieeeExponent <= 1) ? 1 : 0
    { op: "local.get", index: L_BITS },
    { op: "i64.const", value: MANT_MASK },
    { op: "i64.and" },
    { op: "i64.const", value: 0n },
    { op: "i64.ne" },
    { op: "local.get", index: L_IEEEEXP },
    { op: "i32.const", value: 1 },
    { op: "i32.le_s" },
    { op: "i32.or" },
    { op: "i64.extend_i32_u" },
    { op: "local.set", index: L_MMSHIFT },
    // init flags
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_VRTZ },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_VMTZ },
    // branch on e2 >= 0
    { op: "local.get", index: L_E2 },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitE2NonNegative(resources),
      else: emitE2Negative(resources),
    },
    // Step 4
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_REMOVED },
    { op: "i64.const", value: 0n },
    { op: "local.set", index: L_LASTREMOVED },
    { op: "local.get", index: L_VMTZ },
    { op: "local.get", index: L_VRTZ },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitSlowPath(),
      else: emitCommonPath(),
    },
    // return (output, e10 + removed)
    { op: "local.get", index: L_OUTPUT },
    { op: "local.get", index: L_E10 },
    { op: "local.get", index: L_REMOVED },
    { op: "i32.add" },
    { op: "return" },
  ];

  return {
    locals: [
      // i64 group: indices 1..12
      { name: "bits", type: I64 },
      { name: "m2", type: I64 },
      { name: "mv", type: I64 },
      { name: "vr", type: I64 },
      { name: "vp", type: I64 },
      { name: "vm", type: I64 },
      { name: "mmShift", type: I64 },
      { name: "output", type: I64 },
      { name: "lastRemoved", type: I64 },
      { name: "flo", type: I64 },
      { name: "fhi", type: I64 },
      { name: "pfv", type: I64 },
      // padding to keep i32 group starting at index 15
      { name: "pad13", type: I64 },
      { name: "pad14", type: I64 },
      // i32 group: indices 15..26
      { name: "ieeeExp", type: I32 },
      { name: "e2", type: I32 },
      { name: "q", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: I32 },
      { name: "e10", type: I32 },
      { name: "removed", type: I32 },
      { name: "accept", type: I32 },
      { name: "vrtz", type: I32 },
      { name: "vmtz", type: I32 },
      { name: "tidx", type: I32 },
      { name: "pfcnt", type: I32 },
    ],
    body,
  };
}
