// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2169c — host-free `Array.from(iterable)` in standalone mode.
 *
 * Previously `Array.from(x)` (no mapFn) over any iterable routed through the
 * `env::__array_from` host import. Standalone (`--target wasi`) has no JS host,
 * so it pulled an import that can't be satisfied. This drains the iterable
 * natively instead: `__iterator(arg)` wraps it into an `$IterRec`, then
 * `__iterator_rest(rec)` drains it into a canonical externref `$Vec` — the same
 * value the host `__array_from` returned, with ZERO host imports. (Depends on
 * the #2169b `__iterator` driver de-alias so the driver itself validates.)
 *
 * `Array.from(iter, mapFn)` is NOT handled natively (needs closure dispatch) and
 * still delegates to the host path; host mode is `noJsHost`-gated and unchanged.
 * `Array.from(new Set(...))` is gated by a separate Set-iterator producer bug
 * (#2162) and is out of scope here.
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

describe("#2169c host-free Array.from(iterable) (standalone)", () => {
  it("Array.from(arr.values()) — length and elements", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20]; const e=Array.from(a.values()); return e.length*100 + (e[0] as number) + (e[1] as number); }`,
      ),
    ).toBe(230);
  });

  it("Array.from(arr.keys()) — indices", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=[10,20,30]; const e=Array.from(a.keys()); return (e[0] as number)*100 + (e[1] as number)*10 + (e[2] as number); }`,
      ),
    ).toBe(12);
  });

  it("Array.from(generator)", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield 1; yield 2; yield 3; } export function test(): number { const e=Array.from(g()); return e.length*10 + (e[2] as number); }`,
      ),
    ).toBe(33);
  });

  it("Array.from(plain array)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const e=Array.from([5,6,7]); return e.length*10 + (e[2] as number); }`,
      ),
    ).toBe(37);
  });

  it("Array.from(string) — string is iterable", async () => {
    expect(await runStandalone(`export function test(): number { const e=Array.from("abc"); return e.length; }`)).toBe(
      3,
    );
  });
});
