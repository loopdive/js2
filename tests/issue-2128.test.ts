// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2128 — object-literal `set` accessors silently no-op'd in three ways:
//  (a) top-level writes run during the wasm START function, before
//      setExports wires the instance — the host __cb_N bridge returned
//      undefined; now parked via deferToExports and replayed at wiring.
//  (b) a setter's mutable captures live in ref cells synced back to outer
//      locals only after CallExpressions — property writes/reads (which
//      lower to internal __extern_set/__extern_get calls) never re-synced;
//      now they do.
//  (c) a get/set pair capturing the same function-local each snapshotted
//      its OWN cell, so the getter never saw the setter's writes; accessors
//      of one literal now share a single cell per captured local.

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

describe("#2128 — object-literal setter invocation", () => {
  it("issue repro: top-level write through the setter is observed", async () => {
    const out = await run(`
      let captured = 0;
      const o: any = { set v(x: number) { captured = x; } };
      o.v = 9;
      export function test(): number { return captured; }
    `);
    expect(out).toBe(9);
  });

  it("setter writing a function-local capture is observed after the write", async () => {
    const out = await run(`
      export function test(): number {
        let captured = 0;
        const o: any = { set v(x: number) { captured = x; } };
        o.v = 9;
        return captured;
      }
    `);
    expect(out).toBe(9);
  });

  it("get/set pair shares the captured local: set fires on write, get on read", async () => {
    const out = await run(`
      export function test(): number {
        let backing = 0;
        const o: any = {
          get v(): number { return backing + 1; },
          set v(x: number) { backing = x * 2; }
        };
        o.v = 5;
        return o.v;
      }
    `);
    expect(out).toBe(11);
  });

  it("getter side effect on a captured local is observed after the read", async () => {
    const out = await run(`
      export function test(): number {
        let count = 0;
        const o: any = { get v(): number { count++; return 42; } };
        const val = o.v;
        return count * 100 + val;
      }
    `);
    expect(out).toBe(142);
  });

  it("setter with module-level backing fires on write (in-function literal)", async () => {
    const out = await run(`
      let backing = 0;
      export function test(): number {
        const o: any = {
          get v(): number { return backing + 1; },
          set v(x: number) { backing = x * 2; }
        };
        o.v = 5;
        return backing * 100 + o.v;
      }
    `);
    expect(out).toBe(1011);
  });

  it("plain data-property writes are unregressed", async () => {
    const out = await run(`
      export function test(): number {
        const o = { v: 1 };
        o.v = 9;
        return o.v;
      }
    `);
    expect(out).toBe(9);
  });

  it("one-shot callbacks with mutable captures are unregressed", async () => {
    const out = await run(`
      export function test(): number {
        let sum = 0;
        const arr = [1, 2, 3];
        arr.forEach((x: number) => { sum += x; });
        return sum;
      }
    `);
    expect(out).toBe(6);
  });
});
