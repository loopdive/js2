// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The RegExp bytecode contract: what a compiled program may contain and the
 * limits every interpreter of it observes.
 *
 * Three parties must agree on these numbers: the pattern compiler
 * (`src/regexp-compiler/compile.ts`), its reference VM (`src/codegen/regex/vm.ts`)
 * and the Wasm VM bodies (`src/runtime/wasmgc/values/regexp-vm-bodies.ts`). The
 * Wasm bodies sit below the compiler in the layering, so the contract lives
 * here, where all three can import it, and has no imports of its own.
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

/**
 * Runtime-compiled `^(?:literal|literal|...)$` programs with no flags use this
 * compact representation: [marker, bodyLength, 0, ...UTF-16 body units]
 *
 * `__regex_search` intercepts it before the fixed-width backtracking VM. The
 * negative marker cannot collide with a ReOp. This is a representation-level
 * optimization only; every other pattern retains the normal bytecode ABI.
 */
export const REGEX_ANCHORED_LITERAL_ALTS_MARKER = -0x40000000;

/** Base step budget of one search, the same in the reference VM and the Wasm VM. */
export const REGEX_STEP_CAP = 1_000_000;

/**
 * (#3549) Per-input-unit budget on top of the base cap. The cap exists to
 * stop RUNAWAY BACKTRACKING (super-linear in the subject), but a flat cap
 * also killed legitimate LINEAR matches over long subjects: `^\p{L}+$`(u)
 * costs a measured ~5 steps/unit (CLASS+SPLIT over the surrogate-alternation
 * program), so the flat 1M cap tripped at ~200k units — and the
 * `RegExp/property-escapes` conformance tests match complement strings of
 * ~1.1M units (304/311 failed exactly here). A length-LINEAR budget keeps
 * the guard: catastrophic patterns are Ω(n²)/Ω(2ⁿ), so on any subject long
 * enough to earn a raised budget they still exceed it (10k-unit subject:
 * n² = 100M ≫ 1M + 50·10k = 1.5M). 50/unit is ~10× the measured legitimate
 * cost. The length term saturates at 20M units so the i32 budget in the Wasm
 * VM cannot overflow (1M + 50·20M ≈ 1.0G < 2³¹−1).
 */
export const REGEX_STEP_CAP_PER_UNIT = 50;
export const REGEX_STEP_CAP_LEN_SATURATION = 20_000_000;
