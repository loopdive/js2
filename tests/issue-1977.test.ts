// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1977 — linear backend: Array.push past capacity silently corrupted
// adjacent heap objects (no growth path), arr[idx] stores beyond length
// neither extended nor bounds-checked, and OOB reads returned raw
// neighbouring memory.
//
// The fix adds __arr_grow (double capacity, relocate, leave a forwarding
// record in the old header) plus forwarding resolution and bounds/length
// semantics in __arr_push / __arr_get / __arr_set / __arr_len.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source, { target: "linear" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, { env: {} });
  return (instance.exports as any)[fn]();
}

describe("#1977 — linear array growth and bounds", () => {
  it("push past capacity does not corrupt the neighbouring allocation", async () => {
    const out = await run(`
      export function test(): number {
        const a = [1];
        const b = [100, 200, 300];
        for (let i = 0; i < 20; i++) a.push(0);
        return b[0] + b[1] + b[2];
      }
    `);
    expect(out).toBe(600);
  });

  it("pushed values survive relocation", async () => {
    const out = await run(`
      export function test(): number {
        const a = [7];
        for (let i = 1; i <= 30; i++) a.push(i);
        return a[0] + a[1] + a[30] + a.length;
      }
    `);
    expect(out).toBe(7 + 1 + 30 + 31);
  });

  it("aliases observe growth through the forwarding record", async () => {
    const out = await run(`
      export function test(): number {
        const a = [1];
        const b = a;
        for (let i = 0; i < 20; i++) a.push(i);
        return b.length + b[20];
      }
    `);
    expect(out).toBe(21 + 19);
  });

  it("store beyond length extends the array (a[5] = 9 → length 6)", async () => {
    const out = await run(`
      export function test(): number {
        const a = [1];
        a[5] = 9;
        return a.length * 100 + a[5];
      }
    `);
    expect(out).toBe(609);
  });

  it("the gap created by store-beyond-length reads as undefined (0)", async () => {
    const out = await run(`
      export function test(): number {
        const a = [1];
        a[5] = 9;
        return a[2];
      }
    `);
    expect(out).toBe(0);
  });

  it("out-of-bounds and negative reads yield the undefined sentinel", async () => {
    const out = await run(`
      export function test(): number {
        const a = [1, 2, 3];
        return a[10] + a[-1];
      }
    `);
    expect(out).toBe(0);
  });

  it("stress: 1000 pushes with interleaved allocations stay consistent", async () => {
    const out = await run(`
      export function test(): number {
        const a = [0];
        const guards: number[][] = [];
        for (let i = 1; i < 1000; i++) {
          a.push(i);
          if (i % 50 === 0) guards.push([i, i * 2, i * 3]);
        }
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += a[i];
        let g = 0;
        for (let i = 0; i < guards.length; i++) g += guards[i][0] + guards[i][1] + guards[i][2];
        return sum * 1000000 + g;
      }
    `);
    // sum(0..999) = 499500; guards: 6 * (50+100+...+950) = 57000
    expect(out).toBe(499500 * 1000000 + 57000);
  });

  it("in-capacity behaviour unregressed (literal init, set, get, len)", async () => {
    const out = await run(`
      export function test(): number {
        const a = [10, 20, 30];
        a[1] = 21;
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i];
        return s;
      }
    `);
    expect(out).toBe(61);
  });
});
