// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-TS regex pipeline tests.
 *
 * Validates parse → compile → reference VM against the native JS RegExp engine
 * for the Phase-2a subset. The reference VM (`vm.ts`) is the spec the Wasm
 * interpreter mirrors, so getting this right de-risks the codegen.
 */
import { describe, expect, it } from "vitest";
import { parseFlags, RegexUnsupportedError } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { parsePattern } from "../src/codegen/regex/parse.js";
import { search } from "../src/codegen/regex/vm.js";

/** Run our pipeline and return [start,end] of the first match (g0), or null. */
function ourMatch(pattern: string, flags: string, input: string): [number, number] | null {
  const flagBits = parseFlags(flags);
  const c = compilePattern(pattern, flagBits);
  const m = search(c.prog, c.classTable, c.nGroups, input, 0, false);
  if (!m) return null;
  return [m[0]!, m[1]!];
}

/** Native reference. */
function nativeMatch(pattern: string, flags: string, input: string): [number, number] | null {
  const re = new RegExp(pattern, flags);
  const m = re.exec(input);
  if (!m) return null;
  return [m.index, m.index + m[0].length];
}

const CORPUS: Array<{ p: string; f: string; inputs: string[] }> = [
  { p: "abc", f: "", inputs: ["abc", "xabcy", "ab", "", "ABC"] },
  { p: "a.c", f: "", inputs: ["abc", "a c", "ac", "a\nc"] },
  { p: "a*", f: "", inputs: ["", "aaa", "baaa", "xyz"] },
  { p: "a+", f: "", inputs: ["", "a", "aaab", "baaa"] },
  { p: "a?b", f: "", inputs: ["b", "ab", "aab", "xb"] },
  { p: "[abc]", f: "", inputs: ["a", "d", "xby", ""] },
  { p: "[^abc]", f: "", inputs: ["a", "d", "abcd"] },
  { p: "[a-z]+", f: "", inputs: ["hello", "Hello", "123abc", ""] },
  { p: "[0-9]{2,4}", f: "", inputs: ["1", "12", "12345", "999"] },
  { p: "\\d+", f: "", inputs: ["abc123", "12.34", "no digits"] },
  { p: "\\w+", f: "", inputs: ["foo_bar9", " spaces ", "!!!"] },
  { p: "\\s+", f: "", inputs: ["a b", "a\tb", "ab"] },
  { p: "cat|dog|bird", f: "", inputs: ["i have a dog", "a bird", "cat", "fish"] },
  { p: "^abc", f: "", inputs: ["abc", "xabc", "abcx"] },
  { p: "abc$", f: "", inputs: ["abc", "abcx", "xabc"] },
  { p: "^abc$", f: "", inputs: ["abc", "abcd", "xabc"] },
  { p: "(ab)+", f: "", inputs: ["ababab", "ab", "ba", "abab c"] },
  { p: "(?:ab)+c", f: "", inputs: ["ababc", "abc", "c", "abx"] },
  { p: "a{3}", f: "", inputs: ["aaa", "aa", "aaaa", ""] },
  { p: "a{2,}", f: "", inputs: ["a", "aa", "aaaaa"] },
  { p: "colou?r", f: "", inputs: ["color", "colour", "coluor"] },
  { p: "abc", f: "i", inputs: ["ABC", "AbC", "abc", "xyz"] },
  { p: "[a-c]+", f: "i", inputs: ["ABC", "aBcD", "xyz"] },
  { p: "a.*z", f: "", inputs: ["az", "abcz", "a z", "abc"] },
  { p: "a.*?z", f: "", inputs: ["azaz", "abcz"] },
  { p: "\\.", f: "", inputs: ["a.b", "axb"] },
  { p: "[.]", f: "", inputs: ["a.b", "axb"] },
  // #1539 Phase 2c — dotAll `s`: `.` matches line terminators too.
  { p: "a.c", f: "s", inputs: ["a\nc", "a\rc", "abc", "a c"] },
  { p: "a.*z", f: "s", inputs: ["a\nbz", "ab\ncz", "az"] },
  { p: ".", f: "s", inputs: ["\n", "\r", "x", ""] },
  { p: ".", f: "", inputs: ["\n", "\r", "x"] },
  // #1539 Phase 2c — multiline `m`: `^`/`$` match at line boundaries.
  { p: "^b", f: "m", inputs: ["a\nb", "b\na", "ab", "a\r\nb"] },
  { p: "a$", f: "m", inputs: ["a\nb", "b\na", "ba", "a\r\nb"] },
  { p: "^abc$", f: "m", inputs: ["x\nabc\ny", "abc", "xabc", "abcx"] },
  { p: "^$", f: "m", inputs: ["a\n\nb", "ab", "\n"] },
  // Non-multiline `^`/`$` are unaffected by interior newlines.
  { p: "^b", f: "", inputs: ["a\nb", "b\na"] },
  { p: "a$", f: "", inputs: ["a\nb", "b\na"] },
  // Combined `m` + `s`.
  { p: "^a.b$", f: "ms", inputs: ["a\nb", "x\na\nb\ny", "a b"] },
];

describe("#1539 regex bytecode pipeline vs native RegExp", () => {
  for (const { p, f, inputs } of CORPUS) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, () => {
        expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input));
      });
    }
  }
});

describe("#1539 capture groups", () => {
  it("records group spans", () => {
    const c = compilePattern("(a)(b)c", 0);
    const m = search(c.prog, c.classTable, c.nGroups, "xabcy", 0, false);
    expect(m).not.toBeNull();
    // g0=[1,4] g1=[1,2] g2=[2,3]
    expect([m![0], m![1]]).toEqual([1, 4]);
    expect([m![2], m![3]]).toEqual([1, 2]);
    expect([m![4], m![5]]).toEqual([2, 3]);
  });

  it("named groups map to indices", () => {
    const parsed = parsePattern("(?<year>\\d{4})");
    expect(parsed.numCaptures).toBe(1);
    expect(parsed.groupNames.get("year")).toBe(1);
  });

  it("canonicalizes Unicode escapes in group names and backreferences", () => {
    const flags = parseFlags("u");
    const parsed = parsePattern("(?<\\u{03C0}>a)", flags);
    expect(parsed.groupNames.get("π")).toBe(1);
    expect(parsed.groupNames.has("\\u{03C0}")).toBe(false);

    const compiled = compilePattern("(?<\\u{03C0}>a)\\k<π>", flags);
    const match = search(compiled.prog, compiled.classTable, compiled.nGroups, "aa", 0, false);
    expect(match).not.toBeNull();
    expect([match![0], match![1]]).toEqual([0, 2]);
  });
});

describe("#1539 narrowed refusals (2d Slice B residue after #1911)", () => {
  const refused = [
    "\\p{L}", // unicode property — 2d Slice B
    "\\b*", // quantified non-lookaround assertion — real SyntaxError, never a VM spin
    "[b-a]", // class range out of order — real SyntaxError
    "a**", // nothing to repeat — real SyntaxError
    "(?I:a)", // invalid modifier letter — real SyntaxError
    "(?ii:a)", // duplicate modifier — real SyntaxError
    "(?i-i:a)", // modifier on both sides — real SyntaxError
    "(?-:a)", // empty modifier group — real SyntaxError
  ];
  for (const p of refused) {
    it(`refuses ${JSON.stringify(p)}`, () => {
      expect(() => compilePattern(p, 0)).toThrow(RegexUnsupportedError);
    });
  }
});

// #1911 Phase 2d Slice A — lookarounds + inline modifiers. Dual-run vs native.
const CORPUS_2D: Array<{ p: string; f: string; inputs: string[] }> = [
  // lookahead
  { p: "a(?=b)", f: "", inputs: ["ab", "ac", "a"] },
  { p: "a(?!b)", f: "", inputs: ["ab", "ac", "a"] },
  { p: "foo(?!bar)", f: "", inputs: ["foobar", "foobaz", "foo"] },
  { p: "x(?=y(?=z))", f: "", inputs: ["xyz", "xy", "xz"] }, // nested
  { p: "(?=(\\d+))\\w+", f: "", inputs: ["12ab", "ab12", "99"] }, // capture persists
  { p: "(?=a)|b", f: "", inputs: ["a", "b", "c"] },
  { p: "\\d+(?= dollars)", f: "", inputs: ["100 dollars", "100 euros"] },
  // lookbehind (variable length, alternation, captures, backrefs)
  { p: "(?<=a)b", f: "", inputs: ["ab", "cb", "b"] },
  { p: "(?<!a)b", f: "", inputs: ["ab", "cb", "b"] },
  { p: "(?<=ab|c)d", f: "", inputs: ["abd", "cd", "xd"] },
  { p: "(?<=(a+))b", f: "", inputs: ["aab", "b", "xab"] },
  { p: "(?<=^abc)d", f: "", inputs: ["abcd", "xabcd"] },
  { p: "(?<=\\d{2})x", f: "", inputs: ["12x", "1x", "x"] },
  { p: "(?<=(a)\\1)b", f: "", inputs: ["aab", "ab"] }, // backref runs backwards
  { p: "(?<=\\bword\\b )next", f: "", inputs: ["word next", "sword next"] },
  // quantified lookarounds (Annex B QuantifiableAssertion → idempotent rewrite)
  { p: "(?=a)*a", f: "", inputs: ["a", "b"] },
  { p: "(?=(a))?b", f: "", inputs: ["ab", "b"] },
  { p: "(?=a)+a", f: "", inputs: ["a", "b"] },
  // inline modifiers (regexp-modifiers)
  { p: "(?i:abc)", f: "", inputs: ["ABC", "abc", "xyz"] },
  { p: "(?i:a)b", f: "", inputs: ["Ab", "AB", "ab"] },
  { p: "a(?-i:b)c", f: "i", inputs: ["ABC", "AbC", "aBc"] },
  { p: "(?s:.)", f: "", inputs: ["\n", "x"] },
  { p: "(?m:^b)", f: "", inputs: ["a\nb", "ba"] },
  { p: "(?im-s:a.b)", f: "s", inputs: ["A\nB", "AxB"] },
  { p: "(?i:(?-i:a)b)", f: "", inputs: ["aB", "Ab", "ab"] }, // nested scopes
  { p: "(?i:[a-c])x", f: "", inputs: ["Bx", "dx"] }, // class folding under modifier
];

/**
 * (#3746) These suites use the HOST `RegExp` as their oracle, so a case is only
 * meaningful when the host can parse the pattern at all. Inline modifiers
 * (`(?i:…)`, ES2025 regexp-modifiers) reached V8 after Node 22 — on
 * v22.22.2 `new RegExp("(?i:abc)")` throws `Invalid group`, and the ~37 cases
 * below failed on the ORACLE, not on our pipeline.
 *
 * Skipping when unsupported rather than deleting: the cases are correct and
 * become live the moment the runtime gains modifiers, and a hard-coded version
 * check would rot. Asking the engine is the durable form of the question.
 */
const HOST_SUPPORTS_INLINE_MODIFIERS = (() => {
  try {
    // biome-ignore lint/complexity/useRegexLiterals: a /(?i:a)/ literal is a parse-time SyntaxError on hosts without inline modifiers — the constructor defers it to runtime so try/catch can probe
    new RegExp("(?i:a)");
    return true;
  } catch {
    return false;
  }
})();

function patternUsesInlineModifiers(pattern: string): boolean {
  // `(?i:` / `(?-i:` / `(?im-s:` … — a group opener carrying flag letters.
  return /\(\?[a-z]*-?[a-z]*:/.test(pattern) && /\(\?[dgimsuvy]+[-:]|\(\?-[dgimsuvy]+/.test(pattern);
}

describe("#1911 Phase 2d Slice A pipeline vs native RegExp", () => {
  for (const { p, f, inputs } of CORPUS_2D) {
    for (const input of inputs) {
      const needsModifiers = patternUsesInlineModifiers(p);
      const runIt = needsModifiers && !HOST_SUPPORTS_INLINE_MODIFIERS ? it.skip : it;
      runIt(`/${p}/${f} on ${JSON.stringify(input)}`, () => {
        expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input));
      });
    }
  }

  it("negative lookaround leaves captures unset", () => {
    // (?!(x))ab — the inner group never sticks (§22.2.2.4).
    const c = compilePattern("(?!(x))ab", 0);
    const m = search(c.prog, c.classTable, c.nGroups, "ab", 0, false);
    expect(m).not.toBeNull();
    expect([m![2], m![3]]).toEqual([-1, -1]);
  });

  it("lookbehind capture spans stay [left, right]", () => {
    const c = compilePattern("(?<=(ab))c", 0);
    const m = search(c.prog, c.classTable, c.nGroups, "xabc", 0, false);
    expect(m).not.toBeNull();
    expect([m![2], m![3]]).toEqual([1, 3]); // "ab"
  });
});

// #1912 Phase 2b — word boundaries, backrefs, class compatibility. Same
// dual-run shape as the 2a corpus: our pipeline must agree with the native
// engine on the first-match span.
const CORPUS_2B: Array<{ p: string; f: string; inputs: string[] }> = [
  { p: "\\bcat\\b", f: "", inputs: ["the cat sat", "concatenate", "cat", "a cat.", ""] },
  { p: "\\Bcat", f: "", inputs: ["concatenate", "the cat", "scat"] },
  { p: "\\b\\w+\\b", f: "", inputs: ["hello world", " x ", "", "_a1"] },
  { p: "\\B\\B", f: "", inputs: ["ab", "a", ""] },
  { p: "(a+)\\1", f: "", inputs: ["aa", "aaaa", "a", "baab"] },
  { p: "(ab|cd)e\\1", f: "", inputs: ["abeab", "cdecd", "abecd"] },
  { p: "(a)?b\\1", f: "", inputs: ["b", "ab a", "aba"] }, // unset group matches empty
  { p: "(?<x>\\d+)-\\k<x>", f: "", inputs: ["12-12", "12-13", "7-7"] },
  { p: "\\1(a)", f: "", inputs: ["a", "aa"] }, // forward ref: unset → empty
  { p: "(A)\\1", f: "i", inputs: ["aa", "aA", "Ab"] }, // ci backref compare
  { p: "(\\w+)\\s\\1", f: "", inputs: ["go go", "go stop", "aa aa"] },
  { p: "[\\D]+", f: "", inputs: ["abc123", "123"] }, // negated shorthand in class
  { p: "[\\W]", f: "", inputs: ["a_b", "a b", "ab"] },
  { p: "[\\S]+", f: "", inputs: ["  x  ", "   "] },
  { p: "[^\\D]", f: "", inputs: ["abc1", "abc"] }, // double negation = \d
  { p: "[\\d-z]+", f: "", inputs: ["a-9z", "qrs", "-", "/"] }, // Annex B literal hyphen
  { p: "[a-\\d]+", f: "", inputs: ["a-9", "b", "5", "c"] },
  { p: "\\05", f: "", inputs: ["\x05", "5"] }, // legacy octal
  { p: "(a)\\2", f: "", inputs: ["a\x02", "aa"] }, // out-of-range decimal → octal
  { p: "\\cA", f: "", inputs: ["\x01", "cA"] }, // control escape
  { p: "\\8", f: "", inputs: ["8", "x"] }, // identity escape
  { p: "\\k<x>", f: "", inputs: ["k<x>", "kx"] }, // \k identity without named groups
  { p: "[\\b]", f: "", inputs: ["\b", "b"] }, // backspace inside class
];

describe("#1912 Phase 2b pipeline vs native RegExp", () => {
  for (const { p, f, inputs } of CORPUS_2B) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, () => {
        expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input));
      });
    }
  }

  it("backref capture slots populate like native", () => {
    const c = compilePattern("(?<x>a+)b\\k<x>", 0);
    const m = search(c.prog, c.classTable, c.nGroups, "xaabaay", 0, false);
    expect(m).not.toBeNull();
    expect([m![0], m![1]]).toEqual([1, 6]); // aabaa
    expect([m![2], m![3]]).toEqual([1, 3]); // aa
  });
});

describe("#1539 flag parsing", () => {
  it("parses gi", () => {
    expect(parseFlags("gi")).toBe(1 | 2);
  });
  it("rejects duplicate", () => {
    expect(() => parseFlags("gg")).toThrow(RegexUnsupportedError);
  });
  it("rejects unknown", () => {
    expect(() => parseFlags("z")).toThrow(RegexUnsupportedError);
  });
});
