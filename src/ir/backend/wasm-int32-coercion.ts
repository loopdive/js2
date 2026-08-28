// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../types.js";

/** Four reusable i64 locals required by the exact Wasm 32-bit coercion. */
export interface WasmInt32CoercionScratch {
  readonly bits: number;
  readonly exponent: number;
  readonly significand: number;
  readonly magnitude: number;
}

/**
 * Consume one f64 and leave the exact low-32-bit ECMAScript integer pattern.
 *
 * `ToInt32` and `ToUint32` differ only in how this i32 pattern is interpreted
 * afterwards. Decomposing the IEEE-754 value avoids both trapping conversion
 * and the incorrect saturation-before-wrap shortcut for magnitudes >= 2**63.
 */
export function emitWasmInt32Coercion(out: Instr[], scratch: WasmInt32CoercionScratch): void {
  out.push({ op: "i64.reinterpret_f64" }, { op: "local.set", index: scratch.bits });
  out.push(
    { op: "local.get", index: scratch.bits },
    { op: "i64.const", value: 52n },
    { op: "i64.shr_u" },
    { op: "i64.const", value: 0x7ffn },
    { op: "i64.and" },
    { op: "i64.const", value: 1023n },
    { op: "i64.sub" },
    { op: "local.set", index: scratch.exponent },
  );
  out.push(
    { op: "local.get", index: scratch.bits },
    { op: "i64.const", value: 0xfffffffffffffn },
    { op: "i64.and" },
    { op: "i64.const", value: 0x10000000000000n },
    { op: "i64.or" },
    { op: "local.set", index: scratch.significand },
  );

  const shiftLeft: Instr[] = [
    { op: "local.get", index: scratch.significand },
    { op: "local.get", index: scratch.exponent },
    { op: "i64.const", value: 52n },
    { op: "i64.sub" },
    { op: "i64.shl" },
  ];
  const shiftRight: Instr[] = [
    { op: "local.get", index: scratch.significand },
    { op: "i64.const", value: 52n },
    { op: "local.get", index: scratch.exponent },
    { op: "i64.sub" },
    { op: "i64.shr_u" },
  ];
  out.push(
    { op: "local.get", index: scratch.exponent },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    { op: "local.get", index: scratch.exponent },
    { op: "i64.const", value: 83n },
    { op: "i64.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: scratch.exponent },
        { op: "i64.const", value: 52n },
        { op: "i64.ge_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i64" } },
          then: shiftLeft,
          else: shiftRight,
        },
      ],
      else: [{ op: "i64.const", value: 0n }],
    },
    { op: "local.set", index: scratch.magnitude },
  );
  out.push(
    { op: "local.get", index: scratch.bits },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.get", index: scratch.magnitude },
        { op: "i32.wrap_i64" },
        { op: "i32.sub" },
      ],
      else: [{ op: "local.get", index: scratch.magnitude }, { op: "i32.wrap_i64" }],
    },
  );
}

/** Consume one f64 and leave the exact Number result of `Math.clz32`. */
export function emitWasmMathClz32(out: Instr[], scratch: WasmInt32CoercionScratch): void {
  emitWasmInt32Coercion(out, scratch);
  out.push({ op: "i32.clz" }, { op: "f64.convert_i32_s" });
}

/** Consume two f64s and leave the exact Number result of `Math.imul`. */
export function emitWasmMathImul(out: Instr[], scratch: WasmInt32CoercionScratch, rhsLocal: number): void {
  emitWasmInt32Coercion(out, scratch);
  out.push({ op: "local.set", index: rhsLocal });
  emitWasmInt32Coercion(out, scratch);
  out.push({ op: "local.get", index: rhsLocal }, { op: "i32.mul" }, { op: "f64.convert_i32_s" });
}
