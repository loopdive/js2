// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1664 — residual generic-object / iterator host imports under `--target wasi`.
 *
 * After #1666 most standalone constructs (class/super, Map/Set, Array.from)
 * stopped leaking the generic externref-dispatch helpers. The remaining gap
 * was TypedArray `.set` / `.subarray`, which were not in the native array-
 * method dispatch table and fell through to the generic `__extern_get` /
 * `__extern_length` host imports — unsatisfiable in a pure-Wasm engine.
 *
 * These tests assert, per case:
 *   1. The compiled `--target wasi` module instantiates with an EMPTY import
 *      object (no `__extern_*` / `__register_*` / `__array_from_iter` leak).
 *   2. The method produces the spec-correct value.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_LEAK_RE = /__extern_|__register_|__iterator|__array_from/;

async function runWasi(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const leaks = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_LEAK_RE.test(i.name))
    .map((i) => `${i.module}::${i.name}`);
  expect(leaks, `unexpected host-import leak: ${leaks.join(", ")}`).toEqual([]);
  // Instantiating a compiled Module (not bytes) returns the Instance directly.
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#1664 TypedArray set/subarray standalone (no host imports)", () => {
  it("set(array) copies elements", async () => {
    expect(await runWasi(`export function test(){ const a=new Uint8Array(4); a.set([1,2,3]); return a[1]; }`)).toBe(2);
  });

  it("set(typedArray) copies elements", async () => {
    expect(
      await runWasi(
        `export function test(){ const a=new Uint8Array(4); const b=new Uint8Array(2); b[0]=9; a.set(b); return a[0]; }`,
      ),
    ).toBe(9);
  });

  it("set(array, offset) honors offset", async () => {
    expect(await runWasi(`export function test(){ const a=new Uint8Array(4); a.set([5,6],1); return a[1]; }`)).toBe(5);
  });

  it("set bridges element types (i32 literal into Float64Array)", async () => {
    expect(
      await runWasi(
        `export function test(){ const a=new Float64Array(5); a.set([1.5,2.5]); a.set([9.5],3); return a[0]+a[3]; }`,
      ),
    ).toBe(11);
  });

  it("subarray(begin) returns the tail slice", async () => {
    expect(await runWasi(`export function test(){ const a=new Uint8Array(4); a[1]=3; return a.subarray(1)[0]; }`)).toBe(
      3,
    );
  });

  it("subarray(begin, end) returns the clamped slice", async () => {
    expect(
      await runWasi(
        `export function test(){ const a=new Uint8Array(6); a[2]=8; a[3]=4; const s=a.subarray(2,4); return s.length*10 + s[1]; }`,
      ),
    ).toBe(24);
  });

  it("class extends + super call is leak-free (regression from #1666)", async () => {
    expect(
      await runWasi(
        `class A { get(){return 5;} } class B extends A { get(){return super.get()+1;} } export function test(){ return new B().get(); }`,
      ),
    ).toBe(6);
  });
});
