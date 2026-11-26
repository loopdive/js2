// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7409 — an open-ended quantifier `{n,}` expands `n` mandatory copies, so the expansion cap must read `n` whatever
// the upper bound is. Before, `/x{2147483648,}x/` skipped the cap and exhausted the compiler heap
// (staging/sm/RegExp/regress-yarr-regexp.js).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compilePattern, RepeatTooLargeError } from "../src/regexp-compiler/compile.js";

describe("#7409 — the expansion cap covers an open-ended quantifier", () => {
  it.each(["x{2147483648,}x", "x{2147483648}x", "x{2147483647,2147483648}x", "x{1001,}"])(
    "refuses %s by name instead of expanding it",
    (pattern) => {
      expect(() => compilePattern(pattern, 0)).toThrow("exceeds expansion cap");
    },
  );

  it("throws RepeatTooLargeError, which the compile reports as an unsupported pattern", async () => {
    expect(() => compilePattern("x{2147483648,}x", 0)).toThrow(RepeatTooLargeError);
    const result = await compile('try { /x{2147483648,}x/.test("1"); } catch (e) {}', {
      fileName: "t.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("{2147483648,} exceeds expansion cap");
  });

  // Below the cap an open-ended quantifier still compiles and matches as in node.
  const CASES: readonly [string, string][] = [
    ["/x{3,}y/", "xxy"],
    ["/x{3,}y/", "xxxy"],
    ["/x{3,}y/", "axxxxxy"],
    ["/x{1000,}/", "x".repeat(999)],
    ["/x{1000,}/", "x".repeat(1000)],
  ];
  it.each(CASES)("standalone %s.test(%j) matches node", async (regexp, subject) => {
    const expected = new Function(`return ${regexp}.test(${JSON.stringify(subject)});`)() as boolean;
    const source = `export function run(): number { return ${regexp}.test(${JSON.stringify(subject)}) ? 1 : 0; }`;
    const result = await compile(source, { fileName: "t.ts", target: "standalone" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(result.binary), {});
    expect((instance.exports.run as () => number)()).toBe(expected ? 1 : 0);
  });
});
