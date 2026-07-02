// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2985 — standalone `__obj_find` illegal-cast on non-string computed keys.
 *
 * A computed property key that is neither an `$AnyString`, a boxed number, nor
 * an `$Object` — a boolean (`o[true]`), a bigint (`o[10n]`), or another opaque
 * primitive — reached `__to_property_key`'s fallthrough and was returned
 * UNCHANGED, then hit the downstream `ref.cast $AnyString` in
 * `emitClassifyKey` / `__obj_hash` and trapped `illegal cast [in __obj_find()]`.
 *
 * `__to_property_key`'s #2042 R2 arm only ran `__extern_toString` for `$Object`
 * keys. Boolean/bigint/etc. keys are equally non-Symbol primitives whose
 * ToPropertyKey is `ToString(ToPrimitive(key,"string"))` (§7.1.1.1 → §7.1.17).
 * The fix broadens the arm from "is `$Object`" to "is NOT a Symbol" (or
 * unconditional ToString when symbol keys are disabled); a genuine Symbol still
 * passes through unchanged (looked up by identity via `__key_equals`).
 * Standalone-gated → gc/host lane byte-inert.
 */

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, {
    fileName: "test.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const envImports = (r.imports ?? []).filter((i) => String(i).startsWith("env"));
  expect(envImports, "expected host-free standalone binary").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  return exports.test ? exports.test() : undefined;
}

describe("#2985 — non-string computed key no longer traps illegal cast", () => {
  it("boolean key set→get roundtrips (o[true]) — was illegal cast", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[true] = 1;
export function test(): number { return o[true] === 1 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("both boolean keys are distinct and equal their ToString form", async () => {
    // o[true]===o["true"], o[false]===o["false"], and they do not collide.
    await expect(
      runStandalone(`const o:any = {}; o[true] = 1; o[false] = 2;
export function test(): number {
  return (o[true] === 1 && o[false] === 2 && o["true"] === 1 && o["false"] === 2) ? 1 : 0;
}`),
    ).resolves.toBe(1);
  });

  it("bigint key set→get roundtrips (o[10n]) — was illegal cast", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[10n as any] = 5;
export function test(): number { return o[10n as any] === 5 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("Object.defineProperty with a boolean key defines the ToString key", async () => {
    await expect(
      runStandalone(`const o:any = {};
Object.defineProperty(o, true as any, { value: 7, enumerable: true, configurable: true, writable: true });
export function test(): number { return (o[true] === 7 && o["true"] === 7) ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("getOwnPropertyDescriptor on a boolean key reads the value", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[true] = 5;
const d = Object.getOwnPropertyDescriptor(o, true as any);
export function test(): number { return (d && d.value === 5) ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("`in` on the ToString form of a boolean key is true", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[false] = 1;
export function test(): number { return ("false" in o) ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("delete of a boolean-keyed prop reports success", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[true] = 1;
export function test(): number { return (delete o[true]) ? 1 : 0; }`),
    ).resolves.toBe(1);
  });
});

describe("#2985 — controls: existing key kinds unchanged", () => {
  it("string key still roundtrips", async () => {
    await expect(
      runStandalone(`const o:any = {}; o["x"] = 8;
export function test(): number { return o["x"] === 8 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("number key still roundtrips (canonical decimal ToString)", async () => {
    await expect(
      runStandalone(`const o:any = {}; o[0] = 9;
export function test(): number { return o[0] === 9 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("object key still routes through toString", async () => {
    await expect(
      runStandalone(`const o:any = {}; const k = { toString() { return "kk"; } }; o[k as any] = 6;
export function test(): number { return o["kk"] === 6 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("Symbol key still passes through unchanged (identity lookup)", async () => {
    await expect(
      runStandalone(`const s = Symbol("k"); const o:any = {}; o[s] = 42;
export function test(): number { return o[s] === 42 ? 1 : 0; }`),
    ).resolves.toBe(1);
  });

  it("distinct Symbol keys do not collide", async () => {
    await expect(
      runStandalone(`const a = Symbol(); const b = Symbol(); const o:any = {}; o[a] = 1; o[b] = 2;
export function test(): number { return (o[a] === 1 && o[b] === 2) ? 1 : 0; }`),
    ).resolves.toBe(1);
  });
});
