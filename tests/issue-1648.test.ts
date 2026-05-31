// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors.map((e) => e.message).join(" | ")}`);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports.test as () => unknown)();
}

describe("#1648 — Object.create descriptor ToBoolean fidelity", () => {
  it("configurable: 123 (truthy number) makes property deletable", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { configurable: 123 as any } });
        const before = Object.prototype.hasOwnProperty.call(o, 'p');
        delete o.p;
        const after = Object.prototype.hasOwnProperty.call(o, 'p');
        return (before ? 10 : 0) + (after ? 1 : 0);
      }
    `);
    expect(result).toBe(10);
  });

  it("configurable: 'x' (truthy string) makes property deletable", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { configurable: 'x' as any } });
        delete o.p;
        return Object.prototype.hasOwnProperty.call(o, 'p') ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("configurable: {} (object — always truthy) makes property deletable", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { configurable: {} as any } });
        delete o.p;
        return Object.prototype.hasOwnProperty.call(o, 'p') ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("configurable: 0 (falsy number) leaves property non-deletable", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { configurable: 0 as any } });
        try { delete o.p; } catch {}
        return Object.prototype.hasOwnProperty.call(o, 'p') ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("configurable: true (control — literal truthy) makes property deletable", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { configurable: true } });
        delete o.p;
        return Object.prototype.hasOwnProperty.call(o, 'p') ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("enumerable: '' (falsy string) hides property from for-in", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { value: 7, enumerable: '' as any } });
        let count = 0;
        for (const k in o) count++;
        return count;
      }
    `);
    expect(result).toBe(0);
  });

  it("writable: 1 (truthy number) lets property be reassigned", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { value: 5, writable: 1 as any } });
        o.p = 99;
        return o.p;
      }
    `);
    expect(result).toBe(99);
  });

  it("control: configurable: true still works (no regression on literal-true)", async () => {
    const result = await run(`
      export function test(): number {
        const o: any = Object.create({}, { p: { value: 42, configurable: true, writable: true } });
        return o.p;
      }
    `);
    expect(result).toBe(42);
  });
});
