// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 Slice 4 — DYNAMIC spread in an any-receiver method call.
 *
 * Slices 1–3 added the arity-specialized closed-struct dispatcher
 * (`__call_m_<name>_<arity>`) for `o.m(a, b)` and for a spread of an array
 * LITERAL `o.m(...[2,3])` (whose arity is statically known via
 * `flattenCallArgs`). A spread of a DYNAMIC source `o.m(...xs)` has no
 * statically-known arity, so it fell through to the generic host-import path and
 * returned 0 standalone.
 *
 * Slice 4 adds a VARARG dispatcher `__call_m_<name>_vararg(recv, args)`: it
 * type-switches over the closed structs exactly like the fixed-arity dispatcher
 * but reads each declared param from the runtime arg array via
 * `__extern_get_idx(args, i)` (the spread source is passed directly — the native
 * indexer handles wasm vecs and $ObjVec). Out-of-range reads yield `undefined`.
 *
 * Scope: a SINGLE pure dynamic spread `o.m(...xs)` with scalar (number/boolean)
 * params, standalone target. Out of scope (kept on the existing fall-through, no
 * regression): mixed `o.m(a, ...xs)`, wasi (the `__extern_get_idx` array arms
 * are standalone-gated), and ref/string-typed params (a separate pre-existing
 * any-receiver arg-coercion gap that affects ALL slices).
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

describe("#2151 Slice 4 — dynamic-spread any-receiver method call", () => {
  it("two-element dynamic spread: o.m(...xs)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const xs=[2,3]; const o:any={m(a:number,b:number){return a+b}}; return o.m(...xs); }`,
      ),
    ).toBe(5);
  });

  it("dynamic spread threads this", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const xs=[3]; const o:any={base:10,plus(n:number){return this.base+n}}; return o.plus(...xs); }`,
      ),
    ).toBe(13);
  });

  it("three-element dynamic spread", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const xs=[1,2,3]; const o:any={h(a:number,b:number,c:number){return a+b*10+c*100}}; return o.h(...xs); }`,
      ),
    ).toBe(321);
  });

  it("zero-length dynamic spread (no args supplied)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const xs:number[]=[]; const o:any={n(){return 42}}; return o.n(...xs); }`,
      ),
    ).toBe(42);
  });

  it("dynamic spread from a function-returned array", async () => {
    expect(
      await runStandalone(
        `function mk(): number[] { return [4,5]; } export function test(): number { const o:any={g(a:number,b:number){return a*b}}; return o.g(...mk()); }`,
      ),
    ).toBe(20);
  });

  it("Slice 1–3 paths still work (0-arg + static spread regression guard)", async () => {
    expect(
      await runStandalone(`export function test(): number { const o:any={next(){return 7}}; return o.next(); }`),
    ).toBe(7);
    expect(
      await runStandalone(
        `export function test(): number { const o:any={m(a:number,b:number){return a+b}}; return o.m(...[2,3]); }`,
      ),
    ).toBe(5);
  });
});
