// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6677) `new RegExp(dynamicPattern)` under `--target standalone` compiles the
// full pattern grammar at RUN time (src/codegen/regex-runtime/), in Wasm.
//
// Before: the runtime compiler `__regex_compile_dynamic_simple` accepted only a
// literal/alternation subset; `^abc`, `a+`, `[a]`, lookarounds, classes, `{n,m}`
// … produced a poisoned regexp whose first use threw
// `TypeError: Unsupported dynamic regular expression pattern` — marked's
// npm-compat standalone-dynamic lane died on it at the checksum call, because
// marked builds its lexer rules with `new RegExp(src.replace(…), flags)`.
//
// Every row runs the SAME source under Node (the oracle) and compiled
// standalone; a row passes when the rendered `exec` result — or the thrown
// error's name — is identical.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true, target: "standalone" } as const;

type Row = readonly [pattern: string, flags: string, subject: string];

const SHOW = `function mk(p, f) { return new RegExp(p, f); }
function show(p, f, s) {
  try {
    var m = mk(p, f).exec(s);
    if (m === null) return "null";
    var o = "" + m.index;
    for (var i = 0; i < m.length; i++) o += "|" + (m[i] === undefined ? "~" : m[i]);
    return o;
  } catch (e) {
    return "E:" + e.name;
  }
}`;

// marked 18's `k()` rule builder, verbatim in shape: regex sources spliced with
// String.prototype.replace, then `new RegExp(src, flags)`.
const MARKED_BUILDER = `var caret = /(^|[^\\[])\\^/g;
function k(l, e) {
  if (e === undefined) e = "";
  var t = typeof l == "string" ? l : l.source;
  var n = {
    replace: function (s, r) { var i = typeof r == "string" ? r : r.source; i = i.replace(caret, "$1"); t = t.replace(s, i); return n; },
    getRegex: function () { return new RegExp(t, e); },
  };
  return n;
}
var bullet = /(?:[*+-]|\\d{1,9}[.)])/;
var listItem = k(/^( {0,3}bull)([ \\t][^\\n]+?)?(?:\\n|$)/).replace(/bull/g, bullet).getRegex();
var punct = k(/[\\p{P}\\p{S}]/u).getRegex();
var heading = k("^ {0,3}(#{1,6})(?=\\\\s|$)(.*)(?:\\\\n+|$)").getRegex();`;

const ROWS: readonly Row[] = [
  ["^abc", "", "abc"],
  ["a+", "", "baaa"],
  ["[a]", "", "xa"],
  ["\\d{2,3}", "", "a12345"],
  ["(a)|(b)", "", "b"],
  ["a.*?b", "", "aXbYb"],
  ["ab*?cd", "", "abbcd"],
  ["x(?=y)", "", "xzxy"],
  ["(?<!a)b", "", "abcb"],
  ["(?<=\\$)\\d+", "", "cost $42"],
  ["(?<=(\\d+)(\\d+))$", "", "1053"],
  ["(\\w+)\\s\\1", "", "hello hello"],
  ["(?<q>['\"]).*?\\k<q>", "", "say 'hi' ok"],
  ["()(?<b>`+)[^`]+\\k<b>(?!`)", "", "a `y` b"],
  ["[^\\s]+", "", "  word  "],
  ["[\\d-z]+", "", "5-z"],
  ["(a*)*b", "", "aaab"],
  ["(?:(a)|b)+", "", "ab"],
  ["\\bfoo\\b", "", "a foo b"],
  ["^b", "m", "a\nb"],
  [".+", "s", "a\nb"],
  ["ABC", "i", "xabc"],
  ["[a-c]+", "i", "XBCA"],
  ["^ {0,1}<(?:[a-z].*>|!--)", "i", "<DIV>"],
  ["^\\p{Lu}\\p{Ll}+$", "u", "Hello"],
  ["[\\p{P}\\p{S}]", "u", "ab!c"],
  ["\\P{L}+", "u", "ab12cd"],
  ["\\u{1F600}", "u", "x😀"],
  [".", "u", "😀"],
  ["\\x41\\u0042\\cJ", "", "zAB\n"],
  ["[\\b]\\0", "", "a\b\0"],
  ["\\1(a)", "", "aa"],
  ["x{2,}?", "", "xxxx"],
  ["(?=a)*a", "", "a"],
  // Definite syntax errors now throw SyntaxError at construction.
  ["(", "", "x"],
  ["a)", "", "x"],
  ["a{2,1}", "", "x"],
  ["[z-a]", "", "x"],
  ["*a", "", "x"],
  ["\\k<nope>(?<a>x)", "", "x"],
];

function source(): string {
  return `${SHOW}
${MARKED_BUILDER}
var P = ${JSON.stringify(ROWS.map((r) => r[0]))};
var F = ${JSON.stringify(ROWS.map((r) => r[1]))};
var S = ${JSON.stringify(ROWS.map((r) => r[2]))};
export function row(i) { return show(P[i], F[i], S[i]); }
export function builder() {
  var a = listItem.exec("- item\\n");
  var b = heading.exec("## Title\\n");
  return (a ? a[1] + "/" + a[2] : "null") + "|" + (b ? b[1] + "/" + b[2] : "null") + "|" + (punct.test("a!") ? 1 : 0) + (punct.test("ab") ? 1 : 0);
}`;
}

async function runStandalone(src: string): Promise<{ row: (i: number) => string; builder: () => string }> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as { row: (i: number) => string; builder: () => string };
}

async function runInNode(src: string): Promise<{ row: (i: number) => string; builder: () => string }> {
  const url = `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
  return (await import(url)) as { row: (i: number) => string; builder: () => string };
}

describe("#6677 standalone runtime RegExp compiler — full grammar", () => {
  it("matches Node on every row and on marked's k() builder", async () => {
    const src = source();
    const node = await runInNode(src);
    // Strings cannot cross the standalone boundary; compare inside Wasm.
    const expected = ROWS.map((_, i) => node.row(i));
    const expectedBuilder = node.builder();
    const checked = `${src}
var X = ${JSON.stringify(expected)};
var XB = ${JSON.stringify(expectedBuilder)};
export function test(i) { return row(i) === X[i] ? 1 : 0; }
export function testBuilder() { return builder() === XB ? 1 : 0; }`;
    const wasm = (await runStandalone(checked)) as unknown as {
      test: (i: number) => number;
      testBuilder: () => number;
    };
    const failing = ROWS.map((r, i) =>
      wasm.test(i) === 1 ? null : `${JSON.stringify(r)} → node ${expected[i]}`,
    ).filter((x): x is string => x !== null);
    expect(failing).toEqual([]);
    expect(wasm.testBuilder()).toBe(1);
  }, 120_000);

  it("still refuses (catchable TypeError on first use) what it cannot model", async () => {
    // Non-ASCII case folding needs Unicode case tables the runtime does not
    // carry; the refusal must stay loud rather than match wrongly.
    const src = `${SHOW}
export function test() {
  var r = show("\\u00e9", "i", "\\u00c9");
  return r === "E:TypeError" ? 1 : 0;
}`;
    const wasm = (await runStandalone(src)) as unknown as { test: () => number };
    expect(wasm.test()).toBe(1);
  }, 120_000);
});
