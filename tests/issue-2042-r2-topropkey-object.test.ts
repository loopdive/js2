// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2042 R2 — standalone computed member access with an OBJECT key
// (`obj[{toString:()=>"k"}]`) trapped with an illegal cast: the key reached the
// `ref.cast $AnyString` in the `$Object` runtime's `__obj_find`/`__obj_hash`
// without being run through ToPropertyKey. `__to_property_key` (#2042 S1) handled
// AnyString and boxed-number keys but returned an `$Object` key unchanged, so it
// hit the cast and trapped.
//
// Fix: `__to_property_key` now routes a `$Object` key through `__extern_toString`
// (§7.1.1 ToPrimitive(string) → ToString — the canonical ToString used by
// `String(x)` / template literals), yielding the canonical string key. The call
// is spliced into `__to_property_key`'s body after `__extern_toString` registers
// later in `ensureObjectRuntime`. number/string/Symbol keys are unchanged.
//
// (A `valueOf`-only object whose `valueOf` returns a NUMBER stringifies to
// "[object Object]" — a separate pre-existing `__to_primitive`/`__extern_toString`
// engine gap, #1917 — out of scope here, which removes the illegal-cast trap and
// makes the common `toString`-keyed shape work.)
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const fn = (body: string) => `export function run(): number { ${body} }`;

describe("#2042 R2 — standalone object-key ToPropertyKey (no illegal cast)", () => {
  it("write + read under the same {toString} key", async () => {
    expect(
      await runStandalone(fn(`const o: any = {}; const k: any = { toString: () => "key" }; o[k] = 11; return o[k];`)),
    ).toBe(11);
  });

  it("read an existing string-keyed prop via a {toString} object key", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = {}; o["abc"] = 22; const k: any = { toString: () => "abc" }; return o[k];`),
      ),
    ).toBe(22);
  });

  it("`in` with a {toString} object key", async () => {
    expect(
      await runStandalone(
        fn(`const o: any = {}; o["p"] = 1; const k: any = { toString: () => "p" }; return (k in o) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  it("delete with a {toString} object key", async () => {
    expect(
      await runStandalone(
        fn(
          `const o: any = {}; o["q"] = 1; const k: any = { toString: () => "q" }; delete o[k]; return (k in o) ? 1 : 0;`,
        ),
      ),
    ).toBe(0);
  });

  it("a {toString} key that stringifies to a numeric string matches the numeric slot", async () => {
    expect(
      await runStandalone(fn(`const o: any = {}; o[2] = 42; const k: any = { toString: () => "2" }; return o[k];`)),
    ).toBe(42);
  });

  // ── regression: plain string / number / variable keys unchanged ──
  it("string key still works", async () => {
    expect(await runStandalone(fn(`const o: any = {}; o["s"] = 5; return o["s"];`))).toBe(5);
  });

  it("integer numeric key still works", async () => {
    expect(await runStandalone(fn(`const o: any = {}; o[7] = 9; return o[7];`))).toBe(9);
  });

  it("variable numeric key still works", async () => {
    expect(await runStandalone(fn(`const o: any = {}; const k = 3; o[k] = 4; return o[k];`))).toBe(4);
  });
});
