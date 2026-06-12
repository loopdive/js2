// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2129 — duplicate object-literal keys resolved first-wins and silently
// skipped the later initializer. Per ES §13.2.5.5 every PropertyDefinition
// runs in order and a later same-key definition overwrites the earlier one:
// the LAST value wins, and all initializer side effects occur. The struct
// literal path now binds each field to the last matching property and
// evaluates (then drops) the earlier duplicates' initializers.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports as any)[fn]();
}

describe("#2129 — duplicate object-literal keys: last definition wins", () => {
  it("({ a: 1, a: 2 }).a is 2", async () => {
    const out = await run(`
      export function test(): number {
        const o = { a: 1, a: 2 } as any;
        return o.a;
      }
    `);
    expect(out).toBe(2);
  });

  it("({ a: 1, b: 9, a: 3 }) — a is 3, b untouched", async () => {
    const out = await run(`
      export function test(): number {
        const o = { a: 1, b: 9, a: 3 } as any;
        return o.a * 10 + o.b;
      }
    `);
    expect(out).toBe(39);
  });

  it("all duplicate initializers run for their side effects", async () => {
    const out = await run(`
      let log = 0;
      const f1 = (): number => { log = log * 10 + 1; return 100; };
      const f2 = (): number => { log = log * 10 + 2; return 200; };
      export function test(): number {
        const o = { a: f1(), a: f2() } as any;
        return log * 1000 + o.a;
      }
    `);
    expect(out).toBe(12200);
  });

  it("shorthand after data property wins", async () => {
    const out = await run(`
      export function test(): number {
        const a = 7;
        const o = { a: 1, a } as any;
        return o.a;
      }
    `);
    expect(out).toBe(7);
  });

  it("data property after shorthand wins", async () => {
    const out = await run(`
      export function test(): number {
        const a = 7;
        const o = { a, a: 1 } as any;
        return o.a;
      }
    `);
    expect(out).toBe(1);
  });

  it("non-duplicate literals are unregressed", async () => {
    const out = await run(`
      export function test(): number {
        const o = { x: 4, y: 5, z: 6 };
        return o.x + o.y + o.z;
      }
    `);
    expect(out).toBe(15);
  });

  it("method shorthand literals are unregressed", async () => {
    const out = await run(`
      export function test(): number {
        const o = { m(): number { return 8; }, v: 1 } as any;
        return o.m() + o.v;
      }
    `);
    expect(out).toBe(9);
  });
});
