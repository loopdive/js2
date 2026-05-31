import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1629 descriptor slice S1 — storage consolidation + the canonical
// Object.getOwnPropertyDescriptor / Object.getOwnPropertyDescriptors read-back.
//
// S1 unifies the descriptor read path so the single-key and the plural form
// agree on bare struct fields, sidecar (defineProperty'd) props, and accessors.
// These tests assert the *host-observable* descriptor objects the runtime
// produces — exactly what a test262 `return`-style harness inspects.
//
// Notes on scope:
//   * Compiled member access *into* the returned descriptor object
//     (`ds.a.value` where `ds` carries a struct-shaped TS type) is a separate,
//     pre-existing codegen concern and is intentionally not exercised here.
//   * All object construction + defineProperty calls are kept *inside* `test()`
//     so they run post-instantiation (after setExports). Module-top-level
//     defineProperty runs in the wasm start function before the struct getters
//     are wired — a pre-existing start-fn/exports-timing limitation outside S1.

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // Make __sget_* struct getters discoverable to the runtime, as the real
  // test262 runner does after instantiation.
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1629 S1 — getOwnPropertyDescriptors read-back", () => {
  it("returns spec descriptors for bare struct fields (zero-overhead fast path)", async () => {
    const ds = (await runHost(
      `export function test(): any { const o = { a: 1, b: 2 }; return Object.getOwnPropertyDescriptors(o) as any; }`,
    )) as Record<string, PropertyDescriptor>;
    expect(Object.keys(ds).sort()).toEqual(["a", "b"]);
    expect(ds.a).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
    expect(ds.b).toEqual({ value: 2, writable: true, enumerable: true, configurable: true });
  });

  it("agrees with single-key getOwnPropertyDescriptor on a bare field", async () => {
    const single = await runHost(
      `export function test(): any { const o = { a: 1, b: 2 }; return Object.getOwnPropertyDescriptor(o, "a") as any; }`,
    );
    const ds = (await runHost(
      `export function test(): any { const o = { a: 1, b: 2 }; return Object.getOwnPropertyDescriptors(o) as any; }`,
    )) as Record<string, PropertyDescriptor>;
    expect(ds.a).toEqual(single);
  });

  it("reflects defineProperty'd flags on an existing field — single and plural agree (S1 contract)", async () => {
    // The core S1 guarantee: the single-key and plural read-back paths agree.
    const body = `const o = { a: 1 };
       Object.defineProperty(o, "a", { value: 5, writable: false, enumerable: false });`;
    const single = (await runHost(
      `export function test(): any { ${body} return Object.getOwnPropertyDescriptor(o, "a") as any; }`,
    )) as PropertyDescriptor;
    const ds = (await runHost(
      `export function test(): any { ${body} return Object.getOwnPropertyDescriptors(o) as any; }`,
    )) as Record<string, PropertyDescriptor>;
    // The explicitly-set flags are reflected; both forms produce the same descriptor.
    expect(single).toMatchObject({ value: 5, writable: false, enumerable: false });
    expect(ds.a).toEqual(single);
  });

  it("includes a dynamically-added (defineProperty) property in the plural form", async () => {
    const ds = (await runHost(
      `export function test(): any {
         const o: any = { a: 1 };
         Object.defineProperty(o, "y", { value: 9, enumerable: false, writable: true });
         return Object.getOwnPropertyDescriptors(o) as any;
       }`,
    )) as Record<string, PropertyDescriptor>;
    expect(Object.keys(ds).sort()).toEqual(["a", "y"]);
    expect(ds.a).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
    expect(ds.y).toMatchObject({ value: 9, writable: true, enumerable: false });
  });

  it("getOwnPropertyDescriptors throws TypeError on null/undefined (ToObject)", async () => {
    await expect(
      runHost(`export function test(): any { return Object.getOwnPropertyDescriptors(null as any) as any; }`),
    ).rejects.toThrow();
    await expect(
      runHost(`export function test(): any { return Object.getOwnPropertyDescriptors(undefined as any) as any; }`),
    ).rejects.toThrow();
  });

  it("returns an empty object for a struct with no own keys", async () => {
    const ds = (await runHost(
      `export function test(): any { return Object.getOwnPropertyDescriptors({} as any) as any; }`,
    )) as Record<string, PropertyDescriptor>;
    expect(Object.keys(ds)).toEqual([]);
  });

  it("still delegates to native for plain non-struct host values", async () => {
    const ds = (await runHost(
      `export function test(): any { return Object.getOwnPropertyDescriptors([1, 2] as any) as any; }`,
    )) as Record<string, PropertyDescriptor>;
    // Array own keys: indices + length.
    expect(ds["0"]).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
    expect(ds["1"]).toEqual({ value: 2, writable: true, enumerable: true, configurable: true });
    expect(ds.length).toMatchObject({ value: 2, writable: true });
  });
});
