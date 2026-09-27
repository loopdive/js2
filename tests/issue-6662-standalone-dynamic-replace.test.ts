// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6662) `String.prototype.replace` / `replaceAll` with a search value or a
// replacement value that is only known at RUNTIME, `--target standalone`.
//
// Before: every such call site was a COMPILE error (`#1474` "RegExp or
// symbol-protocol search value is not supported" / `#1913 follow-up` "replace
// with a function (or non-string) replacer"), which failed the whole module.
// That kept hono, marked, moment and styled-components out of the npm-compat
// standalone lane. Now `src/codegen/string-replace-dynamic.ts` dispatches at
// runtime: a backend RegExp runs the §22.2.6.11 `@@replace` body, anything else
// takes the §22.1.3.19 string path (ToString + GetSubstitution, or a per-match
// `Call` for a callable replacer).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
}

async function runModule(src: string): Promise<number> {
  const r = await compileStandalone(src);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test: () => number }).test();
}

// `rep` takes untyped parameters, so every operand is `any` — the exact shape
// of the npm packages' call sites.
const REP = "function rep(s, a, b) { return s.replace(a, b); }\n";
const REP_ALL = "function rep(s, a, b) { return s.replaceAll(a, b); }\n";

const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "string search, string replacement",
    `${REP}export function test() { return rep("a-b-c", "-", "+") === "a+b-c" ? 1 : 0; }`,
  ],
  [
    "replaceAll string search",
    `${REP_ALL}export function test() { return rep("a-b-c", "-", "+") === "a+b+c" ? 1 : 0; }`,
  ],
  [
    "$-patterns on the string path",
    `${REP}export function test() { return rep("a-b", "-", "[$&$\`$']") === "a[-ab]b" ? 1 : 0; }`,
  ],
  ["global RegExp search", `${REP}export function test() { return rep("a-b-c", /-/g, "+") === "a+b+c" ? 1 : 0; }`],
  [
    "RegExp capture groups in $n",
    `${REP}export function test() { return rep("john smith", /(\\w+)\\s(\\w+)/, "$2, $1") === "smith, john" ? 1 : 0; }`,
  ],
  [
    "RegExp search, function replacer (match, group, offset)",
    `${REP}export function test() { return rep("a1b22", /(\\d+)/g, function (m, g, p) { return "<" + g + "@" + p + ">"; }) === "a<1@1>b<22@3>" ? 1 : 0; }`,
  ],
  [
    "string search, function replacer (match, offset, input)",
    `${REP}export function test() { return rep("x-y", "-", function (m, p, str) { return m + p + str; }) === "x-1x-yy" ? 1 : 0; }`,
  ],
  [
    "replaceAll string search, function replacer",
    `${REP_ALL}export function test() { return rep("a.b.c", ".", function (m, p) { return String(p); }) === "a1b3c" ? 1 : 0; }`,
  ],
  ["replaceAll empty search", `${REP_ALL}export function test() { return rep("ab", "", "_") === "_a_b_" ? 1 : 0; }`],
  [
    "replaceAll empty search, function replacer",
    `${REP_ALL}export function test() { return rep("ab", "", function (m, p) { return String(p); }) === "0a1b2" ? 1 : 0; }`,
  ],
  [
    "static RegExp, non-string replacement (moment's `output.replace(/%d/i, number)`)",
    `function f(s, n) { return s.replace(/%d/i, n); }\nexport function test() { return f("in %d days", 5) === "in 5 days" ? 1 : 0; }`,
  ],
  [
    "static RegExp, function held in an untyped parameter",
    `function f(s, fn) { return s.replace(/%d/i, fn); }\nexport function test() { return f("in %d days", function (m) { return "<" + m + ">"; }) === "in <%d> days" ? 1 : 0; }`,
  ],
  [
    "runtime-built RegExp with an inline function replacer (styled-components)",
    `function f(s, x) { var r = new RegExp(x + "b", "g"); return s.replace(r, function (a) { return "[" + a + "]"; }); }\nexport function test() { return f("abxab", "a") === "[ab]x[ab]" ? 1 : 0; }`,
  ],
  ["replaceAll global RegExp", `${REP_ALL}export function test() { return rep("aXa", /a/g, "b") === "bXb" ? 1 : 0; }`],
  [
    "replaceAll non-global RegExp throws TypeError",
    `${REP_ALL}export function test() { try { rep("aa", /a/, "b"); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }`,
  ],
  [
    "number search value is ToString'd",
    `${REP}export function test() { return rep("a1b", 1, "_") === "a_b" ? 1 : 0; }`,
  ],
  [
    "undefined search value is the text 'undefined'",
    `${REP}export function test() { return rep("xundefinedy", undefined, "_") === "x_y" ? 1 : 0; }`,
  ],
  [
    "RegExp held in an object property (marked's rules tables)",
    `var rules = { a: /-/g };\nfunction g(o, s) { return s.replace(o.a, "+"); }\nexport function test() { return g(rules, "a-b-c") === "a+b+c" ? 1 : 0; }`,
  ],
  [
    "global replace resets lastIndex",
    `${REP}var re = /a/g;\nexport function test() { re.lastIndex = 3; var r = rep("aaa", re, "b"); return (r === "bbb" ? 1 : 0) + (re.lastIndex === 0 ? 2 : 0); }`,
  ],
  [
    "sticky replace starts at and advances lastIndex",
    `${REP}var re = /a/y;\nexport function test() { re.lastIndex = 1; var r = rep("aaa", re, "b"); return (r === "aba" ? 1 : 0) + (re.lastIndex === 2 ? 2 : 0); }`,
  ],
];

const OBJECT_CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "an Object search value's own @@replace is called with (string, replaceValue)",
    `var sv = {};\nsv[Symbol.replace] = function (s, r) { return "hit:" + s + ":" + r; };\n${REP}export function test() { return rep("abc", sv, "x") === "hit:abc:x" ? 1 : 0; }`,
  ],
  [
    "an Object without @@replace is ToString'd through its own toString",
    `var sv = { toString: function () { return "b"; } };\n${REP}export function test() { return rep("abc", sv, "x") === "axc" ? 1 : 0; }`,
  ],
  [
    "a null search value is the text 'null'",
    `${REP}export function test() { return rep("anullc", null, "x") === "axc" ? 1 : 0; }`,
  ],
];

const EXPECTED: Record<string, number> = {
  "global replace resets lastIndex": 3,
  "sticky replace starts at and advances lastIndex": 3,
};

describe("#6662 standalone replace/replaceAll with runtime-only operands", () => {
  for (const [name, src] of [...CASES, ...OBJECT_CASES]) {
    it(name, async () => {
      expect(await runModule(src)).toBe(EXPECTED[name] ?? 1);
    });
  }

  it("routes through the runtime dispatcher (anti-vacuity: the helper is present)", async () => {
    const r = await compile(`${REP}export function test() { return rep("a-b", "-", "+") === "a+b" ? 1 : 0; }`, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
    expect(r.success).toBe(true);
    expect(r.wat).toContain("$__str_replace_dyn");
  });

  it("leaves a statically-typed string replace on its native arm (no helper minted)", async () => {
    const r = await compile(`export function test(): number { return "a-b".replace("-", "+") === "a+b" ? 1 : 0; }`, {
      fileName: "test.ts",
      target: "standalone",
      emitWat: true,
    });
    expect(r.success).toBe(true);
    expect(r.wat).not.toContain("$__str_replace_dyn");
  });

  it("keeps refusing a static named-group pattern with an un-provable replacer", async () => {
    const r = await compileStandalone(
      `function f(s, fn) { return s.replace(/(?<y>\\d+)/, fn); }\nexport function test() { return f("2020", function () { return "x"; }) === "x" ? 1 : 0; }`,
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("#1913 follow-up");
  });
});
