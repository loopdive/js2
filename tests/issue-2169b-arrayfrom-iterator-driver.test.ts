// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2169b — the native `__iterator` driver miscompiled `struct.new $__IterRec`
 * at the wrong type index, so `Array.from(<native array iterator>)` (and any
 * other consumer routed through the driver under a chained DCE type-remap)
 * failed `WebAssembly.compile` with `invalid struct index`.
 *
 * Root cause: `buildIteratorBody` aliased one `vecArm` Instr[] into BOTH the
 * `then` and (vec-only) `else` of the same `if`, so its shared `struct.new`
 * instruction object was walked twice by DCE's in-place `remapTypeIdxInBody`,
 * which double-applied a chained type-index remap (e.g. 46→40 then 40→34). The
 * fix de-aliases via a `buildVecArm()` factory so each branch gets a FRESH
 * instruction object, remapped exactly once.
 *
 * This test asserts the driver-routed forms now COMPILE + VALIDATE (no
 * `invalid struct index`). `Array.from(<iterator>)` still pulls the
 * `__array_from` host import (a separate native-`__array_from` follow-on, #2169),
 * so it is checked for VALIDATION only; the zero-host for-of / spread paths over
 * native iterators are checked end-to-end.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function validatesStandalone(src: string): Promise<void> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // The load-bearing assertion: the binary must VALIDATE (no invalid struct index).
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
}

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2169b __iterator driver struct.new index (standalone)", () => {
  it("Array.from(arr.values()) validates (no invalid struct index)", async () => {
    await validatesStandalone(
      `export function test(): number { const a=[10,20]; const e=Array.from(a.values()); return e.length; }`,
    );
  });

  it("Array.from(arr.keys()) validates", async () => {
    await validatesStandalone(
      `export function test(): number { const a=[10,20]; const e=Array.from(a.keys()); return e.length; }`,
    );
  });

  it("Array.from(arr.entries()) validates", async () => {
    await validatesStandalone(
      `export function test(): number { const a=[10,20]; const e=Array.from(a.entries()); return e.length; }`,
    );
  });

  it("for-of over a stored array iterator runs (zero host)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const it=[10,20].values(); let s=0; for(const v of it){ s+=v; } return s; }`,
      ),
    ).toBe(30);
  });

  it("spread of a generator runs (zero host)", async () => {
    expect(
      await runStandalone(
        `function* g(){ yield 1; yield 2; yield 3; } export function test(): number { const e=[...g()]; return e.length*10 + e[2]; }`,
      ),
    ).toBe(33);
  });

  it("for-of over a custom iterable runs (zero host)", async () => {
    expect(
      await runStandalone(
        `const obj = { [Symbol.iterator]() { let i = 0; return { next() { return i < 3 ? { value: i++, done: false } : { value: undefined, done: true }; } }; } }; export function test(): number { let s = 0; for (const v of obj) { s += v; } return s; }`,
      ),
    ).toBe(3);
  });
});
