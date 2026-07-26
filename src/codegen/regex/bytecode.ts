// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Regex bytecode opcode definitions.
 *
 * The standalone (pure-WasmGC) RegExp engine compiles a pattern to a flat
 * `number[]` program at compile time (TypeScript), then interprets it at run
 * time with a single hand-authored Wasm backtracking VM (`__regex_run`). The
 * program is a Pike/Thompson-style instruction stream with explicit
 * backtracking ops; see `src/codegen/regex/compile.ts` for the emitter and
 * `src/codegen/native-regex.ts` for the VM.
 *
 * Each instruction is a fixed-width record of 3 i32 slots: `[op, a, b]`. A
 * flat layout keeps the Wasm interpreter trivial (program-counter steps by 3)
 * and lets the whole program live in one WasmGC `array i32`.
 */

/** Instruction opcodes. Values are stable — they are baked into the emitted
 *  Wasm VM dispatch (`__regex_run`). Do not renumber without updating both. */
export enum ReOp {
  /** `[CHAR, codeUnit, 0]` — match one specific UTF-16 code unit. */
  CHAR = 0,
  /** `[ANY, dotAll, 0]` — match any code unit; when `dotAll`=0, not `\n`/`\r`/U+2028/U+2029. */
  ANY = 1,
  /** `[CLASS, classIdx, negated]` — match against the class table entry. */
  CLASS = 2,
  /** `[SPLIT, x, y]` — try pc=x first, on backtrack try pc=y. */
  SPLIT = 3,
  /** `[JMP, x, 0]` — unconditional jump to pc=x. */
  JMP = 4,
  /** `[SAVE, slot, 0]` — record current input position into capture slot. */
  SAVE = 5,
  /** `[MATCH, 0, 0]` — accept. */
  MATCH = 6,
  /** `[BOL, 0, 0]` — assert beginning-of-line (`^`). multiline handled in 2c. */
  BOL = 7,
  /** `[EOL, 0, 0]` — assert end-of-line (`$`). multiline handled in 2c. */
  EOL = 8,
  /** `[CHARI, foldedCodeUnit, 0]` — match one code unit, ASCII-case-insensitive. */
  CHARI = 9,
  /** `[WBOUND, negated, 0]` — assert a word boundary (`\b`; `\B` when
   *  `negated`=1). Word characters are `[0-9A-Za-z_]` (§22.2.2.6 IsWordChar,
   *  ASCII — Unicode case folding lands with the `u` flag in 2d). #1912. */
  WBOUND = 10,
  /** `[BACKREF, groupIdx, caseInsensitive]` — match the text captured by group
   *  `groupIdx` (§22.2.2.9 BackreferenceMatcher). An unset group matches the
   *  empty string. `caseInsensitive`=1 compares ASCII-folded units. #1912. */
  BACKREF = 11,
  /** `[LOOKAROUND, subPc, flags]` — zero-width assertion (§22.2.2.4 Assertion
   *  `(?=) (?!) (?<=) (?<!)`). Runs the sub-program starting at instruction
   *  `subPc` as a fresh anchored attempt at the current position via a
   *  recursive `__regex_run` call (atomic — no backtrack entries leak out).
   *  `flags` bit 0 = negated, bit 1 = lookbehind (sub-program is compiled
   *  REVERSED and executed with direction -1). Captures written by a
   *  successful positive lookaround persist; everything else restores the
   *  pre-assertion capture state. #1911. */
  LOOKAROUND = 12,
  /** `[PROGRESS, slot, 0]` — empty-iteration guard for nullable quantifiers
   *  (§22.2.2.3.1 RepeatMatcher: a min=0 iteration that consumes nothing
   *  fails, ending the loop). `slot` is a scratch capture slot into which the
   *  loop entry recorded `sp` via a preceding SAVE; if the current `sp` equals
   *  that recorded value the body matched empty, so this op FAILS the
   *  iteration (backtracking to the quantifier's exit arm). Only emitted for
   *  star/plus whose body can match the empty string. #1959. */
  PROGRESS = 13,
  /** `[CLEAR, loSlot, hiSlot]` — reset capture slots `loSlot..hiSlot`
   *  (inclusive) to -1. §22.2.2.3.1 RepeatMatcher clears the quantified
   *  subtree's capture set on each repetition entry, so only the final
   *  iteration's participation is observable. Emitted at the head of every
   *  star/plus/repeat body that contains capture groups; the slot range is the
   *  group span `[2*lo, 2*hi+1]`. Backtrack-aware via the usual caps snapshot
   *  (CLEAR mutates `caps`, which SPLIT snapshots). #1960. */
  CLEAR = 14,
  /** `[CPCLASS, classIdx, negated]` — consume one Unicode code point (one
   *  UTF-16 unit for BMP/lone surrogates, two for a valid surrogate pair) and
   *  match it against the class-table entry. Appended for bytecode stability.
   *  #3652. */
  CPCLASS = 15,
}

/** Slots per instruction in the flat program array. */
export const INSTR_WIDTH = 3;

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
