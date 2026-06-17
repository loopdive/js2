// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1974 — the linear backend's `%` (PercentToken) arm used to be empty, so a
 * remainder expression left both operands on the stack and silently evaluated
 * to the divisor (`7 % 2` → `2`). #1937 filled the arm with `a - trunc(a/b)*b`.
 *
 * #2144 — that naive formula diverged from JS / the WasmGC backend on extreme
 * inputs (it produced `±Infinity` for ratios ≳ 1e308, `NaN` for `x % Infinity`,
 * and drifted/collapsed when the intermediate rounded). The arm now calls the
 * `__fmod` runtime helper (exact IEEE-754 remainder, shared algorithm with the
 * GC backend's #2056 work). The cases below lock both the basic behaviour
 * (#1974) and the extreme-input parity (#2144) for `target: "linear"`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLinear(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "test.ts", target: "linear" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#1974 linear backend modulo (%) is correct", () => {
  const cases: Array<[string, number]> = [
    ["7 % 2", 1],
    ["-7 % 2", -1], // sign follows the dividend
    ["7 % -2", 1],
    ["5.5 % 2", 1.5],
    ["10 % 3", 1],
    ["9 % 3", 0],
    ["1 % 5", 1],
  ];

  for (const [expr, want] of cases) {
    it(`${expr} === ${want}`, async () => {
      expect(await runLinear(`return ${expr};`)).toBe(want);
    });
  }

  it("% in a non-return position leaves no leftover stack value", async () => {
    // If the arm leaked operands, this multi-statement function would fail to
    // validate (or compute wrong). Both `%` results feed into the sum.
    expect(await runLinear(`const a = 7 % 3; const b = 8 % 5; return a + b;`)).toBe(1 + 3);
  });

  it("% as a loop-body subexpression validates and computes", async () => {
    expect(await runLinear(`let s = 0; for (let i = 0; i < 10; i++) { if (i % 3 === 0) s += i; } return s;`)).toBe(
      0 + 3 + 6 + 9,
    );
  });

  // #2144 — extreme-input parity with JS / the WasmGC backend. The naive
  // `a - trunc(a/b)*b` formula failed all of these (Inf / NaN / round-collapse);
  // `__fmod` returns the exact IEEE-754 remainder.
  describe("#2144 __fmod parity on extreme inputs", () => {
    // Runtime operands so the values aren't constant-folded before codegen.
    async function runMod(a: number, b: number): Promise<number> {
      const src = `export function test(a: number, b: number): number { return a % b; }`;
      const r = await compile(src, { fileName: "test.ts", target: "linear" });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      return (instance.exports as { test(a: number, b: number): number }).test(a, b);
    }

    const parity: Array<[number, number]> = [
      [1e308, 1e-308], // overflowed to ±Infinity under the naive formula
      [7, Infinity], // produced NaN (0*Inf) under the naive formula
      [1e16, 0.0001], // collapsed to 0 when trunc(a/b)*b rounded back to a
      [123456789.123, 0.001], // ULP drift / collapse
      [-7, 3], // sign of the dividend
      [7, -3],
      [5.5, 2],
      [10, 10],
    ];

    for (const [a, b] of parity) {
      it(`${a} % ${b} matches Node`, async () => {
        const got = await runMod(a, b);
        const want = a % b;
        if (Number.isNaN(want)) expect(Number.isNaN(got)).toBe(true);
        else expect(got).toBe(want);
      });
    }

    it("x % Infinity returns x (not NaN)", async () => {
      expect(await runMod(7, Infinity)).toBe(7);
    });

    it("x % 0 is NaN", async () => {
      expect(Number.isNaN(await runMod(5, 0))).toBe(true);
    });
  });
});
