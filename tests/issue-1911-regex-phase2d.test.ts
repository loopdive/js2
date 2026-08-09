// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1911 — standalone RegExp Phase 2d Slice A: lookahead/lookbehind, inline
 * modifier groups `(?ims-ims:…)`, and the `d` flag.
 *
 * Each case compiles under `--target standalone`, instantiates with an EMPTY
 * import object (no JS host), and dual-runs against the native engine.
 * Lookarounds execute as recursive `__regex_run` sub-program calls (lookbehind
 * bodies compiled reversed, direction -1); the matcher is unit-tested in pure
 * TS by tests/regex-bytecode.test.ts — this validates the Wasm VM end-to-end.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

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

const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  // Lookahead (?= / ?! — §22.2.2.4
  { p: "a(?=b)", f: "", inputs: ["ab", "ac", "a"] },
  { p: "a(?!b)", f: "", inputs: ["ab", "ac", "a"] },
  { p: "foo(?!bar)", f: "", inputs: ["foobar", "foobaz", "foo"] },
  { p: "x(?=y(?=z))", f: "", inputs: ["xyz", "xy"] },
  { p: "\\d+(?= dollars)", f: "", inputs: ["100 dollars", "100 euros"] },
  // Lookbehind (?<= / ?<! — variable length, alternation, anchors, backrefs
  { p: "(?<=a)b", f: "", inputs: ["ab", "cb", "b"] },
  { p: "(?<!a)b", f: "", inputs: ["ab", "cb", "b"] },
  { p: "(?<=ab|c)d", f: "", inputs: ["abd", "cd", "xd"] },
  { p: "(?<=(a+))b", f: "", inputs: ["aab", "b"] },
  { p: "(?<=^abc)d", f: "", inputs: ["abcd", "xabcd"] },
  { p: "(?<=\\d{2})x", f: "", inputs: ["12x", "1x"] },
  { p: "(?<=(a)\\1)b", f: "", inputs: ["aab", "ab"] },
  // Quantified lookahead (Annex B QuantifiableAssertion)
  { p: "(?=a)*a", f: "", inputs: ["a", "b"] },
  // Inline modifiers (regexp-modifiers proposal)
  { p: "(?i:abc)", f: "", inputs: ["ABC", "abc", "xyz"] },
  { p: "a(?-i:b)c", f: "i", inputs: ["ABC", "AbC", "aBc"] },
  { p: "(?s:.)", f: "", inputs: ["\n", "x"] },
  { p: "(?m:^b)", f: "", inputs: ["a\nb", "ba"] },
  { p: "(?im-s:a.b)", f: "s", inputs: ["A\nB", "AxB"] },
  { p: "(?i:(?-i:a)b)", f: "", inputs: ["aB", "Ab", "ab"] },
  // `d` flag — accepted; matching semantics unchanged (indices surface: #1914)
  { p: "^a$", f: "d", inputs: ["a", "b"] },
  { p: "(a)(b)?", f: "d", inputs: ["ab", "a"] },
];

/**
 * (#3746) Same host-oracle caveat as `tests/regex-bytecode.test.ts`: `expected`
 * comes from the HOST `RegExp`, so a pattern the host cannot parse fails on the
 * ORACLE rather than on our lowering. Inline modifiers (ES2025
 * regexp-modifiers) postdate Node 22 — v22.22.2 throws `Invalid group` on
 * `(?i:a)` — which is what made these cases red on `main`. Ask the engine
 * rather than hard-coding a version, so they go live when the runtime does.
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
  return /\(\?[dgimsuvy]*-?[dgimsuvy]*:/.test(pattern) && /\(\?[dgimsuvy]+[-:]|\(\?-[dgimsuvy]+/.test(pattern);
}

describe("#1911 standalone RegExp Phase 2d Slice A — dual-run vs native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      const runIt = patternUsesInlineModifiers(p) && !HOST_SUPPORTS_INLINE_MODIFIERS ? it.skip : it;
      runIt(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = new RegExp(p, f).test(input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }

  it("positive lookahead captures flow into exec result", async () => {
    const src = `
      export function matched(): boolean { const m = /(?=(\\d+))\\w+/.exec("12ab"); return m !== null; }
      export function len(i: number): number { const m = /(?=(\\d+))\\w+/.exec("12ab")!; return m[i]!.length; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { matched(): number; len(i: number): number };
    expect(ex.matched()).toBe(1);
    expect(ex.len(0)).toBe(4); // "12ab"
    expect(ex.len(1)).toBe(2); // "12"
  });

  it("negative lookahead leaves its captures unset", async () => {
    const src = `
      export function run(): boolean { const m = /(?!(x))ab/.exec("ab")!; return m[1] === undefined; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });

  it("invalid modifier group throws a runtime SyntaxError via new RegExp", async () => {
    const src = `
      export function run(): number {
        try { new RegExp("(?I:a)").test("a"); return 0; }
        catch (e) { return e instanceof SyntaxError ? 1 : 2; }
      }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });

  it("\\q{…} string disjunctions now compile (string disjunction — #2591)", async () => {
    // Superseded by #2591: a top-level/union `\q{…}` is desugared to an
    // alternation of literal strings rather than refused. Full coverage lives in
    // tests/issue-2591-vflag-q-string-disjunction.test.ts; this just guards that
    // the former narrowed-refusal no longer fires for the common case.
    const r = await compile(`export function f(): boolean { return /[\\q{abc}]/v.test("abc"); }`, {
      target: "standalone",
    });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f(): number }).f()).toBe(1);
  });
});

// #1911 Slice B — u/v code-point semantics. Class atoms resolve at COMPILE
// time through the host RegExp into code-point ranges, then desugar to the
// unit-level VM (astral pairs, lone-surrogate lookaround guards). The emitted
// module is still pure Wasm — the empty-import-object instantiation proves it.
describe("#1911 Slice B standalone u/v — dual-run vs native", () => {
  const CASES_B: Array<{ p: string; f: string; inputs: string[] }> = [
    { p: "^.$", f: "u", inputs: ["\u{1F600}", "ab", "\uD800"] }, // code-point dot incl. lone surrogate
    { p: "\\u{1F600}+", f: "u", inputs: ["\u{1F600}\u{1F600}", "z"] }, // astral atom quantified by code point
    { p: "[\u{1F600}-\u{1F64F}]", f: "u", inputs: ["\u{1F601}", "z"] }, // astral class range
    { p: "[^a]+x", f: "u", inputs: ["\u{1F600}\u{1F600}x", "aax"] }, // negated class consumes pairs
    { p: "\\p{Script=Greek}+", f: "u", inputs: ["αβγ", "abc"] }, // property escape
    { p: "\\P{L}", f: "u", inputs: ["1", "a"] },
    { p: "k", f: "ui", inputs: ["K", "x"] }, // Canonicalize: KELVIN SIGN
    { p: "σ", f: "ui", inputs: ["Σ", "ς", "x"] }, // Greek sigma fold orbit
    { p: "\\D", f: "u", inputs: ["\u{1F600}", "5"] }, // negated shorthand by code point
    { p: "\\w+", f: "u", inputs: ["abc_1", "!!"] },
    { p: "[\\p{L}--\\p{Ll}]+", f: "v", inputs: ["ABC", "abc"] }, // v-mode set subtraction
    { p: "a(?=\u{1F600})", f: "u", inputs: ["a\u{1F600}", "ab"] }, // lookahead + astral
    { p: "(?s:.)", f: "u", inputs: ["\n", "\u{1F600}"] }, // modifier-scoped u dot
    { p: "(a)(b)?", f: "ud", inputs: ["ab", "a"] }, // u+d flags together
  ];
  for (const { p, f, inputs } of CASES_B) {
    for (const input of inputs) {
      const runItB = patternUsesInlineModifiers(p) && !HOST_SUPPORTS_INLINE_MODIFIERS ? it.skip : it;
      runItB(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = new RegExp(p, f).test(input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }

  it("invalid u pattern in a LITERAL refuses at compile (host pre-validation)", async () => {
    const r = await compile(`export function f(s: string): boolean { return /a{2,1}/u.test(s); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
  });

  it("invalid u pattern via new RegExp throws a runtime SyntaxError", async () => {
    const src = `
      export function run(): number {
        try { new RegExp("\\\\m", "u").test("m"); return 0; }
        catch (e) { return e instanceof SyntaxError ? 1 : 2; }
      }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });
});
