// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2169 (SF-2 of #2157, continued) — `Array.from(g())` over a Wasm-native
 * generator.
 *
 * The companion spread fix (#1491) added `emitNativeGeneratorToVec`. The
 * `Array.from` consumer still converted the generator state struct to externref
 * and called the host `__array_from` import — an env import that doesn't exist
 * standalone, so the module failed zero-import instantiation. The
 * `Array.from(arr)` handler (`expressions/calls.ts`) now, when there's no mapFn
 * and the argument lowers to a native-generator subject, drains it via
 * `emitNativeGeneratorToVec` into an f64 vec instead.
 *
 * Scope: `Array.from(gen)` without a mapFn. `Array.from(gen, mapFn)` still uses
 * the host path (the mapFn closure needs the host wrapper). Array-destructuring
 * `[a,b]=g()` is the remaining #2169 consumer (separate variable-declaration
 * binding-pattern site), carried forward.
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

describe("#2169 Array.from over a native generator", () => {
  it("length", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a = Array.from(g()); return a.length; }`),
    ).toBe(3);
  });

  it("values", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const a = Array.from(g()); return a[0] * 100 + a[1] * 10 + a[2]; }`),
    ).toBe(123);
  });

  it("more than initial capacity (>4 yields exercises grow)", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; yield 4; yield 5; }
export function test(): number { const a = Array.from(g()); let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }`),
    ).toBe(15);
  });

  it("control-flow generator", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (i < 4) { if (i !== 1) yield i; i++; } }
export function test(): number { const a = Array.from(g()); let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s * 100 + a.length; }`),
    ).toBe(503); // values 0,2,3 → sum 5, length 3
  });

  it("regression: Array.from(array) still copies", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const src = [1, 2, 3]; const a = Array.from(src); return a[0] + a[1] + a[2]; }`,
      ),
    ).toBe(6);
  });
});
