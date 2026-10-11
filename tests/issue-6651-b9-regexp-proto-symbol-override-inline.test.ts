// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B9) Inline programs for a replaced
 * `RegExp.prototype[Symbol.<m>]`, `--target standalone`. Every case fails on
 * the pre-B9 tree. The test262 rows live in
 * `issue-6651-b9-regexp-proto-symbol-override.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a JS source for standalone, and run `test`. */
async function runJs(source: string, fileName: string): Promise<number> {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 B9 — inline", () => {
  it("the literal read-back sees the replacement, and the builtin before it", async () => {
    const source = `
var orig = RegExp.prototype[Symbol.match];
var f = function () { return 1; };
export function test() {
  var before = typeof orig === "function" ? 1 : 0;
  RegExp.prototype[Symbol.match] = f;
  var after = RegExp.prototype[Symbol.match] === f ? 10 : 0;
  RegExp.prototype[Symbol.match] = orig;
  var restored = RegExp.prototype[Symbol.match] === orig ? 100 : 0;
  return before + after + restored;
}
`;
    expect(await runJs(source, "b9-read-back.js")).toBe(111);
  }, 200_000);

  it("String.prototype.search / match over a string argument Invoke the replacement", async () => {
    const source = `
var seen;
var marker = {};
var origSearch = RegExp.prototype[Symbol.search];
RegExp.prototype[Symbol.search] = function (s) { seen = this; return marker; };
// Module-level and untyped, as in the test262 rows: a binding the compiler types
// \`number\` (from search's declared return) cannot hold the replacement's object.
var r;
export function test() {
  r = "target".search("rg");
  var ok = r === marker ? 1 : 0;
  var src = seen.source === "rg" ? 10 : 0;
  var fl = seen.flags === "" ? 100 : 0;
  RegExp.prototype[Symbol.search] = origSearch;
  var back;
  back = "target".search("rg");
  return ok + src + fl + (back === 2 ? 1000 : 0);
}
`;
    expect(await runJs(source, "b9-string-search.js")).toBe(1111);
  }, 200_000);

  it("a RegExp argument and the direct spelling both reach the replacement", async () => {
    const source = `
var marker = {};
var calls = 0;
RegExp.prototype[Symbol.match] = function () { calls++; return marker; };
export function test() {
  var re = /x/;
  var a;
  a = "xyz".match(re);
  var b;
  b = re[Symbol.match]("xyz");
  return (a === marker ? 1 : 0) + (b === marker ? 10 : 0) + calls * 100;
}
`;
    expect(await runJs(source, "b9-regexp-arg.js")).toBe(211);
  }, 200_000);

  it("an untyped RegExp's .flags reads the accessor, not the bitfield", async () => {
    const source = `
var t;
function set(v) { t = v; }
set(new RegExp("a", "gi"));
export function test() {
  return t.flags === "gi" ? 1 : 0;
}
`;
    expect(await runJs(source, "b9-untyped-flags.js")).toBe(1);
  }, 200_000);
});
