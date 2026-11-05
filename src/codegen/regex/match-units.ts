// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-instruction match predicates shared by the two reference matchers: the
 * backtracking VM (`vm.ts`) and the linear PikeVM (`linear.ts`, #2723). Both
 * interpret the same `[op, a, b]` bytecode, so what one consuming op accepts
 * and when one zero-width assertion holds must be a single definition — the
 * two VMs differ only in how they schedule alternatives.
 */
import { ReOp } from "./bytecode.js";

/** Does code unit/code point `c` fall in class at `classTable[offset]`? */
export function classMatch(classTable: number[], offset: number, c: number, negated: boolean): boolean {
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

export function asciiFold(code: number): number {
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

/** Does the single-unit consumer `op` (CHAR / CHARI / ANY / CLASS) accept unit `c`? */
export function unitMatches(op: number, a: number, b: number, classTable: number[], c: number): boolean {
  switch (op) {
    case ReOp.CHAR:
      return c === a;
    case ReOp.CHARI:
      return asciiFold(c) === a;
    case ReOp.ANY:
      // a = dotAll; without it `.` excludes the line terminators.
      return a !== 0 || !isLineTerminator(c);
    default:
      return classMatch(classTable, a, c, b !== 0);
  }
}

/**
 * Does the zero-width assertion `op` (BOL / EOL / WBOUND) hold at `sp`?
 * Position-based, so direction-independent. For BOL/EOL `a` = multiline:
 * `^`/`$` also match next to a line terminator (§22.2.2.6–7; `\r\n` counts as
 * two terminators). For WBOUND `a` = negated (`\B`); out-of-bounds neighbours
 * are non-word.
 */
export function assertionHolds(op: number, a: number, input: string, sp: number): boolean {
  const len = input.length;
  switch (op) {
    case ReOp.BOL:
      return sp === 0 || (a !== 0 && isLineTerminator(input.charCodeAt(sp - 1)));
    case ReOp.EOL:
      return sp === len || (a !== 0 && isLineTerminator(input.charCodeAt(sp)));
    default: {
      const before = sp > 0 ? isWordChar(input.charCodeAt(sp - 1)) : false;
      const after = sp < len ? isWordChar(input.charCodeAt(sp)) : false;
      const boundary = before !== after;
      return a !== 0 ? !boundary : boundary;
    }
  }
}

/**
 * The code point a forward CPCLASS consumes at `sp` (`sp < input.length`): a
 * valid surrogate pair combines, a lone surrogate stands alone. Returns -1
 * when `sp` is the trail half of a pair — a search or sticky entry must not
 * reinterpret it as a lone surrogate. The width consumed is 2 exactly when the
 * result exceeds 0xFFFF.
 */
export function forwardCodePoint(input: string, sp: number): number {
  const u = input.charCodeAt(sp);
  if (u >= 0xd800 && u <= 0xdbff && sp + 1 < input.length) {
    const trail = input.charCodeAt(sp + 1);
    return trail >= 0xdc00 && trail <= 0xdfff ? 0x10000 + ((u - 0xd800) << 10) + (trail - 0xdc00) : u;
  }
  if (u >= 0xdc00 && u <= 0xdfff && sp > 0) {
    const lead = input.charCodeAt(sp - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) return -1;
  }
  return u;
}
