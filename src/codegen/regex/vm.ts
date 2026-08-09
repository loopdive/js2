// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Reference backtracking VM (pure TypeScript).
 *
 * This is the executable specification for the Wasm interpreter
 * (`__regex_run` in `src/codegen/native-regex.ts`). The Wasm version mirrors
 * this control flow opcode-for-opcode, so unit tests can validate the
 * parse→compile→run pipeline without compiling any Wasm. Keeping the
 * algorithm here also documents exactly what the hand-authored Wasm must do.
 *
 * Algorithm: explicit-stack backtracking over the flat program. Each backtrack
 * entry is `(pc, sp, capsSnapshotMarker)`. To keep captures cheap we snapshot
 * the whole capture array on SPLIT (Phase 2a; a trail-based undo is a 2b
 * optimisation). A bounded step counter guards catastrophic backtracking.
 *
 * #1911 — direction support: lookbehind sub-programs run with `dir = -1`,
 * reading the unit at `sp-1` and decrementing. LOOKAROUND recursively invokes
 * `runAt` on the sub-program at the current position (atomic — no backtrack
 * entries leak into the outer attempt).
 */
import { ReOp } from "./bytecode.js";

/** Matches the Wasm VM's step cap. Tunable; documented in the issue. */
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

/** The shared budget formula — used by BOTH this mirror VM and the Wasm VM. */
export function regexStepBudget(len: number): number {
  return REGEX_STEP_CAP + REGEX_STEP_CAP_PER_UNIT * Math.min(len, REGEX_STEP_CAP_LEN_SATURATION);
}

interface Frame {
  pc: number;
  sp: number;
  caps: Int32Array;
}

/** Does code unit/code point `c` fall in class at `classTable[offset]`? */
function classMatch(classTable: number[], offset: number, c: number, negated: boolean): boolean {
  const rangeCount = classTable[offset]!;
  let inside = false;
  let loIndex = 0;
  let hiIndex = rangeCount - 1;
  while (loIndex <= hiIndex) {
    const mid = loIndex + ((hiIndex - loIndex) >> 1);
    const p = offset + 1 + 2 * mid;
    const lo = classTable[p]!;
    const hi = classTable[p + 1]!;
    if (c < lo) hiIndex = mid - 1;
    else if (c > hi) loIndex = mid + 1;
    else {
      inside = true;
      break;
    }
  }
  return negated ? !inside : inside;
}

function asciiFold(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  return code;
}

function isLineTerminator(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/** §22.2.2.6 IsWordChar (ASCII; Unicode case folding lands with `u` in 2d). */
function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a);
}

/**
 * Run `prog` against `input` starting at `startIdx`. Returns the filled
 * capture array on a match (anchored at `startIdx`), or null on no match /
 * step-cap exceeded. This is a single anchored attempt — callers (test/exec/
 * match) drive the start position scan.
 *
 * #1911: `entryPc` selects the (sub-)program to run, `dir` the scan direction
 * (-1 for lookbehind bodies), and `capsIn` seeds the capture state for
 * recursive lookaround attempts (copy-on-write — the caller's array is never
 * mutated; adopt the RETURNED array to observe sub-captures).
 */
export function runAt(
  prog: number[],
  classTable: number[],
  nGroups: number,
  input: string,
  startIdx: number,
  entryPc = 0,
  dir = 1,
  capsIn?: Int32Array,
  nScratch = 0,
): Int32Array | null {
  // Capture slots (2*nGroups) plus scratch slots for PROGRESS empty-loop guards
  // (#1959). Scratch slots travel with the capture array (snapshotted on SPLIT,
  // seeded into recursive lookaround attempts) and are sliced off by callers.
  const nSlots = 2 * nGroups + nScratch;
  const initCaps = capsIn !== undefined ? capsIn.slice() : new Int32Array(nSlots).fill(-1);
  const stack: Frame[] = [];
  let pc = entryPc;
  let sp = startIdx;
  // Explicit `Int32Array` (not the narrower `Int32Array<ArrayBuffer>` the
  // compiler infers from `new Int32Array(...)`) so reassignment from
  // `frame.caps` / `.slice()` (both `Int32Array<ArrayBufferLike>`) typechecks
  // under the stricter lib in CI.
  let caps: Int32Array = initCaps;
  let steps = 0;
  const len = input.length;

  // Direction-aware unit access: forward reads at sp, backward at sp-1.
  const inBounds = (): boolean => (dir > 0 ? sp < len : sp > 0);
  const unit = (): number => input.charCodeAt(dir > 0 ? sp : sp - 1);

  // (#3549) Length-scaled budget — see regexStepBudget: linear matches over
  // long subjects stay under it; runaway backtracking still exceeds it.
  const stepBudget = regexStepBudget(len);
  for (;;) {
    // (#2091) Cap exhaustion is a hard error, NOT a no-match: a silent `return
    // null` is indistinguishable from a genuine non-match. Throw a catchable
    // RangeError so callers (and the Wasm `__regex_run` this VM mirrors) report
    // it loudly. (A legitimate backtrack failure still returns `null` below.)
    if (++steps > stepBudget) {
      throw new RangeError("regular expression step limit exceeded");
    }
    const op = prog[pc * 3]!;
    const a = prog[pc * 3 + 1]!;
    const b = prog[pc * 3 + 2]!;
    let failed = false;

    switch (op) {
      case ReOp.CHAR: {
        if (inBounds() && unit() === a) {
          sp += dir;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.CHARI: {
        if (inBounds() && asciiFold(unit()) === a) {
          sp += dir;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.ANY: {
        if (inBounds() && (a !== 0 || !isLineTerminator(unit()))) {
          sp += dir;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.CLASS: {
        if (inBounds() && classMatch(classTable, a, unit(), b !== 0)) {
          sp += dir;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.CPCLASS: {
        if (!inBounds()) {
          failed = true;
          break;
        }
        let codePoint = unit();
        let width = 1;
        if (dir > 0 && codePoint >= 0xd800 && codePoint <= 0xdbff && sp + 1 < len) {
          const trail = input.charCodeAt(sp + 1);
          if (trail >= 0xdc00 && trail <= 0xdfff) {
            codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (trail - 0xdc00);
            width = 2;
          }
        } else if (
          dir > 0 &&
          codePoint >= 0xdc00 &&
          codePoint <= 0xdfff &&
          sp > 0 &&
          input.charCodeAt(sp - 1) >= 0xd800 &&
          input.charCodeAt(sp - 1) <= 0xdbff
        ) {
          // Search/sticky entry must not reinterpret the trail half of an
          // existing pair as a lone surrogate.
          failed = true;
          break;
        } else if (dir < 0 && codePoint >= 0xdc00 && codePoint <= 0xdfff && sp > 1) {
          const lead = input.charCodeAt(sp - 2);
          if (lead >= 0xd800 && lead <= 0xdbff) {
            codePoint = 0x10000 + ((lead - 0xd800) << 10) + (codePoint - 0xdc00);
            width = 2;
          }
        } else if (
          dir < 0 &&
          codePoint >= 0xd800 &&
          codePoint <= 0xdbff &&
          sp < len &&
          input.charCodeAt(sp) >= 0xdc00 &&
          input.charCodeAt(sp) <= 0xdfff
        ) {
          // Likewise, reverse lookbehind cannot enter a pair between its
          // lead and trail halves and treat the lead as lone.
          failed = true;
          break;
        }
        if (classMatch(classTable, a, codePoint, b !== 0)) {
          sp += dir * width;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.SPLIT: {
        // Try `a` first; push `b` as the backtrack alternative.
        stack.push({ pc: b, sp, caps: caps.slice() });
        pc = a;
        break;
      }
      case ReOp.JMP: {
        pc = a;
        break;
      }
      case ReOp.SAVE: {
        caps = caps.slice();
        caps[a] = sp;
        pc++;
        break;
      }
      case ReOp.BOL: {
        // a = multiline: `^` matches at position 0, OR (multiline) right after
        // a line terminator (§22.2.2.6). `\r\n` counts as two terminators, so a
        // `^` between them still matches — the char before sp being any LT
        // suffices.
        if (sp === 0 || (a !== 0 && isLineTerminator(input.charCodeAt(sp - 1)))) pc++;
        else failed = true;
        break;
      }
      case ReOp.EOL: {
        // a = multiline: `$` matches at end of input, OR (multiline) right
        // before a line terminator (§22.2.2.7).
        if (sp === len || (a !== 0 && isLineTerminator(input.charCodeAt(sp)))) pc++;
        else failed = true;
        break;
      }
      case ReOp.WBOUND: {
        // a = negated (`\B`). Word boundary: exactly one of the neighbouring
        // code units is a word char (§22.2.2.6); out-of-bounds neighbours are
        // non-word. Position-based — direction-independent.
        const before = sp > 0 ? isWordChar(input.charCodeAt(sp - 1)) : false;
        const after = sp < len ? isWordChar(input.charCodeAt(sp)) : false;
        const boundary = before !== after;
        if (a !== 0 ? !boundary : boundary) pc++;
        else failed = true;
        break;
      }
      case ReOp.BACKREF: {
        // a = group index, b = case-insensitive. An unset group matches the
        // empty string (§22.2.2.9 BackreferenceMatcher step 3). Backwards
        // (dir=-1) the captured span is matched against the units ENDING at
        // sp — same left-to-right unit comparison from base = sp - blen.
        const gs = caps[2 * a]!;
        const ge = caps[2 * a + 1]!;
        if (gs < 0 || ge < 0) {
          pc++;
          break;
        }
        const blen = ge - gs;
        if (dir > 0 ? sp + blen > len : sp - blen < 0) {
          failed = true;
          break;
        }
        const base = dir > 0 ? sp : sp - blen;
        let ok = true;
        for (let j = 0; j < blen; j++) {
          let c1 = input.charCodeAt(gs + j);
          let c2 = input.charCodeAt(base + j);
          if (b !== 0) {
            c1 = asciiFold(c1);
            c2 = asciiFold(c2);
          }
          if (c1 !== c2) {
            ok = false;
            break;
          }
        }
        if (ok) {
          sp += dir * blen;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.LOOKAROUND: {
        // a = sub-program entry pc, b = bit0 negated | bit1 behind. A fresh
        // anchored recursive attempt at sp — atomic, so no backtrack entries
        // leak. Captures from a successful POSITIVE lookaround persist (adopt
        // the sub's caps); all other outcomes keep the pre-assertion caps —
        // the sub ran copy-on-write and never mutated ours (§22.2.2.4).
        const negated = (b & 1) !== 0;
        const behind = (b & 2) !== 0;
        const sub = runAt(prog, classTable, nGroups, input, sp, a, behind ? -1 : 1, caps, nScratch);
        const ok = sub !== null;
        if (negated ? !ok : ok) {
          if (!negated && sub !== null) caps = sub;
          pc++;
        } else failed = true;
        break;
      }
      case ReOp.PROGRESS: {
        // Empty-iteration guard (§22.2.2.3.1, #1959): `a` is a scratch slot
        // holding sp at this loop iteration's entry. If sp is unchanged the
        // body matched empty, so fail the iteration — backtracking takes the
        // quantifier's exit arm (the SPLIT alternative pushed at loop entry).
        if (sp === caps[a]) failed = true;
        else pc++;
        break;
      }
      case ReOp.CLEAR: {
        // Reset capture slots a..b (inclusive) to -1 at a quantifier-iteration
        // head (§22.2.2.3.1, #1960) so a group that doesn't participate this
        // iteration reads as unset. Copy-on-write like SAVE; the snapshot taken
        // by the enclosing SPLIT restores it on backtrack.
        caps = caps.slice();
        for (let i = a; i <= b; i++) caps[i] = -1;
        pc++;
        break;
      }
      case ReOp.MATCH: {
        return caps;
      }
      default:
        return null;
    }

    if (failed) {
      const frame = stack.pop();
      if (!frame) return null;
      pc = frame.pc;
      sp = frame.sp;
      caps = frame.caps;
    }
  }
}

/**
 * Full search: scan start positions `startIdx..len` (sticky callers pass a
 * pre-clamped range via a single `runAt`). Returns the first match's caps or
 * null.
 */
export function search(
  prog: number[],
  classTable: number[],
  nGroups: number,
  input: string,
  startIdx: number,
  sticky: boolean,
  nScratch = 0,
): Int32Array | null {
  const len = input.length;
  for (let i = Math.max(0, startIdx); i <= len; i++) {
    const m = runAt(prog, classTable, nGroups, input, i, 0, 1, undefined, nScratch);
    if (m) return m;
    if (sticky) return null;
  }
  return null;
}
