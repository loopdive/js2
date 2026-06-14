// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2127 — `{ ...src }` where src has accessor-defined own properties dropped
// the property: the struct spread lowering copies data fields by layout and
// never invokes getters. Per spec CopyDataProperties, each own enumerable
// key gets a [[Get]] whose result is copied as a data property. Literals
// whose spread source type carries accessor-declared properties now route
// to the host plain-object path, whose __object_assign spread has exactly
// those Object.assign semantics.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function run(source: string, fn = "test"): Promise<unknown> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "<unknown>"}`);
  }
  const imports = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // Wire exports back so accessor callbacks (__cb_N bridges) can dispatch.
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports);
  return (instance.exports as any)[fn]();
}

describe("#2127 — spread of accessor-bearing sources", () => {
  it("getter value is copied as a data property", async () => {
    const out = await run(`
      export function test(): number {
        const src = { get a(): number { return 7; } };
        const o: any = { ...src };
        return o.a;
      }
    `);
    expect(out).toBe(7);
  });

  it("getter side effects fire exactly once during the spread", async () => {
    const out = await run(`
      let calls = 0;
      export function test(): number {
        const src = { get a(): number { calls++; return 7; } };
        const o: any = { ...src };
        return calls * 10 + o.a;
      }
    `);
    expect(out).toBe(17);
  });

  it("setter-only source property spreads as an undefined data property", async () => {
    const out = await run(`
      export function test(): number {
        let store = 0;
        const src = { set a(v: number) { store = v; } };
        const o: any = { ...src };
        return o.a === undefined ? 1 : 0;
      }
    `);
    expect(out).toBe(1);
  });

  it("getter mixed with data properties: all keys land", async () => {
    const out = await run(`
      export function test(): number {
        const src = { x: 1, get a(): number { return 7; } };
        const o: any = { ...src, y: 2 };
        return o.x * 100 + o.a * 10 + o.y;
      }
    `);
    expect(out).toBe(172);
  });

  it("data-property spread is unregressed", async () => {
    const out = await run(`
      export function test(): number {
        const src = { a: 7, b: 2 };
        const o: any = { ...src };
        return o.a + o.b;
      }
    `);
    expect(out).toBe(9);
  });

  it("spread result is a snapshot — later getter state changes don't leak", async () => {
    const out = await run(`
      let n = 1;
      export function test(): number {
        const src = { get a(): number { return n; } };
        const o: any = { ...src };
        n = 99;
        return o.a;
      }
    `);
    expect(out).toBe(1);
  });
});
