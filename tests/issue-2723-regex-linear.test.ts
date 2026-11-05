// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2723 Slice A — the reference linear PikeVM (`regex/linear.ts`) and the
 * backtracking VM's hand-off to it (`regex/vm.ts` `search`).
 *
 * The PikeVM must report exactly what the backtracking VM reports — same
 * match, same captures — for every linear-safe program, at every start
 * position, sticky or not; and both must agree with native JS. The Wasm twin
 * is covered end to end by tests/equivalence/issue-2723-regex-linear-fallback.
 */
import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { isLinearSafe, searchLinear } from "../src/codegen/regex/linear.js";
import { runAt, search } from "../src/codegen/regex/vm.js";

const PATTERNS: Array<[string, string]> = [
  ["a|ab", ""],
  ["(a|ab)(c|bcd)(d*)", ""],
  ["(a*)b", ""],
  ["(a+)+b", ""],
  ["x*", ""],
  ["(?:(a)|b)+", ""],
  ["(a)|(b)", ""],
  ["^abc$", "m"],
  ["^b|c$", "m"],
  ["\\bfoo\\b|\\Bo", ""],
  ["a.c", "s"],
  ["a.c", ""],
  ["[a-c]+?d", ""],
  ["(a+?)(b*)", ""],
  ["ABC", "i"],
  ["(?:a|b)*?c", ""],
  ["\\u{1F600}.", "u"],
  [".", "u"],
  ["[^a]", "u"],
  ["(z)((a+)?(b+)?(c))*", ""],
  ["^(?:a{2,3}){2}$", ""],
  ["(\\d{1,3})(?:,(\\d{3}))*", ""],
  ["(?<x>a|b)(?<y>c)?", ""],
];

const SUBJECTS = [
  "",
  "a",
  "ab",
  "abcd",
  "aab",
  "xaabcd",
  "abcabc",
  "zaacbbbcac",
  "foo bar fooo",
  "a\nc",
  "b\nabc\nc",
  "aaab",
  "\u{1F600}x",
  "\ud83d",
  "a😀b",
  "1,234,567",
  "aaaaa",
  "bab",
];

const compileFor = (pattern: string, flags: string) => compilePattern(pattern, parseFlags(flags));

/** Native JS's answer, as the `[g0s, g0e, g1s, g1e, …]` slot array the VMs return. */
function nativeSlots(pattern: string, flags: string, input: string, start: number, sticky: boolean): number[] | null {
  const re = new RegExp(pattern, `${flags}${sticky ? "y" : "g"}d`);
  re.lastIndex = start;
  const m = re.exec(input);
  if (m === null) return null;
  return m.indices!.flatMap((span) => span ?? [-1, -1]);
}

/**
 * Under `u`, V8 moves a `lastIndex` that points at the trail half of a
 * surrogate pair back to the pair's start; both standalone VMs start there
 * as given. That pre-existing difference is not this slice's, so the native
 * oracle skips those start positions (the two VMs are still compared).
 */
function insidePair(flags: string, input: string, start: number): boolean {
  if (!flags.includes("u") || start === 0 || start >= input.length) return false;
  const lead = input.charCodeAt(start - 1);
  const trail = input.charCodeAt(start);
  return lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff;
}

describe("#2723 linear PikeVM ≡ backtracking VM ≡ native JS", () => {
  for (const [pattern, flags] of PATTERNS) {
    it(`/${pattern}/${flags}`, () => {
      const c = compileFor(pattern, flags);
      expect(isLinearSafe(c.prog)).toBe(true);
      const nSlots = 2 * c.nGroups + c.nScratch;
      for (const input of SUBJECTS) {
        for (let start = 0; start <= input.length; start++) {
          for (const sticky of [false, true]) {
            const where = `${JSON.stringify(input)} @${start} sticky=${sticky}`;
            const linear = searchLinear(c.prog, c.classTable, nSlots, input, start, sticky);
            const backtracking = search(c.prog, c.classTable, c.nGroups, input, start, sticky, c.nScratch);
            const slots = linear === null ? null : Array.from(linear);
            expect(slots, where).toEqual(backtracking === null ? null : Array.from(backtracking));
            if (!insidePair(flags, input, start)) {
              expect(slots, where).toEqual(nativeSlots(pattern, flags, input, start, sticky));
            }
          }
        }
      }
    });
  }
});

describe("#2723 isLinearSafe", () => {
  it.each([
    ["(a)\\1", "backreference"],
    ["a(?=b)", "lookahead"],
    ["(?<!a)b", "lookbehind"],
    ["(a*)*b", "nullable-body star (PROGRESS)"],
    ["(?:a|)+b", "nullable-body plus (PROGRESS)"],
  ])("declines /%s/ (%s)", (pattern) => {
    expect(isLinearSafe(compileFor(pattern, "").prog)).toBe(false);
  });
});

describe("#2723 search hands an exhausted attempt to the linear VM", () => {
  it("a catastrophic linear-safe search returns the right answer instead of throwing", () => {
    const c = compileFor("(a+)+b", "");
    const input = `x${"a".repeat(40)}c${"a".repeat(3)}b`;
    // The backtracking attempt at position 1 alone exhausts the budget…
    expect(() => runAt(c.prog, c.classTable, c.nGroups, input, 1)).toThrow(RangeError);
    // …and the search still returns the leftmost match and its capture.
    const m = search(c.prog, c.classTable, c.nGroups, input, 0, false);
    expect(m === null ? null : Array.from(m)).toEqual([42, 46, 42, 45]);
    expect(search(c.prog, c.classTable, c.nGroups, "a".repeat(40), 0, false)).toBeNull();
  });

  it("a catastrophic search with a backreference keeps the RangeError", () => {
    const c = compileFor("(a+)+\\1b", "");
    expect(() => search(c.prog, c.classTable, c.nGroups, "a".repeat(40), 0, false)).toThrow(RangeError);
  });
});
