// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B8) Inline programs for the three B8 mechanisms. The
 * test262 rows live in `issue-6651-b8-regexp-protocol-tail.test.ts`.
 * JS sources: the `var r; r = /./g;` receiver must be `any` to the checker.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a JS source for `target`, and run `test`. */
async function runJs(source: string, fileName: string, target?: "standalone"): Promise<number> {
  const result = await compile(source, {
    fileName,
    ...(target ? { target } : {}),
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (target === "standalone") expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 B8 — inline", () => {
  it("a closure returning `null | { get 0() {…} }` keeps the accessor object (standalone)", async () => {
    const source = `
var cnt = 0;
var n = 0;
var r = /./g;
r.exec = function () {
  if (n++ > 0) return null;
  return { get 0() { cnt++; return "a"; } };
};
export function test() {
  r[Symbol.match]("");
  return n * 10 + cnt;
}
`;
    // exec runs twice (the match, then null) and the "0" getter runs once.
    expect(await runJs(source, "b8-union-return.js", "standalone")).toBe(21);
  }, 200_000);

  it("r[Symbol.match](s) on an any-typed receiver runs the protocol (standalone)", async () => {
    const source = `
var cnt = 0;
var r;
r = /./g;
r.exec = function () { cnt += 1; return null; };
var o;
o = {};
o[Symbol.search] = function (s) { return s.length * 100; };
export function test() {
  var m = r[Symbol.match]("");
  if (m !== null) return -1;
  var s = r[Symbol.search]("abc");
  var custom = o[Symbol.search]("xyz");
  var threw = 0;
  var bad;
  bad = {};
  try { bad[Symbol.match]("q"); } catch (e) { threw = e instanceof TypeError ? 1 : 2; }
  return cnt * 10000 + custom + threw * 10 + (s === -1 ? 0 : 5);
}
`;
    // exec: once for @@match, once for @@search (which answers -1 from the null result).
    expect(await runJs(source, "b8-any-receiver.js", "standalone")).toBe(20310);
  }, 200_000);

  it("`compile` on a literal binding drops its static `g` (standalone)", async () => {
    const source = `
var subject = /a/g;
subject.compile("a", "i");
export function test() {
  subject.lastIndex = 1;
  return subject.test("A") ? 1 : 0;
}
`;
    expect(await runJs(source, "b8-compile-flags.js", "standalone")).toBe(1);
  }, 200_000);

  it("a one-argument replace/replaceAll over an object search value (standalone)", async () => {
    const source = `
var o;
o = { toString: function () { return "b"; } };
export function test() {
  var s = "abc".replace(o);
  var t = "abcb".replaceAll(o);
  return s === "aundefinedc" && t === "aundefinedcundefined" ? 1 : -1;
}
`;
    expect(await runJs(source, "b8-replace-one-arg.js", "standalone")).toBe(1);
  }, 200_000);
});
