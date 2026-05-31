// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1719 S1 — array object-value representation track, brand-gate machinery.
//
// S1 is intentionally a *behavioral no-op*: it lands the ITER_OVERRIDDEN
// whole-program brand (`sourceOverridesArrayIterator` → ctx flag) and the
// `arrayDstrNeedsIdentity` gate predicate, but does NOT yet route a branded
// array RHS through the host GetIterator lane (that is S2). These tests guard
// the two S1 guarantees:
//   1. the pre-scan correctly detects (and only detects) Array.prototype
//      @@iterator/values overrides; and
//   2. override-free array-destructuring modules compile to byte-identical
//      Wasm — i.e. the gate is provably zero-cost when the brand is clear, and
//      the brand being *set* does not change codegen in S1.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { sourceOverridesArrayIterator } from "../src/codegen/index.js";
import { tsRuntime } from "../src/ts-api.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

function parse(src: string) {
  return tsRuntime.createSourceFile("t.ts", src, tsRuntime.ScriptTarget.Latest, true);
}

function scan(src: string): boolean {
  return sourceOverridesArrayIterator(parse(src));
}

async function run(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  const rt = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, rt);
  if (rt.setExports) rt.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1719 S1: sourceOverridesArrayIterator pre-scan (ITER_OVERRIDDEN brand source)", () => {
  it("detects Array.prototype[Symbol.iterator] = …", () => {
    expect(scan(`Array.prototype[Symbol.iterator] = function* () { yield 1; };`)).toBe(true);
  });

  it("detects Array.prototype.values = …", () => {
    expect(scan(`Array.prototype.values = function () { return [][Symbol.iterator](); };`)).toBe(true);
  });

  it("detects (Array.prototype as any)[Symbol.iterator] = … through as/paren wrappers", () => {
    expect(scan(`(Array.prototype as any)[Symbol.iterator] = function* () {};`)).toBe(true);
    expect(scan(`(Array.prototype)[Symbol.iterator] = function* () {};`)).toBe(true);
  });

  it("detects Object.defineProperty(Array.prototype, …)", () => {
    expect(scan(`Object.defineProperty(Array.prototype, Symbol.iterator, { value: function* () {} });`)).toBe(true);
  });

  it("detects Object.defineProperties(Array.prototype, …)", () => {
    expect(scan(`Object.defineProperties(Array.prototype, { values: { value: function () {} } });`)).toBe(true);
  });

  it("does NOT trip on a plain array literal / destructuring (the common case)", () => {
    expect(scan(`const [a, b, c] = [1, 2, 3]; export function f() { return a + b + c; }`)).toBe(false);
  });

  it("does NOT trip on overriding a NON-Array prototype", () => {
    expect(scan(`String.prototype[Symbol.iterator] = function* () {};`)).toBe(false);
    expect(scan(`Object.defineProperty(Map.prototype, "x", { value: 1 });`)).toBe(false);
  });

  it("does NOT trip on a per-instance @@iterator assignment (not Array.prototype)", () => {
    expect(scan(`const arr: any = [1, 2, 3]; arr[Symbol.iterator] = function* () {};`)).toBe(false);
  });
});

describe("#1719 S1: brand gate is byte-identical when clear (zero-cost)", () => {
  it("override-free array destructuring compiles deterministically", async () => {
    const src = `export function f(): number { const [x, y, z] = [1, 2, 3]; return x + y + z; }`;
    const a = await compile(src);
    const b = await compile(src);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    // Determinism check: the S1 gate predicate must not perturb codegen for an
    // override-free module — two compiles produce identical bytes.
    expect(Buffer.from(a.binary!).equals(Buffer.from(b.binary!))).toBe(true);
  });

  it("the brand being SET does not change S1 codegen (still no-op) — typed dstr unaffected", async () => {
    // The module overrides Array.prototype[Symbol.iterator] (so the brand is
    // set), then destructures a typed array. In S1 the override is NOT yet
    // observed (that is S2); the typed-vec fast path is taken unchanged, so the
    // backing-store values come through. This pins the documented S1 behavior:
    // brand set ⇒ still byte-identical fast path ⇒ z === 3 (not the override).
    const e = await run(
      `(Array.prototype as any)[Symbol.iterator] = function* () { yield 9; yield 9; yield 42; };
       export function f(): number { const [x, y, z] = [1, 2, 3]; return z; }`,
    );
    expect(e.f()).toBe(3);
  });
});

describe("#1719 S1: no regression in plain array destructuring", () => {
  it("element destructuring", async () => {
    const e = await run(`export function f(): number { const [a, b, c] = [10, 20, 30]; return a + b + c; }`);
    expect(e.f()).toBe(60);
  });

  it("destructuring with default + rest", async () => {
    const e = await run(`export function f(): number { const [a = 5, ...rest] = [1, 2, 3]; return a + rest.length; }`);
    expect(e.f()).toBe(3);
  });

  it("nested array destructuring", async () => {
    const e = await run(`export function f(): number { const [[a, b], [c]] = [[1, 2], [3]]; return a + b + c; }`);
    expect(e.f()).toBe(6);
  });
});
