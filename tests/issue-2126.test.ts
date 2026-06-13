// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2126 — object-literal construction with a RUNTIME computed key dropped
// the property and never evaluated the key expression. The struct paths lay
// out fields from compile-time-known names only; a `[expr]` that doesn't
// fold to a literal had no field slot and no fallback. Such literals now
// route to the host plain-object path, which evaluates the key at runtime
// and stores it via __extern_set.

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
  return (instance.exports as any)[fn]();
}

describe("#2126 — runtime computed keys in object literals", () => {
  it("a key only known at runtime creates the property", async () => {
    const out = await run(`
      export function test(): number {
        const ks = ["p", "q"];
        let k = ks[1];
        const o: any = { [k]: 5 };
        return o.q;
      }
    `);
    expect(out).toBe(5);
  });

  it("the key expression's side effects run exactly once", async () => {
    const out = await run(`
      let calls = 0;
      const key = (): string => { calls++; return "x"; };
      export function test(): number {
        const o2: any = { [key()]: 1 };
        return calls * 10 + o2.x;
      }
    `);
    expect(out).toBe(11);
  });

  it("key evaluates before the value, per spec order", async () => {
    const out = await run(`
      let log = "";
      const key = (): string => { log += "K"; return "x"; };
      const val = (): number => { log += "V"; return 1; };
      export function test(): number {
        const o: any = { [key()]: val() };
        return log === "KV" ? 1 : 0;
      }
    `);
    expect(out).toBe(1);
  });

  it("mixed static and runtime keys all land on the object", async () => {
    const out = await run(`
      export function test(): number {
        const ks = ["a", "b"];
        const k = ks[1];
        const o: any = { x: 1, [k]: 2, y: 3 };
        return o.x * 100 + o.b * 10 + o.y;
      }
    `);
    expect(out).toBe(123);
  });

  it("statically-resolvable computed keys keep the struct fast path", async () => {
    const out = await run(`
      export function test(): number {
        let k = "dyn";
        const o: any = { [k]: 42 };
        return o.dyn;
      }
    `);
    expect(out).toBe(42);
  });

  it("plain and typed struct literals are unregressed", async () => {
    const out = await run(`
      interface P { x: number; y: number }
      export function test(): number {
        const o = { x: 4, y: 5 };
        const p: P = { x: 2, y: 3 };
        return o.x + o.y + p.x * p.y;
      }
    `);
    expect(out).toBe(15);
  });

  it("well-known Symbol keys keep their existing routing", async () => {
    const out = await run(`
      export function test(): number {
        const o: any = { [Symbol.iterator]: () => 0, v: 5 };
        return o.v;
      }
    `);
    expect(out).toBe(5);
  });
});
