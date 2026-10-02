// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B10) Inline programs for `%RegExp.prototype%` seen
 * through an UNTYPED RegExp (`var r; r = /…/;` read inside a function, where
 * the checker types `r` as `any`), `--target standalone`. Every case fails on
 * the pre-B10 tree. The test262 rows live in
 * `issue-6651-b10-regexp-untyped-receiver.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a JS source for standalone, and run `test`. */
async function runJs(source: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 B10 — inline", () => {
  it("a runtime method read answers RegExp.prototype.<m>, identity-stable and callable", async () => {
    const source = `
var r;
r = /b/g;
export function test() {
  var t = r.test;
  var e = r["exec"];
  var a = typeof t === "function" ? 1 : 0;
  var b = t === RegExp.prototype.test ? 10 : 0;
  // Truthiness, not \`=== true\`: a value-extracted \`test\` closure's \`.call\`
  // boxes its i32 result as a number (pre-existing, recorded in the B10 entry).
  var c = t.call(r, "abc") ? 100 : 0;
  var d = typeof e === "function" ? 1000 : 0;
  return a + b + c + d;
}
`;
    expect(await runJs(source, "b10-method-read.js")).toBe(1111);
  }, 200_000);

  it("toString — call, String(), concatenation, own shadowing — renders /source/flags", async () => {
    const source = `
var r;
r = /a+b/gi;
export function test() {
  var n = 0;
  if (r.toString() === "/a+b/gi") n += 1;
  if (String(r) === "/a+b/gi") n += 10;
  if (r + "" === "/a+b/gi") n += 100;
  if (typeof r.toString === "function") n += 1000;
  // An own property shadows the prototype member; deleting it re-exposes it.
  r.toString = function () { return "own"; };
  if (String(r) === "own") n += 10000;
  delete r.toString;
  if (String(r) === "/a+b/gi") n += 100000;
  return n;
}
`;
    expect(await runJs(source, "b10-to-string.js")).toBe(111111);
  }, 200_000);

  it("Object.getPrototypeOf answers RegExp.prototype", async () => {
    const source = `
var r;
r = /x/y;
export function test() {
  var p = Object.getPrototypeOf(r);
  var a = p === RegExp.prototype ? 1 : 0;
  var b = p !== null ? 10 : 0;
  return a + b;
}
`;
    expect(await runJs(source, "b10-gpo.js")).toBe(11);
  }, 200_000);
});
