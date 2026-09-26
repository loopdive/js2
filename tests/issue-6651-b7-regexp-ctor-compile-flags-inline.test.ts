// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B7) Inline programs for §22.2.4.1 over an OBJECT
 * pattern (`regexp-ctor-regexp-like.ts`) and the sentinel-seeded expando slot
 * (`object-shape-widening.ts`). The test262 rows live in
 * `issue-6651-b7-regexp-ctor-compile-flags.test.ts` (split for the fork heap).
 * JS sources: the object patterns are not assignable to `string | RegExp`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a JS source standalone, assert no host import leaked, and run `test`. */
async function runStandaloneJs(source: string, fileName: string): Promise<number> {
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

describe("#6651 B7 — inline: RegExp(pattern) over an object, and a sentinel-seeded slot", () => {
  it("IsRegExp via @@match, the identity short-circuit, and the regexp-like source/flags reads", async () => {
    const source = `
function same(a, b) {
  return a === b;
}
export function test() {
  var obj = { constructor: RegExp, source: "ab", flags: "i" };
  obj[Symbol.match] = true;
  if (!same(RegExp(obj), obj)) return -1;
  var made = new RegExp(obj);
  if (same(made, obj)) return -2;
  if (made.source !== "ab") return -3;
  if (made.flags !== "i") return -4;
  if (!made.test("xAB")) return -5;
  if (new RegExp(obj, "g").flags !== "g") return -6;
  obj[Symbol.match] = false;
  if (same(RegExp(obj), obj)) return -7;
  obj.toString = function () { return "z"; };
  if (new RegExp(obj).source !== "z") return -8;
  var other = { constructor: Object, source: "q", flags: "" };
  other[Symbol.match] = 1;
  var copy = RegExp(other);
  if (same(copy, other) || copy.source !== "q") return -9;
  return 1;
}
`;
    expect(await runStandaloneJs(source, "b7-ctor-regexp-like.js")).toBe(1);
  }, 200_000);

  it("a slot first written undefined keeps a later primitive", async () => {
    const source = `
var r = {};
r.global = undefined;
r.global = "string";
var n = {};
n.count = null;
n.count = 7;
export function test() {
  if (r.global !== "string") return -1;
  if (n.count !== 7) return -2;
  return 1;
}
`;
    expect(await runStandaloneJs(source, "b7-sentinel-slot.js")).toBe(1);
  }, 200_000);
});
