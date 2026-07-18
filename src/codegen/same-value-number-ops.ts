// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";

/**
 * (#2963 Tier 2b) SameValue(Number x, Number y) per §20.1.2.13 / §7.2.11
 * (SameValue for two Numbers), shared by BOTH the direct `Object.is(x, y)`
 * both-Number fast path (`call-builtin-static.ts`) and the reified `Object.is`
 * first-class value closure (`builtin-value-read.ts`). Factoring it here keeps
 * the reified `const f = Object.is; f(a, b)` closure byte-for-byte identical to
 * the direct call — the #2963 acceptance bar.
 *
 * `xLocal` / `yLocal` are wasm f64 local indices already holding the two
 * numbers. The emitted sequence consumes nothing off the stack and leaves a
 * single i32 (0/1):
 *
 *   SameValue = (bits(x) === bits(y)) OR (x is NaN AND y is NaN)
 *
 * The IEEE-754 BIT comparison — not `f64.eq` — is what distinguishes SameValue
 * from `===`: it makes `+0` and `-0` UNEQUAL (their sign bits differ), while the
 * explicit both-NaN clause makes two NaNs EQUAL (every NaN bit pattern counts,
 * so `NaN`/`-NaN`/payload variants all satisfy it). Ops are IDENTICAL to the
 * historical inline sequence in `tryCompileBuiltinStaticCall` (byte-inert via
 * prove-emit-identity).
 */
export function sameValueNumberOps(xLocal: number, yLocal: number): Instr[] {
  return [
    // bits(x) == bits(y)  (distinguishes +0 from -0; matches equal finite/±Inf)
    { op: "local.get", index: xLocal },
    { op: "i64.reinterpret_f64" },
    { op: "local.get", index: yLocal },
    { op: "i64.reinterpret_f64" },
    { op: "i64.eq" },
    // (x !== x) & (y !== y)  →  both NaN
    { op: "local.get", index: xLocal },
    { op: "local.get", index: xLocal },
    { op: "f64.ne" },
    { op: "local.get", index: yLocal },
    { op: "local.get", index: yLocal },
    { op: "f64.ne" },
    { op: "i32.and" },
    // bitsEqual | bothNaN
    { op: "i32.or" },
  ];
}
