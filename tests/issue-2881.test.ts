import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2881 — `Number.isInteger` / `isFinite` / `isNaN` / `isSafeInteger` must
// return `false` for a non-Number argument WITHOUT coercion (ES §21.1.2.x).
// Booleans (i32 rep) and undefined/null/void (f64 NaN rep) and symbols were
// wrongly taking the "static number" coercion path. (test262
// Number/{isInteger,isFinite,isNaN,isSafeInteger}/arg-is-not-number.js.)
describe("#2881 — Number.is* predicates: non-Number argument is false", () => {
  async function run(src: string): Promise<number> {
    const result = await compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) throw new Error("compile failed: " + (result.error ?? "unknown"));
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    return (instance.exports as any).test();
  }

  it("isInteger: booleans, undefined, null, symbol, string ⇒ false; numbers unchanged", async () => {
    const src = `
      export function test(): number {
        let m = 0;
        if (Number.isInteger(false) !== false) m = m + 1;
        if (Number.isInteger(true) !== false) m = m + 2;
        if (Number.isInteger(undefined as any) !== false) m = m + 4;
        if (Number.isInteger(null as any) !== false) m = m + 8;
        if (Number.isInteger(Symbol("x")) !== false) m = m + 16;
        if (Number.isInteger("1" as any) !== false) m = m + 32;
        if (Number.isInteger() !== false) m = m + 64;        // no arg
        if (Number.isInteger(5) !== true) m = m + 128;       // real number unchanged
        if (Number.isInteger(5.5) !== false) m = m + 256;    // non-integer number
        return m === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("isNaN: non-Number args are false even when they would coerce to NaN", async () => {
    const src = `
      export function test(): number {
        let m = 0;
        // undefined coerces to NaN; spec says isNaN(undefined) is false (not a Number).
        if (Number.isNaN(undefined as any) !== false) m = m + 1;
        if (Number.isNaN(false) !== false) m = m + 2;
        if (Number.isNaN(Symbol("x")) !== false) m = m + 4;
        if (Number.isNaN() !== false) m = m + 8;             // no arg
        if (Number.isNaN(NaN) !== true) m = m + 16;          // genuine NaN
        if (Number.isNaN(3) !== false) m = m + 32;           // genuine number
        return m === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("isFinite / isSafeInteger: booleans and symbols are false", async () => {
    const src = `
      export function test(): number {
        let m = 0;
        if (Number.isFinite(false) !== false) m = m + 1;
        if (Number.isFinite(true) !== false) m = m + 2;
        if (Number.isFinite(Symbol("x")) !== false) m = m + 4;
        if (Number.isFinite() !== false) m = m + 8;
        if (Number.isFinite(42) !== true) m = m + 16;        // genuine finite number
        if (Number.isSafeInteger(true) !== false) m = m + 32;
        if (Number.isSafeInteger(Symbol("x")) !== false) m = m + 64;
        if (Number.isSafeInteger() !== false) m = m + 128;
        if (Number.isSafeInteger(9) !== true) m = m + 256;   // genuine safe integer
        return m === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
