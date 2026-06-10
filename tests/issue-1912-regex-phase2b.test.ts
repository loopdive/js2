// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1912 — standalone RegExp Phase 2b: word boundaries, backreferences, and
 * character-class compatibility, plus runtime SyntaxError lowering for
 * genuinely invalid `new RegExp(...)` patterns.
 *
 * Each case compiles under `--target standalone`, instantiates with an EMPTY
 * import object (no JS host), and dual-runs against the native engine. The
 * matcher itself is unit-tested in pure TS by tests/regex-bytecode.test.ts;
 * this file validates the Wasm VM arms (WBOUND/BACKREF) and the codegen
 * routing end-to-end.
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

// `p` holds the literal regex source; the same `p` drives the standalone
// compile and the native `new RegExp(p, f)` reference.
const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  // Word boundaries \b / \B (§22.2.2.6).
  { p: "\\bcat\\b", f: "", inputs: ["the cat sat", "concatenate", "cat", "a cat."] },
  { p: "\\Bcat", f: "", inputs: ["concatenate", "the cat", "scat"] },
  { p: "\\b\\w+\\b", f: "", inputs: ["hello world", " x ", ""] },
  { p: "\\bok\\b", f: "i", inputs: ["OK then", "joke"] },
  // Backreferences (§22.2.2.9): plain, alt-bound, unset-group-empty, named,
  // forward reference, case-insensitive comparison.
  { p: "(a+)\\1", f: "", inputs: ["aa", "aaaa", "a", "baab"] },
  { p: "(ab|cd)e\\1", f: "", inputs: ["abeab", "cdecd", "abecd"] },
  { p: "(a)?b\\1", f: "", inputs: ["b", "aba"] },
  { p: "(?<x>\\d+)-\\k<x>", f: "", inputs: ["12-12", "12-13", "7-7"] },
  { p: "\\1(a)", f: "", inputs: ["a"] },
  { p: "(A)\\1", f: "i", inputs: ["aa", "aA", "Ab"] },
  // `\/` so the pattern stays valid inside the generated regex literal.
  { p: "<(\\w+)>.*<\\/\\1>", f: "", inputs: ["<b>hi</b>", "<b>hi</i>"] },
  // Class compatibility: negated shorthands in classes, Annex B literal
  // hyphen next to a shorthand, legacy octal, control escape, identity \8.
  { p: "[\\D]+", f: "", inputs: ["abc123", "123"] },
  { p: "[\\W]", f: "", inputs: ["a_b", "a b", "ab"] },
  { p: "[\\S]+", f: "", inputs: ["  x  ", "   "] },
  { p: "[^\\D]", f: "", inputs: ["abc1", "abc"] },
  { p: "[\\d-z]+", f: "", inputs: ["a-9z", "qrs", "-", "/"] },
  { p: "[a-\\d]+", f: "", inputs: ["a-9", "b", "5"] },
  { p: "\\05", f: "", inputs: ["\x05", "5"] },
  { p: "(a)\\2", f: "", inputs: ["a\x02", "aa"] },
  { p: "\\cA", f: "", inputs: ["\x01", "cA"] },
  { p: "\\8", f: "", inputs: ["8", "x"] },
  { p: "[\\b]", f: "", inputs: ["\b", "b"] },
];

describe("#1912 standalone RegExp Phase 2b — dual-run vs native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = new RegExp(p, f).test(input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }

  it("backref capture slots flow into exec result", async () => {
    const src = `
      export function matched(): boolean { const m = /(?<x>a+)b\\k<x>/.exec("xaabaay"); return m !== null; }
      export function len(i: number): number { const m = /(?<x>a+)b\\k<x>/.exec("xaabaay")!; return m[i]!.length; }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as { matched(): number; len(i: number): number };
    expect(ex.matched()).toBe(1);
    expect(ex.len(0)).toBe(5); // "aabaa"
    expect(ex.len(1)).toBe(2); // "aa"
  });
});

describe("#1912 runtime SyntaxError for invalid new RegExp(...)", () => {
  // §22.2.3.2: an invalid static pattern throws SyntaxError when the
  // constructor call EVALUATES — the compile must succeed and the throw must
  // be catchable with the right brand (the S15.10.1 / S15.10.2.15 test262
  // families). Regex literals keep the compile-time diagnostic (early error).
  async function syntaxProbe(callExpr: string): Promise<number> {
    const src = `
      export function run(): number {
        try {
          ${callExpr};
          return 0;
        } catch (e) {
          if (e instanceof SyntaxError) return 1;
          return 2;
        }
      }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
    expect(hostRegex, "no RegExp host import in standalone").toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { run(): number }).run();
  }

  it("class range out of order: new RegExp('[b-ac-e]').exec(...)", async () => {
    expect(await syntaxProbe(`new RegExp("[b-ac-e]").exec("a")`)).toBe(1);
  });
  it("nothing to repeat: new RegExp('a**')", async () => {
    expect(await syntaxProbe(`new RegExp("a**").test("a")`)).toBe(1);
  });
  it("quantified anchor: new RegExp('^*')", async () => {
    expect(await syntaxProbe(`new RegExp("^*").test("a")`)).toBe(1);
  });
  it("invalid flags: new RegExp('a', 'gg')", async () => {
    expect(await syntaxProbe(`new RegExp("a", "gg").test("a")`)).toBe(1);
  });
  it("valid pattern does NOT throw", async () => {
    expect(await syntaxProbe(`new RegExp("a+").test("ba")`)).toBe(0);
  });

  it("invalid regex literal stays a compile-time diagnostic (early error)", async () => {
    const r = await compile(`export function f(s: string): boolean { return /a**/.test(s); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
  });
});
