// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #42 — standalone iteration-protocol consumer: array spread of a native Set
 * and its scalar iterator projections (`Set.prototype.values`/`keys`).
 *
 * On standalone (`--target wasi`), a `Set` lowers to the WasmGC `$Map` struct
 * (a Set is a Map under the hood). Two consumer bugs surfaced:
 *
 *   1. `[...set]` (bare) fell into the generic vec-spread fallthrough, which
 *      read `struct.get $Map 0` as a `$length` — invalid Wasm
 *      (`i32.add expected i32, found struct.get`). The subject is now routed
 *      through the same `emitCollectionIteratorVec` driver `for-of` uses (a Set
 *      spreads its values, §24.2.3.*).
 *
 *   2. `[...set.values()]` / `[...set.keys()]` materialize a canonical externref
 *      `$Vec`, but the array-literal element-type heuristic picks an f64 result
 *      vec. The Step-3 fill loop copied each element raw (`array.get → array.set`
 *      with no coercion) → `array.set expected f64, found externref`. The fill
 *      loop now coerces each element to the result element type when the source
 *      and destination element types differ — `__unbox_number` here, which has a
 *      pure-Wasm body in `nativeStrings` mode (no host import).
 *
 * Bare `[...map]` / `[...map.entries()]` (which spread `[k, v]` entry *pairs*)
 * are a separate entries-pair slice (#2162 / TaskList #9) and are intentionally
 * out of scope here.
 *
 * Every case must compile standalone with ZERO host imports and run correctly.
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

describe("#42 standalone array spread of a native Set", () => {
  it("bare Set spread — length", async () => {
    expect(
      await runStandalone(`export function test(): number { const s=new Set([1,2,3]); return [...s].length; }`),
    ).toBe(3);
  });

  it("bare Set spread — values preserved", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([5,6,7]); const a=[...s]; return a[0]+a[1]+a[2]; }`,
      ),
    ).toBe(18);
  });

  it("Set.values() spread — length", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([1,2,3]); return [...s.values()].length; }`,
      ),
    ).toBe(3);
  });

  it("Set.values() spread — values preserved", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([5,6]); const a=[...s.values()]; return a[0]+a[1]; }`,
      ),
    ).toBe(11);
  });

  it("Set.keys() spread — length (key === value for a Set)", async () => {
    expect(
      await runStandalone(`export function test(): number { const s=new Set([1,2,3]); return [...s.keys()].length; }`),
    ).toBe(3);
  });

  it("Set.keys() spread — values preserved", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([4,5]); const a=[...s.keys()]; return a[0]+a[1]; }`,
      ),
    ).toBe(9);
  });

  it("mixed literal — head element then Set spread", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([1,2]); const a=[9,...s]; return a.length; }`,
      ),
    ).toBe(3);
  });

  it("mixed literal — values in source order", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([1,2]); const a=[9,...s]; return a[0]+a[1]+a[2]; }`,
      ),
    ).toBe(12);
  });

  it("Set<string> spread — element count", async () => {
    expect(
      await runStandalone(`export function test(): number { const s=new Set(["a","bb"]); return [...s].length; }`),
    ).toBe(2);
  });

  it("Set<string> spread — string element preserved", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set(["a","bb"]); const a=[...s]; return a[1].length; }`,
      ),
    ).toBe(2);
  });

  it("Set spread dedupes (Set semantics)", async () => {
    expect(
      await runStandalone(`export function test(): number { const s=new Set([1,1,2,2,3]); return [...s].length; }`),
    ).toBe(3);
  });
});

describe("#42 regression guards — existing spread forms unchanged", () => {
  it("array spread", async () => {
    expect(await runStandalone(`export function test(): number { const a=[...[1,2,3]]; return a[0]+a[2]; }`)).toBe(4);
  });

  it("string spread length", async () => {
    expect(await runStandalone(`export function test(): number { return [..."hello"].length; }`)).toBe(5);
  });

  it("native generator spread", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield 5; yield 6; } export function test(): number { const a=[...g()]; return a[0]+a[1]; }`,
      ),
    ).toBe(11);
  });

  it("typed number[] spread", async () => {
    expect(await runStandalone(`export function test(): number { const x:number[]=[7,8,9]; return [...x][1]; }`)).toBe(
      8,
    );
  });

  it("Set for-of unchanged", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s=new Set([1,2,3]); let t=0; for(const x of s) t+=x; return t; }`,
      ),
    ).toBe(6);
  });
});
