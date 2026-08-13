// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — a numeric-first array literal that also holds a STRING LITERAL must
 * not lower to an f64 vec in the JS-host/GC lane.
 *
 * The `hasObjectElem` widening scan in `compileArrayLiteral` carved out
 * `StringLiteral` elements so the native-strings lanes could keep the numeric
 * fast path (they have their own `hasNativeStringElem` scan). The host lane has
 * no such scan and a string is plain `externref` there, so the carve-out made
 * the literal and non-literal spellings of the same array disagree:
 *
 *   var s = "a"; [0, s]   // widened — "a" survives
 *   [0, "a"]              // NOT widened — f64 vec — reads back NaN
 *
 * which is why `compareArray.js` saw `[0, 'a', undefined]` as `[0, NaN, NaN]`
 * and reported two arrays differing only in their string elements as equal.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<string[]> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4394 — numeric-first array literal with a string element", () => {
  it("preserves string and undefined elements", async () => {
    const logged = await runJs(`
var a = [0, "a", undefined];
console.log("len: " + a.length);
console.log("e0: " + typeof a[0] + " " + a[0]);
console.log("e1: " + typeof a[1] + " " + a[1]);
console.log("e2: " + typeof a[2] + " " + a[2]);
`);
    expect(logged).toContain("len: 3");
    expect(logged).toContain("e0: number 0");
    expect(logged).toContain("e1: string a");
    expect(logged).toContain("e2: undefined undefined");
  });

  it("agrees with the non-literal spelling of the same array", async () => {
    const logged = await runJs(`
var s = "a";
var viaVar = [0, s];
var viaLiteral = [0, "a"];
console.log("var: " + typeof viaVar[1] + " " + viaVar[1]);
console.log("literal: " + typeof viaLiteral[1] + " " + viaLiteral[1]);
`);
    expect(logged).toContain("var: string a");
    expect(logged).toContain("literal: string a");
  });

  it("distinguishes two arrays that differ only in a string element", async () => {
    // Written without a comparator helper and without `===` on the array
    // ELEMENTS: both shapes trip UNRELATED, pre-existing IR-path refusals
    // ("arg 0 ... expected dynamic", "'===' on externref operands not supported
    // in IR") that reproduce identically without this change.
    const logged = await runJs(`
var first = [0, "a", undefined];
var second = [0, "b", undefined];
console.log("first1: " + first[1]);
console.log("second1: " + second[1]);
console.log("differ: " + (String(first[1]) !== String(second[1])));
`);
    expect(logged).toContain("first1: a");
    expect(logged).toContain("second1: b");
    expect(logged).toContain("differ: true");
  });

  it("leaves a homogeneous numeric literal on the numeric path", async () => {
    const logged = await runJs(`
var nums = [1, 2, 3];
var total = 0;
for (var i = 0; i < nums.length; i++) total += nums[i];
console.log("sum: " + total);
console.log("type: " + typeof nums[1]);
`);
    expect(logged).toContain("sum: 6");
    expect(logged).toContain("type: number");
  });
});
