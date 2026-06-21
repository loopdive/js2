// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2169 (SF-2 of #2157, final consumer) — array-destructuring `const [a,b]=g()`
 * over a Wasm-native generator.
 *
 * The companion spread (#1491) + Array.from slices added/consumed
 * `emitNativeGeneratorToVec`. The array-destructuring consumer
 * (`compileArrayDestructuring` in `statements/destructuring.ts`) still routed
 * the generator state struct through the unknown-struct externref fallback
 * (`extern.convert_any` → `__array_from_iter_n` host import), an env import that
 * doesn't exist standalone, so the module failed zero-import instantiation. It
 * now detects the native-generator subject and drains it via
 * `emitNativeGeneratorToVec` (with `trimToLength=true` so out-of-length binding
 * defaults fire), then destructures the resulting f64 vec through the proven
 * typed-vec path.
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

describe("#2169 array-destructure over a native generator", () => {
  it("two bindings, two yields (the SF-2 gate repro)", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; }
export function test(): number { const [a,b]=g(); return a+b; }`),
    ).toBe(3);
  });

  it("three bindings, three yields — positional values", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { const [a,b,c]=g(); return a*100+b*10+c; }`),
    ).toBe(123);
  });

  it("fewer bindings than yields — extras are dropped", async () => {
    expect(
      await runStandalone(`function* g(){ yield 5; yield 6; yield 7; }
export function test(): number { const [a,b]=g(); return a*10+b; }`),
    ).toBe(56);
  });

  it("more bindings than yields — out-of-length binding default fires", async () => {
    // One yield, two bindings; `b` is past the generator's length so its
    // default (9) must apply (trimToLength makes the OOB read genuinely OOB).
    expect(
      await runStandalone(`function* g(){ yield 1; }
export function test(): number { const [a,b=9]=g(); return a*10+b; }`),
    ).toBe(19);
  });

  it("rest pattern collects the tail", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; yield 4; }
export function test(): number { const [a,...rest]=g(); return a*100+rest.length*10+rest[0]; }`),
    ).toBe(132);
  });

  it("elision skips an element", async () => {
    expect(
      await runStandalone(`function* g(){ yield 7; yield 8; }
export function test(): number { const [,b]=g(); return b; }`),
    ).toBe(8);
  });

  it("control-flow generator (conditional yields)", async () => {
    // yields 0, 2, 3 (skips i===1)
    expect(
      await runStandalone(`function* g(){ let i=0; while(i<4){ if(i!==1) yield i; i++; } }
export function test(): number { const [a,b,c]=g(); return a*100+b*10+c; }`),
    ).toBe(23);
  });

  it("more than initial capacity (>4 yields exercises grow + trim)", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; yield 4; yield 5; }
export function test(): number { const [a,b,c,d,e]=g(); return a+b+c+d+e; }`),
    ).toBe(15);
  });
});
