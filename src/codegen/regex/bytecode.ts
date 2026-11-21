// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Regex bytecode opcode definitions.
 *
 * The standalone (pure-WasmGC) RegExp engine compiles a pattern to a flat
 * `number[]` program at compile time (TypeScript), then interprets it at run
 * time with a single hand-authored Wasm backtracking VM (`__regex_run`). The
 * program is a Pike/Thompson-style instruction stream with explicit
 * backtracking ops; see `src/codegen/regex/compile.ts` for the emitter and
 * `src/runtime/wasmgc/values/regexp-vm-bodies.ts` for the VM.
 *
 * Each instruction is a fixed-width record of 3 i32 slots: `[op, a, b]`. A
 * flat layout keeps the Wasm interpreter trivial (program-counter steps by 3)
 * and lets the whole program live in one WasmGC `array i32`.
 */

// The opcode numbering is a contract with the Wasm VM bodies, which sit below
// this compiler in the layering, so it is defined there and re-exported here
// for the compile-time half.
export { INSTR_WIDTH, ReOp } from "../../runtime/contracts/regexp-bytecode.js";

/** A fully compiled regex program ready to embed in a `$NativeRegExp`. */
export interface CompiledRegex {
  /** Flat instruction stream: `INSTR_WIDTH` ints per instruction. */
  prog: number[];
  /**
   * Flat class table. Layout per class: `[rangeCount, lo0, hi0, lo1, hi1, …]`.
   * `ReOp.CLASS` operand `a` is the *start offset* into this table (not an
   * index), and `b` is the negated flag. Empty when no classes are used.
   */
  classTable: number[];
  /** Number of capture groups including group 0 (the whole match). */
  nGroups: number;
  /** Extra scratch slots appended after the `2*nGroups` capture slots, one per
   *  nullable star/plus, used by `ReOp.PROGRESS` to detect empty iterations
   *  (#1959). The VM allocates `2*nGroups + nScratch` slots; scratch slots are
   *  never reported as captures. */
  nScratch: number;
  /** Flags bitfield: g=1 i=2 m=4 s=8 u=16 y=32 d=64 v=128. */
  flags: number;
  /**
   * Named capture groups: `name → 1-based capture index` (#2588). Empty when
   * the pattern has no `(?<name>…)` groups. The named-group set is statically
   * known at compile time, so the standalone backend materialises the `groups`
   * result object and resolves `$<name>` substitution from this map (no runtime
   * name→index machinery needed).
   */
  groupNames: Map<string, number>;
}

/** Flags bitfield bit positions (mirrors the spec flag order). */
export const RE_FLAG_G = 1;
export const RE_FLAG_I = 2;
export const RE_FLAG_M = 4;
export const RE_FLAG_S = 8;
export const RE_FLAG_U = 16;
export const RE_FLAG_Y = 32;
export const RE_FLAG_D = 64;
export const RE_FLAG_V = 128;

/** Parse a JS flags string into the bitfield. Throws on duplicate/unknown. */
export function parseFlags(flags: string): number {
  let bits = 0;
  for (const ch of flags) {
    let bit: number;
    switch (ch) {
      case "g":
        bit = RE_FLAG_G;
        break;
      case "i":
        bit = RE_FLAG_I;
        break;
      case "m":
        bit = RE_FLAG_M;
        break;
      case "s":
        bit = RE_FLAG_S;
        break;
      case "u":
        bit = RE_FLAG_U;
        break;
      case "y":
        bit = RE_FLAG_Y;
        break;
      case "d":
        bit = RE_FLAG_D;
        break;
      case "v":
        bit = RE_FLAG_V;
        break;
      default:
        throw new RegexUnsupportedError(`unknown flag '${ch}'`);
    }
    if ((bits & bit) !== 0) throw new RegexUnsupportedError(`duplicate flag '${ch}'`);
    bits |= bit;
  }
  return bits;
}

/**
 * Raised when the pattern uses a feature outside the Phase-2a subset. The
 * codegen entry points catch this and emit a clean #1539-phased compile error
 * (the "narrowed refusal" the architect requires) instead of producing wrong
 * Wasm.
 */
export class RegexUnsupportedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "RegexUnsupportedError";
  }
}
