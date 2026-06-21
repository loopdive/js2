// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2163 (slice 3) — native `Symbol.for` / `Symbol.keyFor` registry, standalone.
 *
 * Previously `Symbol.for` leaked `env::__symbol_for` and `Symbol.keyFor` leaked
 * `env::__symbol_keyFor` + `env::__box_symbol` — unsatisfiable host imports that
 * made every registry use a zero-import instantiation failure standalone. The
 * registry is now Wasm-native: two parallel growable arrays (slot→key string,
 * slot→symbol id) plus a count, with content-equality key lookup via the native
 * `__str_equals`. A registered symbol's description is its key (§20.4.2.2), so
 * `Symbol.for(k).description === k`.
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

describe("#2163 native Symbol.for / Symbol.keyFor registry (standalone)", () => {
  it("Symbol.for returns the same symbol for the same key", async () => {
    expect(
      await runStandalone(`export function test(): number { return Symbol.for("k") === Symbol.for("k") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Symbol.for returns distinct symbols for distinct keys", async () => {
    expect(
      await runStandalone(`export function test(): number { return Symbol.for("a") === Symbol.for("b") ? 0 : 1; }`),
    ).toBe(1);
  });

  it("Symbol.keyFor returns the registration key of a registered symbol", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol.for("key"); return Symbol.keyFor(s) === "key" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol.keyFor returns undefined for an unregistered symbol", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol("x"); return Symbol.keyFor(s) === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("a registered symbol's description is its key (§20.4.2.2)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol.for("hello"); return s.description === "hello" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol.for and Symbol.keyFor round-trip", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = Symbol.for("rt"); return Symbol.keyFor(s) === "rt" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("re-registering an existing key after others returns the original symbol", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Symbol.for("x"); Symbol.for("y"); Symbol.for("z"); const a2 = Symbol.for("x"); return a === a2 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("a Symbol.for symbol is distinct from a plain Symbol with the same description", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = Symbol.for("k"); const b = Symbol("k"); return a === b ? 0 : 1; }`,
      ),
    ).toBe(1);
  });

  it("registry grows past its initial capacity (20 distinct registrations)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let c = 0;
        const keys = ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t"];
        for (let i = 0; i < keys.length; i++) { const s = Symbol.for(keys[i]); if (Symbol.keyFor(s) === keys[i]) c++; }
        return c; }`),
    ).toBe(20);
  });
});
