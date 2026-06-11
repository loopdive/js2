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

describe("#1911 standalone RegExp Phase 2d Slice A — dual-run vs native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
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

  it("u flag stays a narrowed refusal (2d Slice B)", async () => {
    const r = await compile(`export function f(s: string): boolean { return /^a/u.test(s); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /#1539|#1474/.test(e.message))).toBe(true);
  });
});
