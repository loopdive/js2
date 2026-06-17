// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 Slice 3 — spread of an array LITERAL in an any-receiver method call.
 *
 * Slices 1/2 added the arity-specialized closed-struct method dispatcher
 * (`__call_m_<name>_<arity>`) for `o.m(a, b)` on an `any`/externref
 * object-literal receiver, but spread args fell through to the generic
 * (host-import) path and returned 0 standalone. A spread of an array LITERAL
 * (`o.m(...[2, 3])`) has a statically-known argument list — `flattenCallArgs`
 * expands it before the arity check so it uses the same dispatcher.
 *
 * Spread of a DYNAMIC source (`o.m(...xs)`) has no statically-known arity and
 * still falls through (would need runtime variable-arity dispatch — out of
 * scope for this slice).
 *
 * Every case compiles standalone with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2151 Slice 3 — spread-of-array-literal any-receiver method call", () => {
  it("two-element literal spread: o.m(...[2,3])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={m(a:number,b:number){return a+b}}; return o.m(...[2,3]); }`,
      ),
    ).toBe(5);
  });

  it("literal spread threads through to a method using this", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={base:10,plus(a:number,b:number){return this.base+a+b}}; return o.plus(...[2,3]); }`,
      ),
    ).toBe(15);
  });

  it("mixed fixed + literal spread: o.m(1, ...[2,3])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={m(a:number,b:number,c:number){return a*100+b*10+c}}; return o.m(1, ...[2,3]); }`,
      ),
    ).toBe(123);
  });

  it("single-element literal spread: o.f(...[5])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o:any={f(n:number){return n+4}}; return o.f(...[5]); }`,
      ),
    ).toBe(9);
  });

  it("empty literal spread: o.next(...[])", async () => {
    expect(
      await runStandalone(`export function test(): number { const o:any={next(){return 7}}; return o.next(...[]); }`),
    ).toBe(7);
  });
});
