// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3155 — standalone `Object.keys(o).join(sep)` must not leak `env::__array_join_any`.
//
// `Object.keys(any)` yields a boxed (externref) array. The array-`join` dispatch
// routes an externref receiver through `compileArrayJoinExtern`, which on the
// JS-host lane delegates to the `__array_join_any` host import. Under
// `--target standalone` there is no JS host, so that import is unsatisfiable —
// the module fails to instantiate against an empty import object, and the real
// test262 symptom is a `TypeError: Cannot convert object to primitive value` on
// paths like `Object.keys(o).join(",")` (surfaced by the #86 vacuous-standalone
// audit; contrast the receiver's own `.length`, which was already host-free via
// the native `__extern_length` arm).
//
// The fix (`compileArrayJoinExternNative`, array-methods.ts) walks the externref
// array natively under `noJsHost`: length via `__extern_length`, each element
// via `__extern_get_idx` then §7.1.17 ToString via `__extern_toString` (all
// native-registered standalone), folded with the shared `emitStringJoinFold`
// over the native-string representation — the same machinery the WasmGC-vec
// `join` lane uses. The host lane is byte-identical (guarded on `noJsHost`).
//
// This is the permanent regression guard required by the #2093 probe-coverage
// gate. Since a standalone string export is an opaque `ref $AnyString` from JS,
// the join *result* is verified in-wasm via a native `===` compare and returned
// as a boolean; the no-`env::*`-leak property is verified by instantiating
// against an empty `{}` import object (a leaked import would throw a LinkError).
//
// Carve-out (RESOLVED by #3342): the `as any`-cast form
// `(Object.values(o) as any).join(...)` routed through a distinct
// TypedArray-join misclassification in `tryExternClassMethodOnAny` (leaked
// `env::Uint8ClampedArray_join`). Fixed in #3342 by routing `.join` on an
// `any` receiver to this same native externref walk under standalone/WASI —
// see `tests/issue-3342.test.ts`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Probe {
  envImports: string[];
  result: unknown;
}

async function standaloneProbe(src: string): Promise<Probe> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone module failed WebAssembly.validate").toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  // Instantiate against an EMPTY import object — a leaked env import throws here.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test: () => unknown }).test();
  return { envImports, result };
}

describe("#3155 — standalone Object.keys().join is host-free", () => {
  it("default separator: Object.keys(o).join() has no env leak and is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2, c: 3 };
         return Object.keys(o).join() === "a,b,c";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("explicit comma separator has no env leak and is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return Object.keys(o).join(",") === "a,b";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("multi-char separator has no env leak and is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2, c: 3 };
         return Object.keys(o).join(" - ") === "a - b - c";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("integer-key canonical order is preserved (ascending index keys first)", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { b: 1, "2": 2, a: 3, "1": 4 };
         return Object.keys(o).join(",") === "1,2,b,a";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("empty object joins to the empty string (not the string 'null')", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = {};
         return Object.keys(o).join(",") === "";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("single-key object needs no separator emission", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { only: 42 };
         return Object.keys(o).join(",") === "only";
       }`,
    );
    expect(envImports).not.toContain("__array_join_any");
    expect(result).toBe(1);
  });

  it("the standalone module has zero env imports for the join program", async () => {
    const { envImports } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return Object.keys(o).join(",") === "a,b";
       }`,
    );
    expect(envImports, `standalone module must have no env imports, got: ${envImports.join(", ")}`).toEqual([]);
  });
});
