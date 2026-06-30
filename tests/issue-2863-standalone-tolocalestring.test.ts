// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2863 Phase 2 — standalone `.toLocaleString()` on a dynamic / Array / TypedArray
// receiver no longer refuses.
//
// Under `--target standalone`/`wasi` there is no host `__extern_toLocaleString`
// carrier, so `arr.toLocaleString()` / `dynObj.toLocaleString()` hit the #1472
// "dynamic-shape object/property operation is not supported" compile refusal.
// Without ECMA-402 the spec default collapses to ToString:
//   - Object.prototype.toLocaleString (§20.1.3.5) → this.toString()  → "[object Object]"
//   - Array.prototype.toLocaleString (§23.1.3.32) joins per-element toLocaleString
//     → same comma-join as toString in a locale-independent runtime
//   - %TypedArray%.prototype.toLocaleString (§23.2.3.32) → same comma-join
// Fix: Array/TypedArray receivers route to the native join lowering (shared with
// `toString`); generic dynamic receivers route to the native `__extern_toString`
// (#1866). Host (gc) mode keeps `__extern_toLocaleString` for real Intl grouping.
//
// String returns from a standalone module are native-string refs (not JS
// strings), so these assert via `.length` (a number export).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host-object import may leak under standalone.
  expect((r.imports ?? []).map((i) => i.name).filter((n) => /^__extern_toLocaleString$/.test(n))).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2863 Phase 2 — standalone Array.prototype.toLocaleString", () => {
  it("number array joins with comma (was a compile refusal)", async () => {
    // "1,2,3".length === 5
    expect(await runStandalone(`export function test(): number { return [1, 2, 3].toLocaleString().length; }`)).toBe(5);
  });

  it("string array joins with comma", async () => {
    // "a,b".length === 3
    expect(await runStandalone(`export function test(): number { return ["a", "b"].toLocaleString().length; }`)).toBe(
      3,
    );
  });

  it("empty array → empty string", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: number[] = []; return a.toLocaleString().length; }`,
      ),
    ).toBe(0);
  });
});

describe("#2863 Phase 2 — standalone TypedArray.prototype.toLocaleString", () => {
  it("Int32Array joins with comma", async () => {
    // "1,2,3".length === 5
    expect(
      await runStandalone(
        `export function test(): number { const a = new Int32Array([1, 2, 3]); return a.toLocaleString().length; }`,
      ),
    ).toBe(5);
  });

  it("Uint8Array joins with comma", async () => {
    // "10,20".length === 5
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8Array([10, 20]); return a.toLocaleString().length; }`,
      ),
    ).toBe(5);
  });
});

describe("#2863 Phase 2 — standalone generic object toLocaleString", () => {
  it("plain object → '[object Object]' via ToString default", async () => {
    // "[object Object]".length === 15
    expect(
      await runStandalone(`export function test(): number { const o: any = {}; return o.toLocaleString().length; }`),
    ).toBe(15);
  });
});

describe("#2863 Phase 2 — host (gc) mode is unchanged", () => {
  it("host mode keeps the __extern_toLocaleString import (real Intl path)", async () => {
    const r = await compile(`export function test(): string { return [1, 2, 3].toLocaleString(); }`, {});
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const usesHostTLS = (r.imports ?? []).some((i) => i.name === "__extern_toLocaleString");
    expect(usesHostTLS, "host mode must still route Array.toLocaleString to the host import").toBe(true);
  });
});
