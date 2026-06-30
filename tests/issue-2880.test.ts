import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { hasLoneSurrogate, hexCodeUnits } from "../src/string-surrogate.js";

// #2880 — host-mode string constants containing a lone (unpaired) surrogate.
//
// Host-mode literals are imported externref globals whose wasm import field name
// IS the literal text. A field name must be valid UTF-8, but a lone surrogate
// (U+D800–U+DFFF not part of a valid pair) is not a Unicode scalar value:
// TextEncoder makes it U+FFFD (lossy) and V8 rejects WTF-8. So the constant used
// to resolve to `undefined`, breaking codePointAt/at/charCodeAt/padStart/… on
// any string with a lone surrogate. The fix routes such constants through a
// separate `string_constants16` import namespace keyed by the hex of the UTF-16
// code units (ASCII). Surrogate-free literals are byte-identical (regression
// control below).

async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as any)[fn](...args);
}

describe("string-surrogate helpers (#2880)", () => {
  it("hasLoneSurrogate detects only unpaired surrogates", () => {
    expect(hasLoneSurrogate("abc")).toBe(false);
    expect(hasLoneSurrogate("💩")).toBe(false); // valid astral pair (💩)
    expect(hasLoneSurrogate("\uD800")).toBe(true); // lone high
    expect(hasLoneSurrogate("\uDC00")).toBe(true); // lone low
    expect(hasLoneSurrogate("123\uD800")).toBe(true); // lone high at end
    expect(hasLoneSurrogate("\uD800\uDBFF")).toBe(true); // high + non-trail
    expect(hasLoneSurrogate("💩\uD83Dabc")).toBe(true); // pair then lone high
  });

  it("hexCodeUnits is the 4-hex-digit-per-code-unit ASCII key", () => {
    expect(hexCodeUnits("12\uD800")).toBe("00310032d800");
    expect(hexCodeUnits("\uDC00")).toBe("dc00");
  });
});

describe("host-mode lone-surrogate string constants (#2880)", () => {
  it("codePointAt returns the lone surrogate code unit", async () => {
    const ret = await run(`
      export function test(): f64 {
        let f = 0;
        if ('\\uDC00\\uAAAA'.codePointAt(0) !== 0xDC00) f += 1; // lone trail
        if ('123\\uD800'.codePointAt(3) !== 0xD800) f += 2;     // lone lead at end
        if ('\\uD800\\uDBFF'.codePointAt(0) !== 0xD800) f += 4; // lead + non-trail
        if ('\\uD800\\uDC00'.codePointAt(0) !== 0x10000) f += 8; // valid pair -> astral
        return f as f64;
      }`);
    expect(ret).toBe(0);
  });

  it("charCodeAt and length survive a lone surrogate", async () => {
    const ret = await run(`
      export function test(): f64 {
        let f = 0;
        const s = '12\\uD80034';
        if (s.length !== 5) f += 1;
        if (s.charCodeAt(2) !== 0xD800) f += 2;
        if (s.charCodeAt(3) !== 51) f += 4; // '3'
        return f as f64;
      }`);
    expect(ret).toBe(0);
  });

  it("at returns the lone surrogate as a single-code-unit string equal to its constant", async () => {
    const ret = await run(`
      export function test(): f64 {
        const s = '12\\uD80034';
        return (s.at(2) === '\\uD800') ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  it("padStart/padEnd that split an astral pair compare equal to a lone-surrogate constant", async () => {
    // 'abc'.padStart(6, '💩') -> '💩\uD83Dabc' (the pad fill splits the pair,
    // leaving a lone lead surrogate); must equal the expected constant.
    const ret = await run(`
      export function test(): f64 {
        let f = 0;
        if ('abc'.padStart(6, '\\uD83D\\uDCA9') !== '\\uD83D\\uDCA9\\uD83Dabc') f += 1;
        if ('abc'.padEnd(6, '\\uD83D\\uDCA9') !== 'abc\\uD83D\\uDCA9\\uD83D') f += 2;
        return f as f64;
      }`);
    expect(ret).toBe(0);
  });

  it("equality of two identical lone-surrogate constants holds", async () => {
    const ret = await run(`
      export function test(): f64 {
        const a = '\\uD800x';
        const b = '\\uD800x';
        return (a === b && a !== '\\uDC00x') ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  // Regression control: surrogate-free constants are untouched.
  it("surrogate-free strings still work (regression control)", async () => {
    const ret = await run(`
      export function test(): f64 {
        let f = 0;
        if ('hello world'.length !== 11) f += 1;
        if ('café'.codePointAt(3) !== 0xE9) f += 2;       // é (BMP non-ASCII)
        if ('😀abc'.codePointAt(0) !== 0x1F600) f += 4;   // valid astral pair
        if ('abc'.padStart(5, '*') !== '**abc') f += 8;
        return f as f64;
      }`);
    expect(ret).toBe(0);
  });
});
