import { describe, it, expect } from "vitest";
import { compileToWasmBoundaryPair, evaluateAsJs } from "./helpers.js";

describe("Symbol typeof and uniqueness", () => {
  it("typeof Symbol() returns 'symbol'", async () => {
    const source = `
      export function test(): boolean {
        const s = Symbol();
        return typeof s === "symbol";
      }
    `;
    const pair = await compileToWasmBoundaryPair(source);
    const exports = pair.raw;
    expect(exports.test()).toBe(1); // i32 boolean: 1 = true
    const reference = evaluateAsJs(source).test();
    expect(typeof reference).toBe("boolean");
    expect(reference).toBe(true);
    expect(pair.compiled.exportSignatures?.test?.result).toBe("boolean");
    const jsExports = await pair.instantiateJsFacing();
    expect(jsExports.test()).toBe(reference);
  });

  it("typeof Symbol('desc') returns 'symbol'", async () => {
    const source = `
      export function test(): boolean {
        const s = Symbol("test");
        return typeof s === "symbol";
      }
    `;
    const pair = await compileToWasmBoundaryPair(source);
    const exports = pair.raw;
    expect(exports.test()).toBe(1);
    const reference = evaluateAsJs(source).test();
    expect(typeof reference).toBe("boolean");
    expect(reference).toBe(true);
    expect(pair.compiled.exportSignatures?.test?.result).toBe("boolean");
    const jsExports = await pair.instantiateJsFacing();
    expect(jsExports.test()).toBe(reference);
  });

  it("Symbol() creates unique values", async () => {
    const source = `
      export function test(): boolean {
        const s1 = Symbol();
        const s2 = Symbol();
        return s1 !== s2;
      }
    `;
    const pair = await compileToWasmBoundaryPair(source);
    const exports = pair.raw;
    expect(exports.test()).toBe(1);
    const reference = evaluateAsJs(source).test();
    expect(typeof reference).toBe("boolean");
    expect(reference).toBe(true);
    expect(pair.compiled.exportSignatures?.test?.result).toBe("boolean");
    const jsExports = await pair.instantiateJsFacing();
    expect(jsExports.test()).toBe(reference);
  });

  it("same Symbol is identical to itself", async () => {
    const source = `
      export function test(): boolean {
        const s = Symbol();
        return s === s;
      }
    `;
    const pair = await compileToWasmBoundaryPair(source);
    const exports = pair.raw;
    expect(exports.test()).toBe(1);
    const reference = evaluateAsJs(source).test();
    expect(typeof reference).toBe("boolean");
    expect(reference).toBe(true);
    expect(pair.compiled.exportSignatures?.test?.result).toBe("boolean");
    const jsExports = await pair.instantiateJsFacing();
    expect(jsExports.test()).toBe(reference);
  });

  it("Symbol with same description are still unique", async () => {
    const source = `
      export function test(): boolean {
        const s1 = Symbol("x");
        const s2 = Symbol("x");
        return s1 !== s2;
      }
    `;
    const pair = await compileToWasmBoundaryPair(source);
    const exports = pair.raw;
    expect(exports.test()).toBe(1);
    const reference = evaluateAsJs(source).test();
    expect(typeof reference).toBe("boolean");
    expect(reference).toBe(true);
    expect(pair.compiled.exportSignatures?.test?.result).toBe("boolean");
    const jsExports = await pair.instantiateJsFacing();
    expect(jsExports.test()).toBe(reference);
  });
});
