// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1437 — Math numeric edge cases beyond the random source.
//
// Three spec gaps in the pure-Wasm Math helpers (`src/codegen/math-helpers.ts`):
//
//   1. §21.3.2.26 Math.pow(±1, ±Infinity) — must return NaN. Pre-fix the
//      `base == 1 → 1` short-circuit fired BEFORE the abs/Infinity check, so
//      `pow(1, Infinity)` returned 1 and `pow(-1, Infinity)` could collapse
//      to NaN only by accident (via the base<0 branch). Fix: add an explicit
//      "abs(base) == 1 AND abs(exp) == +Infinity → NaN" guard right after
//      the NaN propagation checks.
//
//   2. §21.3.2.31 Math.sinh(±0) — must preserve sign of zero. Pre-fix
//      `(exp(0) - 1/exp(0)) / 2` always produced +0, dropping the sign of
//      -0. Fix: early-return `x` when `x == 0` so the IEEE-754 sign bit
//      survives.
//
//   3. §21.3.2.34 Math.tanh(±0) — same sign-of-zero issue, same fix shape.
//
// Backing test262 cases:
//   built-ins/Math/pow/applying-the-exp-operator_A7.js  (pow(±1, +Inf))
//   built-ins/Math/pow/applying-the-exp-operator_A8.js  (pow(±1, -Inf))
//   built-ins/Math/sinh/sinh-specialVals.js
//   built-ins/Math/tanh/tanh-specialVals.js

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1437 — Math numeric edge cases (pow ±1/±Inf, sinh/tanh ±0)", () => {
  it("Math.pow(1, +Infinity) → NaN  (§21.3.2.26)", async () => {
    const source = `
      export function test(): number {
        const r = Math.pow(1, Infinity);
        return isNaN(r) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.pow(1, -Infinity) → NaN", async () => {
    const source = `
      export function test(): number {
        const r = Math.pow(1, -Infinity);
        return isNaN(r) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.pow(-1, +Infinity) → NaN", async () => {
    const source = `
      export function test(): number {
        const r = Math.pow(-1, Infinity);
        return isNaN(r) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.pow(-1, -Infinity) → NaN", async () => {
    const source = `
      export function test(): number {
        const r = Math.pow(-1, -Infinity);
        return isNaN(r) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.pow short-circuits remain correct (pow(2, 10) === 1024)", async () => {
    // Regression guard — the NaN guard must not eat normal pow(±1, finite).
    const source = `
      export function test(): number {
        return Math.pow(2, 10);
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1024);
  });

  it("Math.pow(1, 5) === 1 (finite exp still short-circuits)", async () => {
    const source = `
      export function test(): number {
        return Math.pow(1, 5);
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.pow(NaN, 0) === 1 (exp==0 short-circuit precedes NaN check)", async () => {
    const source = `
      export function test(): number {
        return Math.pow(NaN, 0);
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh(NaN) → NaN", async () => {
    const source = `
      export function test(): number {
        return isNaN(Math.sinh(NaN)) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh(+Infinity) → +Infinity", async () => {
    const source = `
      export function test(): number {
        const r = Math.sinh(Infinity);
        return r === Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh(-Infinity) → -Infinity", async () => {
    const source = `
      export function test(): number {
        const r = Math.sinh(-Infinity);
        return r === -Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh(+0) → +0  (1/sinh(+0) === +Infinity)", async () => {
    const source = `
      export function test(): number {
        // Object.is(x, +0) ⇔ 1/x === +Infinity (and not -Infinity)
        return 1 / Math.sinh(0) === Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh(-0) → -0  (1/sinh(-0) === -Infinity)", async () => {
    const source = `
      export function test(): number {
        return 1 / Math.sinh(-0) === -Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh(NaN) → NaN", async () => {
    const source = `
      export function test(): number {
        return isNaN(Math.tanh(NaN)) ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh(+Infinity) → 1", async () => {
    const source = `
      export function test(): number {
        return Math.tanh(Infinity) === 1 ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh(-Infinity) → -1", async () => {
    const source = `
      export function test(): number {
        return Math.tanh(-Infinity) === -1 ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh(+0) → +0", async () => {
    const source = `
      export function test(): number {
        return 1 / Math.tanh(0) === Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh(-0) → -0", async () => {
    const source = `
      export function test(): number {
        return 1 / Math.tanh(-0) === -Infinity ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.tanh stays accurate for moderate input (tanh(1) ≈ 0.7615…)", async () => {
    // Regression guard — the ±0 early-return must not interfere with
    // the polynomial path for non-zero inputs.
    const source = `
      export function test(): number {
        const r = Math.tanh(1);
        // tanh(1) ≈ 0.7615941559557649
        return r > 0.76 && r < 0.77 ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });

  it("Math.sinh stays accurate for moderate input (sinh(1) ≈ 1.1752…)", async () => {
    const source = `
      export function test(): number {
        const r = Math.sinh(1);
        return r > 1.17 && r < 1.18 ? 1 : 0;
      }
    `;
    const exports = await compileAndInstantiate(source);
    expect(exports.test!()).toBe(1);
  });
});
