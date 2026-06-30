// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2874 — standalone `Object.getOwnPropertyDescriptor` on a STATICALLY-TYPED
// receiver leaked the host import `env::__create_descriptor` (no native carrier),
// so the standalone module trapped.
//
// Root cause (confirmed verify-first): the typed-receiver fast path
// (`expressions/calls.ts:6652`/`:6808`) inlines `struct.get` and then calls the
// host `__create_descriptor(value, flags)` to wrap the field value in a data
// descriptor. Under `--target standalone` that host import has no native carrier,
// so the typed case leaked it (the `any`-typed / inline-literal receiver already
// resolved natively). Fix: register a standalone-native `__create_descriptor` in
// `object-runtime.ts` (mirrors the data branch of the native
// `__getOwnPropertyDescriptor`) building a 4-key `$Object`
// `{value, writable, enumerable, configurable}` from the flag bits, and ensure
// the object runtime is registered on the GOPD fast path under `ctx.standalone`
// so `ensureLateImport` resolves the native helper.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host descriptor import may leak under standalone.
  const leaked = (r.imports ?? [])
    .map((i) => i.name)
    .filter((n) => /__create_descriptor|__getOwnPropertyDescriptor|__defineProperty/.test(n));
  expect(leaked, "standalone must not leak a host descriptor import").toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2874 — standalone Object.getOwnPropertyDescriptor on a typed receiver", () => {
  it("reads the data value (was a host-import leak / trap)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 5 }; const d: any = Object.getOwnPropertyDescriptor(o, 'a'); return d.value; }`,
      ),
    ).toBe(5);
  });

  it("data descriptor writable flag is true for a plain field", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 5 }; const d: any = Object.getOwnPropertyDescriptor(o, 'a'); return d.writable ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("enumerable + configurable flags are true for a plain field", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 5 }; const d: any = Object.getOwnPropertyDescriptor(o, 'a'); return (d.enumerable && d.configurable) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string-valued field descriptor carries the native-string value", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { s: "hi" }; const d: any = Object.getOwnPropertyDescriptor(o, 's'); return (d.value as string).length; }`,
      ),
    ).toBe(2);
  });

  it("missing own property returns undefined", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 5 }; const d: any = Object.getOwnPropertyDescriptor(o, 'b'); return d === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("multi-field struct resolves the right field", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o = { a: 1, b: 2, c: 3 }; const d: any = Object.getOwnPropertyDescriptor(o, 'c'); return d.value; }`,
      ),
    ).toBe(3);
  });

  it("the representative test262 shape (+Infinity → 'Infinity' key) works", async () => {
    // 15.2.3.3-2-14.js shape: var obj = { Infinity: 1 } (inferred struct type).
    expect(
      await runStandalone(
        `export function test(): number { const obj = { Infinity: 1 }; const d: any = Object.getOwnPropertyDescriptor(obj, "Infinity"); return d.value; }`,
      ),
    ).toBe(1);
  });
});
