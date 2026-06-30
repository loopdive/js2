// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2866 (PR1: slices 1+2 + enumeration exclusion) — Wasm-native Symbol carrier
 * for the `$Object` property key channel, standalone.
 *
 * Before #2866 a Symbol used as an `$Object` key (`o[sym] = v`) leaked the
 * host-only `env::__box_symbol` import (then trapped `illegal cast` at the
 * `(ref $AnyString)` key path) — ~418 standalone-only failures. The fix:
 *   - a native `$Symbol {id, desc}` carrier + a host-free `__box_symbol(i32)`
 *     builder (`ensureSymbolCarrier`);
 *   - the `$Object` key channel (`$PropEntry.key`) widened to `anyref` so it
 *     holds either a native string OR a `$Symbol`, with id-identity equality;
 *   - string-key enumeration (Object.keys/getOwnPropertyNames/for-in/JSON)
 *     EXCLUDES symbol keys (§10.1.11.1).
 *
 * Every case must compile standalone with ZERO host imports and run correctly,
 * and the simple Symbol surface + string-key object ops must stay correct.
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

describe("#2866 native Symbol carrier — Symbol-keyed $Object ops (standalone)", () => {
  it("stores and reads back a symbol-keyed value host-free", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; return o[s]; }`,
      ),
    ).toBe(5);
  });

  it("overwrites an existing symbol key in place", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; o[s] = 9; return o[s]; }`,
      ),
    ).toBe(9);
  });

  it("preserves symbol identity (same symbol reads back the value)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 7; const s2 = s; return o[s2]; }`,
      ),
    ).toBe(7);
  });

  it("keeps distinct symbols as distinct keys", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Symbol(); const b = Symbol(); const o: any = {}; o[a] = 1; o[b] = 2; return (o[a] as number) * 10 + (o[b] as number); }`,
      ),
    ).toBe(12);
  });

  it("string and symbol keys coexist in one object", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o["x"] = 9; o[s] = 5; return (o["x"] as number) * 10 + (o[s] as number); }`,
      ),
    ).toBe(95);
  });

  it("`sym in o` is true after a symbol-keyed set", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; return (s in o) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("`delete o[sym]` removes the symbol key", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o[s] = 5; delete o[s]; return (s in o) ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("a well-known symbol works as a key", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; o[Symbol.iterator] = 3; return o[Symbol.iterator]; }`,
      ),
    ).toBe(3);
  });

  it("Object.keys EXCLUDES symbol keys (§10.1.11.1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o.a = 1; o.b = 2; o[s] = 5; return Object.keys(o).length; }`,
      ),
    ).toBe(2);
  });

  it("Object.getOwnPropertyNames EXCLUDES symbol keys", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol(); const o: any = {}; o.a = 1; o[s] = 5; return Object.getOwnPropertyNames(o).length; }`,
      ),
    ).toBe(1);
  });

  it("the simple Symbol surface stays host-free and correct", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol("d"); return (typeof s === "symbol" && Symbol() !== Symbol() && Symbol.iterator === Symbol.iterator && s.description === "d") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string-key object ops are unregressed (insert/grow/keys)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = {}; for (let i = 0; i < 20; i++) { o["k" + i] = i; } let s = 0; for (let i = 0; i < 20; i++) { s += o["k" + i] as number; } return s + Object.keys(o).length; }`,
      ),
    ).toBe(210);
  });
});
