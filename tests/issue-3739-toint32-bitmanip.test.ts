// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3739 — ToInt32 (used by every bitwise op and the `|0`/`^0` fast path)
// used a float-based modulo-reduction (f64.div/f64.floor/f64.mul/f64.sub) to
// wrap values into the i32 range. A handwritten-Wasm bisection found V8 never
// tiers this up to its optimizing compiler in a tight loop — stuck at
// baseline speed indefinitely, ~12x slower than an equivalent pure-f64 loop
// with no floor at all (the landing-page `loop.ts` benchmark's catastrophic
// wasm-vs-js ratio). Replaced with IEEE-754 bit decomposition (sign/exponent/
// significand shifting), matching how native JS engines implement it in C++
// — avoids f64.floor entirely. Two independent call sites needed the fix:
// `emitToInt32` (src/codegen/binary-ops.ts, the legacy AST-direct path) and
// `emitJsToInt32`'s fast branch (src/ir/lower.ts, WasmGC/linear only — the
// Porffor backend keeps the old portable algorithm, see that function's
// comment for why). This file exercises both entry points.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileAndRunBuildImports as compileAndRun } from "./helpers/compile.js";

async function wat(src: string): Promise<string> {
  const r = await compile(src, { skipSemanticDiagnostics: true, emitWat: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r.wat;
}

const EDGE_CASES = [
  0,
  -0,
  1,
  -1,
  1.5,
  -1.5,
  1.9,
  -1.9,
  0.5,
  -0.5,
  0.4,
  -0.4,
  2147483647,
  2147483648,
  -2147483648,
  -2147483649,
  4294967295,
  4294967296,
  4294967297,
  -4294967295,
  -4294967296,
  8589934591,
  8589934592,
  8589934593,
  NaN,
  Infinity,
  -Infinity,
  1e300,
  -1e300,
  1e21,
  -1e21,
  5e-10,
  -5e-10,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  -Number.MIN_VALUE, // smallest denormal
  2 ** 32 + 5,
  2 ** 32 - 5,
  -(2 ** 32) + 5,
  -(2 ** 32) - 5,
  2 ** 31,
  2 ** 31 - 1,
  -(2 ** 31),
  -(2 ** 31) - 1,
  0.9999999999,
  -0.9999999999,
  123456789.98765433,
  1073741824.5,
];

describe("#3739 — bit-manipulation ToInt32 correctness", () => {
  it("compiled `x | 0` uses the bit-manipulation path (no f64.floor at all)", async () => {
    const w = await wat(`export function run(x: number): number { return x | 0; }`);
    expect(w).toContain("i64.reinterpret_f64");
    expect(w).not.toContain("f64.floor");
    expect(w).not.toContain("f64.div");
  });

  it("`x | 0` matches native ToInt32 for all edge cases", async () => {
    const e = await compileAndRun(`export function run(x: number): number { return x | 0; }`);
    for (const c of EDGE_CASES) {
      expect(e.run(c), `ToInt32(${c})`).toBe(c | 0);
    }
  });

  it("general (non-fast-path) bitwise ops still coerce both operands correctly", async () => {
    const e = await compileAndRun(`
      export function band(a: number, b: number): number { return a & b; }
      export function bshl(a: number, b: number): number { return a << b; }
      export function bshrS(a: number, b: number): number { return a >> b; }
      export function bshrU(a: number, b: number): number { return a >>> b; }
    `);
    for (const a of EDGE_CASES) {
      for (const b of [0, 1, 2, 31, 32, -1, 5.9, NaN, Infinity]) {
        expect(e.band(a, b), `${a} & ${b}`).toBe(a & b);
        expect(e.bshl(a, b), `${a} << ${b}`).toBe(a << b);
        expect(e.bshrS(a, b), `${a} >> ${b}`).toBe(a >> b);
        expect(e.bshrU(a, b), `${a} >>> ${b}`).toBe(a >>> b);
      }
    }
  });

  it("fuzz: random magnitudes and exponent ranges match native ToInt32 (2000 cases)", async () => {
    const e = await compileAndRun(`export function run(x: number): number { return x | 0; }`);
    for (let i = 0; i < 2000; i++) {
      const kind = Math.random();
      let v: number;
      if (kind < 0.3) v = (Math.random() - 0.5) * 2 ** (Math.random() * 100);
      else if (kind < 0.6) v = Math.floor((Math.random() - 0.5) * 2 ** 34);
      else v = (Math.random() - 0.5) * 20;
      expect(e.run(v), `ToInt32(${v})`).toBe(v | 0);
    }
  });

  it("tight accumulator loop matches JS semantics exactly (mirrors the loop.ts landing-page benchmark)", async () => {
    const e = await compileAndRun(`
      export function run(): number {
        let s = 0;
        for (let i = 0; i < 1000000; i++) s = (s + i) | 0;
        return s;
      }
    `);
    let expected = 0;
    for (let i = 0; i < 1000000; i++) expected = (expected + i) | 0;
    expect(e.run()).toBe(expected);
  });
});
