import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #3068 — pure-Wasm String.prototype.isWellFormed (§22.1.3.8) /
// String.prototype.toWellFormed (§22.1.3.34) for the standalone / WASI
// (no-JS-host) lane. Host mode dispatched these through the generic
// __extern_method_call bridge; standalone fell through to the "Unknown string
// method" stub (invalid Wasm for isWellFormed). This completes the dual-mode
// pair with a WasmGC-native lowering (mirrors escape-native.ts). We verify the
// transform in-Wasm (native `===` on the result, returned as a 1/0 number) so
// no host string-marshalling is involved.

async function run(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // No imports object — a genuine standalone module must instantiate host-free.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

// `(call) === (expected)` evaluated inside the module → 1 when equal.
const check = (call: string, expected: string): string =>
  `export function test(): number { return (${call}) === (${expected}) ? 1 : 0; }`;

describe("#3068 standalone String.prototype.isWellFormed()", () => {
  it("returns true for well-formed BMP strings", async () => {
    expect(await run(check(`"abc".isWellFormed()`, `true`))).toBe(1);
    expect(await run(check(`"".isWellFormed()`, `true`))).toBe(1);
    expect(await run(check(`"a@#/._".isWellFormed()`, `true`))).toBe(1);
  });

  it("returns true for a well-formed surrogate pair", async () => {
    // U+1F600 😀 = 😀
    expect(await run(check(`"\\uD83D\\uDE00".isWellFormed()`, `true`))).toBe(1);
    expect(await run(check(`"a\\uD83D\\uDE00b".isWellFormed()`, `true`))).toBe(1);
    // Minimal astral U+10000 = 𐀀
    expect(await run(check(`"\\uD800\\uDC00".isWellFormed()`, `true`))).toBe(1);
  });

  it("returns false for a lone leading surrogate", async () => {
    expect(await run(check(`"a\\uD800b".isWellFormed()`, `false`))).toBe(1);
    expect(await run(check(`"\\uD800".isWellFormed()`, `false`))).toBe(1);
    // trailing leading-surrogate at the very end
    expect(await run(check(`"z\\uD800".isWellFormed()`, `false`))).toBe(1);
    // two leading surrogates in a row
    expect(await run(check(`"\\uD800\\uD800".isWellFormed()`, `false`))).toBe(1);
  });

  it("returns false for a lone trailing surrogate", async () => {
    expect(await run(check(`"x\\uDC00y".isWellFormed()`, `false`))).toBe(1);
    expect(await run(check(`"\\uDC00".isWellFormed()`, `false`))).toBe(1);
    // valid pair followed by a lone trailing surrogate
    expect(await run(check(`"\\uD83D\\uDE00\\uDC00".isWellFormed()`, `false`))).toBe(1);
  });
});

describe("#3068 standalone String.prototype.toWellFormed()", () => {
  it("leaves well-formed strings unchanged", async () => {
    expect(await run(check(`"abc".toWellFormed()`, `"abc"`))).toBe(1);
    expect(await run(check(`"".toWellFormed()`, `""`))).toBe(1);
    expect(await run(check(`"\\uD83D\\uDE00".toWellFormed()`, `"\\uD83D\\uDE00"`))).toBe(1);
    expect(await run(check(`"\\uD800\\uDC00".toWellFormed()`, `"\\uD800\\uDC00"`))).toBe(1);
  });

  it("replaces a lone leading surrogate with U+FFFD", async () => {
    expect(await run(check(`"a\\uD800b".toWellFormed()`, `"a\\uFFFDb"`))).toBe(1);
    expect(await run(check(`"\\uD800".toWellFormed()`, `"\\uFFFD"`))).toBe(1);
    expect(await run(check(`"z\\uD800".toWellFormed()`, `"z\\uFFFD"`))).toBe(1);
  });

  it("replaces a lone trailing surrogate with U+FFFD", async () => {
    expect(await run(check(`"x\\uDC00y".toWellFormed()`, `"x\\uFFFDy"`))).toBe(1);
    expect(await run(check(`"\\uDC00".toWellFormed()`, `"\\uFFFD"`))).toBe(1);
  });

  it("replaces each of two out-of-order lone surrogates", async () => {
    // \uDC00\uD800 — a trailing then a leading surrogate, both lone → two U+FFFD
    expect(await run(check(`"\\uDC00\\uD800".toWellFormed()`, `"\\uFFFD\\uFFFD"`))).toBe(1);
  });

  it("preserves length (1:1 substitution)", async () => {
    expect(await run(`export function test(): number { return "a\\uD800b\\uDC00c".toWellFormed().length; }`)).toBe(5);
  });
});

describe("#3068 standalone isWellFormed/toWellFormed are host-free", () => {
  it("emits no env import", async () => {
    const r = await compile(
      `export function test(): string { return ("a\\uD800b".isWellFormed() ? "" : "x").concat("a\\uD800b".toWellFormed()); }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(true);
    const envImports = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
    expect(envImports).toEqual([]);
  });
});
