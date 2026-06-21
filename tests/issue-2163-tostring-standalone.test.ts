// #2163 slice 4 — standalone `Symbol.prototype.toString()` / `String(symbol)`.
//
// The symbol value is a bare i32 counter id. Without a dedicated handler,
// `sym.toString()` fell through to the generic `.toString()` fallback, which
// drops the id and emits `"[object Object]"` via a string-constant global that
// in native-strings / standalone mode resolves to the -1 sentinel — the
// late-import index-shift CE (#2043 class: "global index out of range — -1").
// So EVERY `sym.toString()` was a hard standalone compile error.
//
// Fix (src/codegen/symbol-native.ts `emitSymbolToString`, wired in
// src/codegen/expressions/calls.ts): build §20.4.3.3.1 SymbolDescriptiveString
// `"Symbol(" + (desc ?? "") + ")"` natively from the description side table,
// concatenated via the native `__str_concat` helper — zero host imports.
// `Symbol.prototype.valueOf()` returns the symbol primitive (the i32 id) itself.
// `String(symbol)` is the one ToString form that does NOT throw and is routed
// through the same native builder.
//
// (Out of this slice: `Symbol.prototype.toString.call(s)` — the #1888 Slice 3/4
// borrowed-method brand path is not yet native in standalone and errors loudly,
// identically on main; tracked separately.)
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// Standalone modules must instantiate with ZERO host imports.
async function runStandaloneZeroImports(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2163 standalone Symbol.prototype.toString (native descriptive string)", () => {
  it("Symbol('66').toString() === 'Symbol(66)' (§20.4.3.3)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return Symbol("66").toString() === "Symbol(66)" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol().toString() === 'Symbol()' (undefined description ⇒ empty)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return Symbol().toString() === "Symbol()" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol('').toString() === 'Symbol()' (empty description ⇒ empty)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return Symbol("").toString() === "Symbol()" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("descriptive string length is correct ('Symbol(abc)' === 11)", async () => {
    expect(
      await runStandaloneZeroImports(`export function run(): number { return Symbol("abc").toString().length; }`),
    ).toBe(11);
  });

  it("first char of the descriptive string is 'S'", async () => {
    expect(
      await runStandaloneZeroImports(`export function run(): number { return Symbol("x").toString().charCodeAt(0); }`),
    ).toBe(83);
  });

  it("distinct descriptions produce distinct descriptive strings", async () => {
    expect(
      // "Symbol(aa)" = 10, "Symbol(bbb)" = 11 → 10*100 + 11 = 1011
      await runStandaloneZeroImports(
        `export function run(): number { const a = Symbol("aa").toString(); const b = Symbol("bbb").toString(); return a.length * 100 + b.length; }`,
      ),
    ).toBe(1011);
  });

  it("String(Symbol('66')) === 'Symbol(66)' (§22.1.1.1 — no throw on symbol)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return String(Symbol("66")) === "Symbol(66)" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("String(Symbol()) === 'Symbol()'", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return String(Symbol()) === "Symbol()" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol.prototype.valueOf() returns the symbol primitive (identity)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { const s = Symbol("x"); return s.valueOf() === s ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("registry symbol toString reflects its key description (§20.4.2.2)", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number { return Symbol.for("k").toString() === "Symbol(k)" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
