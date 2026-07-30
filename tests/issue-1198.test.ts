// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1198 — Pre-size dense arrays at allocation site
// Tests both the matching and non-matching cases per the issue's acceptance criteria.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string, exportName: string, args: number[] = []): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  const fn = (instance.exports as any)[exportName] as (...a: number[]) => number;
  if (typeof fn !== "function") throw new Error(`missing export ${exportName}`);
  return fn(...args);
}

describe("#1198 pre-size dense arrays — matching patterns", () => {
  it("fuses a pure dense fill followed by an i32 sum reduction", async () => {
    const src = `
      export function run(n: number): number {
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
        }
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          sum = (sum + values[i]) | 0;
        }
        return sum | 0;
      }
    `;
    const compiled = await compile(src, { fileName: "array-sum.ts", emitWat: true });
    expect(compiled.success, compiled.errors?.[0]?.message).toBe(true);
    expect(compiled.irCompiledFuncs ?? [], JSON.stringify(compiled.irOutcomes)).toContain("run");
    expect(compiled.wat).not.toContain("$__vec_new_sized_");
    expect(compiled.wat).not.toContain("$__vec_elem_set_");

    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const { instance } = await WebAssembly.instantiate(compiled.binary, imports as any);
    const run = instance.exports.run as (n: number) => number;
    expect(run(2000)).toBe(1_018_392);
    expect(run(0)).toBe(0);
    expect(run(-1)).toBe(0);
    expect(run(2.5)).toBe(51);
  });

  it("keeps allocation-site presizing and direct stores when the array remains observable", async () => {
    const src = `
      export function run(n: number): number {
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
        }
        return values.length;
      }
    `;
    const compiled = await compile(src, { fileName: "array-fill-length.ts", emitWat: true });
    expect(compiled.success, compiled.errors?.[0]?.message).toBe(true);
    expect(compiled.irCompiledFuncs ?? [], JSON.stringify(compiled.irOutcomes)).toContain("run");
    expect(compiled.wat).toContain("$__vec_new_sized_");
    expect(compiled.wat).not.toContain("$__vec_elem_set_");

    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const { instance } = await WebAssembly.instantiate(compiled.binary, imports as any);
    const run = instance.exports.run as (n: number) => number;
    expect(run(2000)).toBe(2000);
    expect(run(0)).toBe(0);
    expect(run(-1)).toBe(0);
    expect(run(2.5)).toBe(3);
  });

  it("keeps the fused run body when a legacy timing wrapper calls it", async () => {
    const src = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        const values = [];
        for (let i = 0; i < n; i++) values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
        let sum = 0;
        for (let i = 0; i < values.length; i++) sum = (sum + values[i]) | 0;
        return sum | 0;
      }
      /** @param {number} n @returns {number} */
      export function warm(n) {
        const started = performance.now();
        const result = run(n);
        return result + performance.now() - started;
      }
    `;
    const compiled = await compile(src, {
      fileName: "array-sum-warm.js",
      emitWat: true,
      target: "wasi",
      nativeStrings: true,
      trackIrOutcomes: true,
    });
    expect(compiled.success, compiled.errors?.[0]?.message).toBe(true);
    expect(compiled.irCompiledFuncs ?? [], JSON.stringify(compiled.irOutcomes)).toContain("run");
  });

  it("keeps nested unsigned-shift bits native inside another bitwise operation", async () => {
    const src = `
      export function mix(x: number): number {
        return ((x >>> 0) ^ 0x12345678) | 0;
      }
    `;
    const compiled = await compile(src, { fileName: "nested-unsigned-shift.ts", emitWat: true });
    expect(compiled.success, compiled.errors?.[0]?.message).toBe(true);
    expect(compiled.wat).toContain("i32.shr_u");

    const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
    const { instance } = await WebAssembly.instantiate(compiled.binary, imports as any);
    const mix = instance.exports.mix as (x: number) => number;
    for (const x of [-1, -2147483648, 0, 2147483647]) {
      expect(mix(x)).toBe(((x >>> 0) ^ 0x12345678) | 0);
    }
  });

  it("literal-N counted index-assign: const a = []; for (let i = 0; i < 10; i++) a[i] = i*2;", async () => {
    const src = `
      export function run(): number {
        const a: number[] = [];
        for (let i = 0; i < 10; i++) a[i] = i * 2;
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum = sum + a[i];
        return sum;
      }
    `;
    // 0+2+4+...+18 = 90
    const result = await compileAndRun(src, "run");
    expect(result).toBe(90);
  });

  it("identifier-N counted index-assign: function param as bound", async () => {
    // Acceptance criterion #2: f(n) with parameter n must work.
    const src = `
      export function f(n: number): number {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a[i] = i * 2;
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum = sum + a[i];
        return sum;
      }
    `;
    const r = await compileAndRun(src, "f", [1000]);
    // sum 0..999 of (i*2) = 2 * (0+1+...+999) = 2 * (999*1000/2) = 999000
    expect(r).toBe(999000);
  });

  it("array-sum benchmark shape: bitwise + arithmetic RHS", async () => {
    // Mirrors benchmarks/competitive/programs/array-sum.js — the canonical case the
    // optimisation is targeted at. Exercises the same pattern shape and arithmetic.
    const src = `
      export function run(n: number): number {
        const values: number[] = [];
        for (let i = 0; i < n; i++) {
          values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
        }
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          sum = (sum + values[i]) | 0;
        }
        return sum | 0;
      }
    `;
    // Reference compute the expected sum for n=2000 (matching coldArg)
    let expected = 0;
    for (let i = 0; i < 2000; i++) {
      expected = (expected + (((i * 17) ^ (i >>> 3)) & 1023)) | 0;
    }
    const r = await compileAndRun(src, "run", [2000]);
    expect(r).toBe(expected);
  });

  it("post-loop length is N (matches grow-on-write semantics)", async () => {
    const src = `
      export function f(n: number): number {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a[i] = i;
        return a.length;
      }
    `;
    const r = await compileAndRun(src, "f", [50]);
    expect(r).toBe(50);
  });

  it("conditional/ternary RHS is allowed", async () => {
    const src = `
      export function f(n: number): number {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a[i] = i % 2 === 0 ? i : -i;
        let s = 0;
        for (let i = 0; i < a.length; i++) s = s + a[i];
        return s;
      }
    `;
    // n=10: a[0..9] = 0, -1, 2, -3, 4, -5, 6, -7, 8, -9 → sum = 0-1+2-3+4-5+6-7+8-9 = -5
    const r = await compileAndRun(src, "f", [10]);
    expect(r).toBe(-5);
  });

  it("loop with i += 1 incrementor", async () => {
    const src = `
      export function f(n: number): number {
        const a: number[] = [];
        for (let i = 0; i < n; i += 1) a[i] = i;
        let s = 0;
        for (let i = 0; i < a.length; i++) s = s + a[i];
        return s;
      }
    `;
    // sum 0..9 = 45
    const r = await compileAndRun(src, "f", [10]);
    expect(r).toBe(45);
  });

  it("zero-iteration case (n = 0) doesn't break", async () => {
    const src = `
      export function f(n: number): number {
        const a: number[] = [];
        for (let i = 0; i < n; i++) a[i] = i;
        return a.length;
      }
    `;
    const r = await compileAndRun(src, "f", [0]);
    expect(r).toBe(0);
  });
});

describe("#1198 pre-size dense arrays — non-matching patterns (must fall back to grow-on-write)", () => {
  it("body has push instead of [i] = (different pattern, push-detector handles it)", async () => {
    // Pattern: const a = []; for (let i = 0; i < N; i++) a.push(i);
    // This matches detectCountedPushLoopSize — should still pre-allocate, just via
    // the existing #1001 path. Verify it still works correctly.
    const src = `
      export function f(): number {
        const a: number[] = [];
        for (let i = 0; i < 5; i++) a.push(i + 1);
        let s = 0;
        for (let i = 0; i < a.length; i++) s = s + a[i];
        return s;
      }
    `;
    // 1+2+3+4+5 = 15
    const r = await compileAndRun(src, "f");
    expect(r).toBe(15);
  });

  it("body has multiple statements (reject — only single ExprStmt allowed)", async () => {
    const src = `
      export function f(): number {
        const a: number[] = [];
        let extra = 0;
        for (let i = 0; i < 5; i++) {
          a[i] = i;
          extra = extra + 1;
        }
        return a.length + extra;
      }
    `;
    // a.length = 5 (correct via grow-on-write), extra = 5
    const r = await compileAndRun(src, "f");
    expect(r).toBe(10);
  });

  it("loop var is not 0-based (reject — non-canonical shape)", async () => {
    const src = `
      export function f(): number {
        const a: number[] = [];
        for (let i = 1; i < 6; i++) a[i] = i;
        return a.length;
      }
    `;
    // Initializer is `let i = 1`, not `let i = 0`. Detector rejects. With grow-on-write,
    // a[1..5] are written. After write at index 5, length = 6 (since a[i] = ... extends
    // length to max(idx+1, current)). a[0] is hole (zero-initialized in WasmGC).
    const r = await compileAndRun(src, "f");
    expect(r).toBe(6);
  });

  it("RHS is element access (reject — could throw / not in allow-list)", async () => {
    // Element access is not in the conservative allow-list. Detector rejects, falls back
    // to grow-on-write. Result must still be correct.
    const src = `
      export function f(): number {
        const src: number[] = [10, 20, 30, 40, 50];
        const a: number[] = [];
        for (let i = 0; i < 5; i++) a[i] = src[i];
        let s = 0;
        for (let i = 0; i < a.length; i++) s = s + a[i];
        return s;
      }
    `;
    // 10+20+30+40+50 = 150
    const r = await compileAndRun(src, "f");
    expect(r).toBe(150);
  });

  it("RHS is function call (reject — could throw)", async () => {
    const src = `
      function double(x: number): number { return x * 2; }
      export function f(): number {
        const a: number[] = [];
        for (let i = 0; i < 5; i++) a[i] = double(i);
        let s = 0;
        for (let i = 0; i < a.length; i++) s = s + a[i];
        return s;
      }
    `;
    // 0+2+4+6+8 = 20
    const r = await compileAndRun(src, "f");
    expect(r).toBe(20);
  });
});
