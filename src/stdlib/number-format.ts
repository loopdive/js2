// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted number-format builtins (#3305 — parse/format family, following
 * the #3141 Math pilot and the #3256 string Tier-1).
 *
 * Ordinary TS source in the IR-claimable subset, compiled through the
 * compiler's own pipeline (`src/codegen/stdlib-selfhost.ts`) and registered
 * where the hand-emitted `Instr[]` bodies used to be pushed
 * (`emitNativeNumberFormat`, native/standalone modes only — JS-host mode
 * keeps the `number_*` env imports).
 *
 * DIALECT NOTES (beyond the #3141/#3256 headers):
 *   - Digit extraction is pure f64 arithmetic (`Math.floor` lowers to the
 *     `f64.floor` intrinsic — the #1371 whitelist — no funcMap dependency).
 *   - Output is built into a scratch i16 buffer through the `__nfd_*`
 *     micro-kernel callees (f64-ABI wrappers over the `$__str_data` array —
 *     see number-format-selfhost.ts), mirroring the deleted hand bodies
 *     op-for-op: LSB-first integer digits, in-place reverse, MSB-first
 *     fractional digits. `__nfd_fin` copies the first `pos` units into a
 *     tight `$NativeString` exactly like the retained `__num_fmt_finalize`.
 *   - String LITERALS ("NaN"/"Infinity"/"0") lower via the driver's
 *     emitStringConst (#3256); the legacy `(f64, f64) -> externref` ABI is
 *     preserved by a 4-instr thunk that `extern.convert_any`s the result.
 *   - Non-finite guards use the pilot conventions: `x !== x` for NaN and
 *     magnitude compares against ±MAX_VALUE for ±Infinity.
 *   - The hand body TRAPPED (`unreachable`) for integer parts beyond
 *     MAX_SAFE_INTEGER (#1335 Phase 2 pending) — `__num_fmt_trap()` keeps
 *     that failure class bit-identical.
 *
 * The def is built per-compilation (NO memoKey): the `__nfd_*` callee sigs
 * carry the ctx-bound `$__str_data` typeIdx (the #3161 typed-def rule).
 */

import type { SelfHostedFuncDef } from "../frontend/builtins/contracts.js";
import { irVal, type IrType } from "../ir/core/types.js";
import { NATIVE_RADIX_SOURCES, type NativeRadixSourceVersion } from "../runtime/contracts/number-format-sources.js";

const F64: IrType = irVal({ kind: "f64" });
const STR: IrType = { kind: "string" };

type Sig = { params: readonly IrType[]; returnType: IrType | null };

/**
 * `Number.prototype.toString(radix)` core (§21.1.3.6, §6.1.6.1.20, §7.1.5) —
 * mirrors the deleted hand `number_toString_radix` step-for-step: non-finite
 * short-circuits, ±0 → "0", radix floor, MAX_SAFE_INTEGER trap parity,
 * LSB-first integer digit loop (q = floor(n/r); digit = n − q·r), '0' pad for
 * pure fractions, '-' before the in-place reverse, then up to 100 MSB-first
 * fractional digits (digit = floor(frac·r)), stopping when the remainder is
 * exhausted. Digit codes: '0'+d below 10, 'a'−10+d from 10 (codes 48/87).
 */

/**
 * Build the toString(radix) def against the live ctx's buffer array type
 * (`bufRef` = `(ref null $__str_data)` — ctx-bound, hence no memoKey).
 */
export function numToStringRadixDef(bufRef: IrType): SelfHostedFuncDef {
  return numToStringRadixDefForVersion(bufRef, 2);
}

/** Explicit historical/successor build; the existing default definition remains byte-identical. */
export function numToStringRadixDefForVersion(bufRef: IrType, version: NativeRadixSourceVersion): SelfHostedFuncDef {
  const selected = NATIVE_RADIX_SOURCES[version];
  if (!selected) throw Error("unsupported native radix source version");
  const calleeTypes = new Map<string, Sig>([
    ["__nfd_new", { params: [F64], returnType: bufRef }],
    ["__nfd_get", { params: [bufRef, F64], returnType: F64 }],
    ["__nfd_set", { params: [bufRef, F64, F64], returnType: null }],
    ["__nfd_fin", { params: [bufRef, F64], returnType: STR }],
    ["__num_fmt_trap", { params: [], returnType: null }],
  ]);
  return {
    name: "__sh_num_toString_radix",
    source: selected.source,
    paramTypes: [F64, F64],
    returnType: STR,
    calleeTypes,
  };
}
