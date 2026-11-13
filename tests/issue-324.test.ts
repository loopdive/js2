import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports as buildHostImports } from "../src/runtime.js";

// (#7029) This file used to hand-roll the host `env`, listing only the imports
// its programs needed when it was written. The JS-host lane has since grown
// real-semantics imports for the same programs (`__register_prototype` for
// every class, 5ff86e89f5 #5347; real `TypeError` instances via
// `__new_TypeError`, #3287; `__get_undefined`, `__call_function_N`, ...), and
// each one turned a passing test into an instantiate-time LinkError. Link
// against the production resolver instead: it is the import contract the
// compiler actually emits against.
function buildImports(result: CompileResult) {
  return buildHostImports(result.imports, undefined, result.stringPool);
}

async function compileToWasm(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("Issue #324: Runtime test failures (wrong return values)", () => {
  // Missing Math constants: SQRT1_2, LOG2E, LOG10E
  it("Math.SQRT1_2 returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.SQRT1_2;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("Math.LOG2E returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.LOG2E;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.LOG2E, 10);
  });

  it("Math.LOG10E returns correct value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.LOG10E;
      }
    `);
    expect(exports.test()).toBeCloseTo(Math.LOG10E, 10);
  });

  // Math.min/max must not skip evaluation of arguments when one is NaN
  it("Math.min with NaN still evaluates all args", async () => {
    const exports = await compileToWasm(`
      let calls = 0;
      function countAndReturn(x: number): number {
        calls++;
        return x;
      }
      export function test(): number {
        calls = 0;
        Math.min(NaN, countAndReturn(5));
        return calls;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.max with NaN still evaluates all args", async () => {
    const exports = await compileToWasm(`
      let calls = 0;
      function countAndReturn(x: number): number {
        calls++;
        return x;
      }
      export function test(): number {
        calls = 0;
        Math.max(NaN, countAndReturn(5));
        return calls;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Math.min/max with 0 args
  it("Math.min() with no args returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.min();
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.max() with no args returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.max();
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  // Math.min/max basic NaN propagation
  it("Math.min(NaN, 5) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.min(NaN, 5);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("Math.max(NaN, 5) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.max(NaN, 5);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.min/max with negative zero
  it("Math.min(0, -0) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.min(0, -0);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.max(-0, 0) returns +0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.max(-0, 0);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  // Math.pow edge cases
  it("Math.pow with NaN exponent returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(2, NaN);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  it("Math.pow(1, NaN) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(1, NaN);
      }
    `);
    // Per spec, Math.pow(1, NaN) should be NaN
    expect(exports.test()).toBeNaN();
  });

  // Math.atanh edge cases
  it("Math.atanh(-1) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(-1);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.atanh(1) returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(1);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.atanh(2) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.atanh(2);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.expm1 edge cases
  it("Math.expm1(-Infinity) returns -1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.expm1(-Infinity);
      }
    `);
    expect(exports.test()).toBe(-1);
  });

  it("Math.expm1(Infinity) returns Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.expm1(Infinity);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  // Math.log2 basic cases
  it("Math.log2(1) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(1);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("Math.log2(8) returns 3", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(8);
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("Math.log2(-1) returns NaN", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log2(-1);
      }
    `);
    expect(exports.test()).toBeNaN();
  });

  // Math.log10 basic cases
  it("Math.log10(1) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(1);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  it("Math.log10(100) returns 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(100);
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Basic addition sanity check
  it("1 + 1 === 2", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 + 1;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  it("variable addition works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x = 1;
        let y = 1;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(2);
  });

  // Math.sign
  it("Math.sign works for positive numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(5);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.sign works for negative numbers", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(-5);
      }
    `);
    expect(exports.test()).toBe(-1);
  });

  it("Math.sign(0) returns 0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.sign(0);
      }
    `);
    expect(exports.test()).toBe(0);
  });

  // Math.pow edge cases for -Infinity base
  it("Math.pow(-Infinity, 1) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 1);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.pow(-Infinity, 3) returns -Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 3);
      }
    `);
    expect(exports.test()).toBe(-Infinity);
  });

  it("Math.pow(-Infinity, 2) returns +Infinity", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(-Infinity, 2);
      }
    `);
    expect(exports.test()).toBe(Infinity);
  });

  it("Math.pow(-Infinity, -1) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-Infinity, -1);
      }
    `);
    expect(exports.test()).toBe(-Infinity); // 1/(-0) = -Infinity
  });

  // Math.pow edge cases for -0 base
  it("Math.pow(-0, 3) returns -0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-0, 3);
      }
    `);
    expect(exports.test()).toBe(-Infinity); // 1/(-0) = -Infinity
  });

  it("Math.pow(-0, 2) returns +0", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return 1 / Math.pow(-0, 2);
      }
    `);
    expect(exports.test()).toBe(Infinity); // 1/(+0) = +Infinity
  });

  // Math.pow(NaN, 0) returns 1
  it("Math.pow(NaN, 0) returns 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.pow(NaN, 0);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  // Math.log10 exact values
  it("Math.log10(10) returns exactly 1", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(10);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("Math.log10(1000) returns exactly 3", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return Math.log10(1000);
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
