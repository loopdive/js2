// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3511 — Symbol-keyed property access on a host-object receiver with a
// dynamically-`any`-typed key must NOT ToNumber-coerce the key (the vec
// index-probe used the throwing `__unbox_number`, so `obj[symbol]` threw
// "Cannot convert a Symbol value to a number"). The symbol-safe `__any_to_index`
// probe returns NaN for a Symbol/BigInt key, routing to the property path.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, Function>).test();
}

describe("#3511 symbol-keyed access does not coerce the key to a number", () => {
  it("reads a Symbol-keyed property via an any-typed key on a host object", async () => {
    // Map.prototype[Symbol.iterator] is a function; read it through an any key.
    const r = await run(`
      function get(o: any, k: any): any { return o[k]; }
      export function test(): number {
        const m: any = Map;
        return typeof get(m.prototype, Symbol.iterator) === "function" ? 1 : 0;
      }`);
    expect(r).toBe(1);
  });

  it("writes and reads a Symbol-keyed property via an any-typed key", async () => {
    const r = await run(`
      function put(o: any, k: any, v: any): void { o[k] = v; }
      export function test(): number {
        const o: any = {};
        put(o, Symbol.iterator, 7);
        return o[Symbol.iterator];
      }`);
    expect(r).toBe(7);
  });

  it("keeps numeric-index element access byte-identical (any receiver + any key)", async () => {
    const r = await run(`
      function get(o: any, k: any): any { return o[k]; }
      export function test(): number { const a: any = [10, 20, 30]; return get(a, 1); }`);
    expect(r).toBe(20);
  });

  it("keeps numeric-string key access byte-identical", async () => {
    const r = await run(`
      function get(o: any, k: any): any { return o[k]; }
      export function test(): number { const o: any = {}; o["5"] = 42; return get(o, "5"); }`);
    expect(r).toBe(42);
  });

  it("returns undefined for an OOB numeric index (unchanged)", async () => {
    const r = await run(`
      function get(o: any, k: any): any { return o[k]; }
      export function test(): number { const a: any = [10, 20]; return get(a, 9) === undefined ? 1 : 0; }`);
    expect(r).toBe(1);
  });
});
