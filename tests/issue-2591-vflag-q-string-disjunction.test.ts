// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2591 — standalone RegExp `v`-flag `\q{…}` string disjunction
 * (§22.2.1 ClassStringDisjunction).
 *
 * A `\q{s1|s2|…}` class element matches the literal STRING `si`, which may span
 * multiple code points — so it cannot be a member of the single-code-point range
 * set the Slice B host enumerator produces. The parser desugars a v-mode class
 * containing `\q{…}` into an alternation of literal-string arms unioned with the
 * residual code-point class, ordered longest-first per spec.
 *
 * Before #2591 these patterns compiled to a malformed CLASS node that trapped at
 * runtime with "illegal cast"; now they match correctly. Each case compiles under
 * `--target standalone`, instantiates with an EMPTY import object (no JS host),
 * and dual-runs against the native engine.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { RE_FLAG_V } from "../src/codegen/regex/bytecode.js";
import { parsePattern } from "../src/codegen/regex/parse.js";

/** Compile `/pattern/flags.test(input)` standalone and run it. `input` is
 *  embedded as a string literal to avoid JS↔standalone string marshaling. */
async function standaloneTest(pattern: string, flags: string, input: string): Promise<boolean> {
  const inLit = JSON.stringify(input);
  const src = `export function run(): boolean { return /${pattern}/${flags}.test(${inLit}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run() !== 0;
}

/** Compile `input.match(/pattern/flags)?.[0]` standalone; returns the matched
 *  substring (or "" for no match), as an embedded-literal comparison. */
async function standaloneMatch0(pattern: string, flags: string, input: string): Promise<string | null> {
  const inLit = JSON.stringify(input);
  // Encode the result as a boolean equality against the expected host result so
  // no string crosses the standalone boundary.
  const expected = input.match(new RegExp(pattern, flags))?.[0] ?? null;
  const wantLit = expected === null ? "null" : JSON.stringify(expected);
  const src = `export function run(): boolean { const m = ${inLit}.match(/${pattern}/${flags}); const got = m === null ? null : m[0]; return got === ${wantLit}; }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run() !== 0 ? expected : "<MISMATCH>";
}

// Each `\q{…}` form, dual-checked against the host engine.
const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  // Headline test-gate cases from the issue.
  { p: "[\\q{abc|xyz}]", f: "v", inputs: ["xyz", "abc", "a", "", "ab"] },
  { p: "[\\q{abc}]", f: "v", inputs: ["a", "abc", "ab", "abcd"] },
  { p: "[\\q{ab}c-e]", f: "v", inputs: ["d", "ab", "a", "f", "c", "e"] },
  { p: "[\\q{|a}]", f: "v", inputs: ["", "a", "b"] },
  // Empty body and empty operands.
  { p: "[\\q{}]", f: "v", inputs: ["", "x"] },
  { p: "[\\q{a|}]", f: "v", inputs: ["", "a", "b"] },
  // Longest-first ordering (regex alternation is leftmost; the engine must try
  // the longer operand first so the whole string matches).
  { p: "^[\\q{a|ab}]$", f: "v", inputs: ["a", "ab", "abc"] },
  { p: "^[\\q{ab|a}]$", f: "v", inputs: ["a", "ab"] },
  // Multiple disjunctions in one class.
  { p: "[\\q{ab}\\q{cd}]", f: "v", inputs: ["ab", "cd", "ef", "a"] },
  // Mixed with a shorthand class.
  { p: "[\\q{xy}\\d]", f: "v", inputs: ["xy", "5", "a", "x"] },
  // Escaped separators / braces inside the operand.
  { p: "[\\q{a\\|b}]", f: "v", inputs: ["a|b", "a", "b"] },
  { p: "[\\q{a\\}b}]", f: "v", inputs: ["a}b", "a"] },
  // Astral operand (surrogate-pair lowering).
  { p: "[\\q{\\u{1f600}x}]", f: "v", inputs: ["\u{1f600}x", "x", "\u{1f600}"] },
  // Case-insensitive (`vi`) — each operand char folds.
  { p: "[\\q{abc}]", f: "vi", inputs: ["abc", "ABC", "aBc", "ab"] },
  // Quantified class with strings (the test262 union shape).
  {
    p: "^[\\q{0|2|4|9\\uFE0F\\u20E3}\\q{0|2|4|9\\uFE0F\\u20E3}]+$",
    f: "v",
    inputs: ["0", "2", "4", "9️⃣", "7", "024", "6️⃣"],
  },
];

describe("#2591 standalone RegExp v-flag \\q{…} string disjunction — dual-run vs native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} .test(${JSON.stringify(input)})`, async () => {
        const expected = new RegExp(p, f).test(input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }

  // The `.match()[0]` substring must be the longest operand at the leftmost
  // position (spec longest-first), validated against the host result.
  const MATCH_CASES: Array<{ p: string; f: string; input: string }> = [
    { p: "[\\q{a|ab}]", f: "v", input: "ab" },
    { p: "[\\q{abc|ab}]", f: "v", input: "xabc" },
    { p: "[\\q{abc}]", f: "v", input: "zzabc" },
    { p: "[\\q{ab}c-e]", f: "v", input: "qde" },
  ];
  for (const { p, f, input } of MATCH_CASES) {
    it(`/${p}/${f} .match(${JSON.stringify(input)})[0] matches host`, async () => {
      const got = await standaloneMatch0(p, f, input);
      const expected = input.match(new RegExp(p, f))?.[0] ?? null;
      expect(got).toBe(expected);
    });
  }

  // #3665 completes the former narrowed residual with first-class finite set
  // algebra. Keep this predecessor test as a dual-run regression.
  it("matches \\q{…} inside a set operation", async () => {
    const src = `export function run(): boolean { return /[\\q{ab}&&[a-z]]/v.test("ab"); }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.errors?.[0]?.message).toBe(true);
    const expected = /[\q{ab}&&[a-z]]/v.test("ab");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const got = (instance.exports as { run(): number }).run() !== 0;
    expect(got).toBe(expected);
  });

  // #3665 also makes properties of strings first-class operands. Code-point
  // properties continue through the compile-time host enumerator.
  it("parses \\q{…} with string and code-point properties", () => {
    expect(() => parsePattern("^[\\p{Emoji_Keycap_Sequence}\\q{0|2|4|9\\uFE0F\\u20E3}]+$", RE_FLAG_V)).not.toThrow();
    expect(() => parsePattern("[\\p{RGI_Emoji}\\q{ab}]", RE_FLAG_V)).not.toThrow();
    expect(() => parsePattern("[\\p{ASCII}\\q{ab}]", RE_FLAG_V)).not.toThrow();
  });
});
