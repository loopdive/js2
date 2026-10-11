// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import { RYU_I32 as I32, RYU_I64 as I64, type NativeRyuBody } from "./number-ryu-signatures.js";
export { buildRyuDigitsBody } from "./number-ryu-digits.js";
export { buildRyuToBufferBody } from "./number-ryu-to-buffer.js";
export { ryuMulShiftSignature, ryuDigitsSignature, ryuToBufferSignature } from "./number-ryu-signatures.js";
export type { NativeRyuBody, RyuDigitsResources, RyuToBufferResources } from "./number-ryu-signatures.js";

export function buildRyuMulShiftBody(): NativeRyuBody {
  // params: 0 m, 1 factorLo, 2 factorHi (i64), 3 j (i32)
  const P_M = 0;
  const P_FLO = 1;
  const P_FHI = 2;
  const P_J = 3;
  // i64 locals
  const L_B0_LO = 4;
  const L_B0_HI = 5;
  const L_B2_LO = 6;
  const L_B2_HI = 7;
  const L_MIDLO = 8;
  const L_MIDHI = 9;
  // umul128 scratch (i64)
  const S_ALO = 10;
  const S_AHI = 11;
  const S_BLO = 12;
  const S_BHI = 13;
  const S_B00 = 14;
  const S_B01 = 15;
  const S_B10 = 16;
  const S_B11 = 17;
  const S_MID = 18;
  // i32 local
  const L_DIST = 19;

  const M32 = 0xffffffffn;

  // umul128(aLocal, bLocal) → {hi → hiOut, lo → loOut}
  const umul128 = (aLocal: number, bLocal: number, hiOut: number, loOut: number): Instr[] => [
    { op: "local.get", index: aLocal },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "local.set", index: S_ALO },
    { op: "local.get", index: aLocal },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.set", index: S_AHI },
    { op: "local.get", index: bLocal },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "local.set", index: S_BLO },
    { op: "local.get", index: bLocal },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.set", index: S_BHI },
    // b00 = aLo*bLo
    { op: "local.get", index: S_ALO },
    { op: "local.get", index: S_BLO },
    { op: "i64.mul" },
    { op: "local.set", index: S_B00 },
    // b01 = aLo*bHi
    { op: "local.get", index: S_ALO },
    { op: "local.get", index: S_BHI },
    { op: "i64.mul" },
    { op: "local.set", index: S_B01 },
    // b10 = aHi*bLo
    { op: "local.get", index: S_AHI },
    { op: "local.get", index: S_BLO },
    { op: "i64.mul" },
    { op: "local.set", index: S_B10 },
    // b11 = aHi*bHi
    { op: "local.get", index: S_AHI },
    { op: "local.get", index: S_BHI },
    { op: "i64.mul" },
    { op: "local.set", index: S_B11 },
    // mid = (b00>>32) + (b10 & M32) + (b01 & M32)
    { op: "local.get", index: S_B00 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.get", index: S_B10 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.add" },
    { op: "local.get", index: S_B01 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.add" },
    { op: "local.set", index: S_MID },
    // lo = ((mid & M32) << 32) | (b00 & M32)
    { op: "local.get", index: S_MID },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.const", value: 32n },
    { op: "i64.shl" },
    { op: "local.get", index: S_B00 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.or" },
    { op: "local.set", index: loOut },
    // hi = b11 + (b10>>32) + (b01>>32) + (mid>>32)
    { op: "local.get", index: S_B11 },
    { op: "local.get", index: S_B10 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.get", index: S_B01 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.get", index: S_MID },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.set", index: hiOut },
  ];

  const body: Instr[] = [
    ...umul128(P_M, P_FLO, L_B0_HI, L_B0_LO),
    ...umul128(P_M, P_FHI, L_B2_HI, L_B2_LO),
    // midLo = b0.hi + b2.lo
    { op: "local.get", index: L_B0_HI },
    { op: "local.get", index: L_B2_LO },
    { op: "i64.add" },
    { op: "local.set", index: L_MIDLO },
    // midHi = b2.hi + (midLo <u b0.hi ? 1 : 0)
    { op: "local.get", index: L_B2_HI },
    { op: "local.get", index: L_MIDLO },
    { op: "local.get", index: L_B0_HI },
    { op: "i64.lt_u" },
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.set", index: L_MIDHI },
    // dist = j - 64
    { op: "local.get", index: P_J },
    { op: "i32.const", value: 64 },
    { op: "i32.sub" },
    { op: "local.set", index: L_DIST },
    // result = (midHi << (64 - dist)) | (midLo >>u dist)
    { op: "local.get", index: L_MIDHI },
    { op: "i64.const", value: 64n },
    { op: "local.get", index: L_DIST },
    { op: "i64.extend_i32_u" },
    { op: "i64.sub" },
    { op: "i64.shl" },
    { op: "local.get", index: L_MIDLO },
    { op: "local.get", index: L_DIST },
    { op: "i64.extend_i32_u" },
    { op: "i64.shr_u" },
    { op: "i64.or" },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "b0lo", type: I64 },
      { name: "b0hi", type: I64 },
      { name: "b2lo", type: I64 },
      { name: "b2hi", type: I64 },
      { name: "midlo", type: I64 },
      { name: "midhi", type: I64 },
      { name: "alo", type: I64 },
      { name: "ahi", type: I64 },
      { name: "blo", type: I64 },
      { name: "bhi", type: I64 },
      { name: "b00", type: I64 },
      { name: "b01", type: I64 },
      { name: "b10", type: I64 },
      { name: "b11", type: I64 },
      { name: "mid", type: I64 },
      { name: "dist", type: I32 },
    ],
    body,
  };
}
