// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3342 — standalone `.join(sep?)` on an `any`-typed externref array
// (`(Object.values(o) as any).join(",")` /
// `(Object.getOwnPropertyNames(o) as any).join(",")`) must not leak
// `env::Uint8ClampedArray_join`.
//
// #3155 fixed `Object.keys(o).join(...)` where the receiver is statically
// `string[]` (the native array-`join` dispatch's `receiverIsExternref` arm).
// But when the receiver is statically `any` — the `as any` cast, or any
// `any`-typed array variable — the call reaches the extern-class-method-on-
// `any` dispatcher (`tryExternClassMethodOnAny`, calls-closures.ts). Its
// first-match loop bound `.join` to the first registered extern class that
// declares a `join` method — a TypedArray, `Uint8ClampedArray` — emitting an
// `env::Uint8ClampedArray_join` host import. That import is satisfiable JS-host
// (byte-identical there) but UNSATISFIABLE under `--target standalone`: the
// module fails to instantiate against an empty import object.
//
// The fix routes `.join` on an `any` receiver, under standalone/WASI, to the
// same #3155 native externref-array walk (`compileArrayJoinExternForAny` →
// `compileArrayJoinExternNative`): length via `__extern_length`, each element
// via `__extern_get_idx` then §7.1.17 ToString via `__extern_toString`, folded
// with the shared native-string join. All three helpers already have native
// standalone arms (the receiver's own host-free `.length` proves it). The
// JS-host lane is untouched (the guard is gated on `ctx.standalone ||
// ctx.wasi`), so it still binds `Uint8ClampedArray_join` — byte-identical.
//
// A genuine TypedArray receiver typed `any` (`(new Uint8Array([...]) as any)
// .join`) rides the SAME native walk correctly, so this is a general
// externref-array-join fix, not just an Object.values special-case.
//
// The join *result* is an opaque `ref $AnyString` from JS, so it is verified
// in-wasm via `===` and returned as a boolean; the no-`env::*`-leak property is
// verified by instantiating against an empty `{}` import object (a leaked
// import would throw a LinkError).
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

describe("#3342 — standalone .join on an any-typed externref array is host-free", () => {
  it("(Object.values(o) as any).join(',') has no Uint8ClampedArray_join leak and is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.values(o) as any).join(",") === "1,2";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("(Object.getOwnPropertyNames(o) as any).join(',') has no leak and is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.getOwnPropertyNames(o) as any).join(",") === "a,b";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("(Object.keys(o) as any).join('|') — the any-cast keys form — is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2, c: 3 };
         return (Object.keys(o) as any).join("|") === "a|b|c";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("default separator: (Object.values(o) as any).join() folds with ','", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 10, b: 20, c: 30 };
         return (Object.values(o) as any).join() === "10,20,30";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("multi-char separator on an any-typed values array is correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { x: 1, y: 2 };
         return (Object.values(o) as any).join(" - ") === "1 - 2";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("empty object → empty-string join (not 'null'), still host-free", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = {};
         return (Object.values(o) as any).join(",") === "";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("a genuine TypedArray typed `any` rides the same native join host-free", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const t: any = new Uint8Array([5, 9]);
         return t.join(",") === "5,9";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("the standalone module has zero env imports for the any-values-join program", async () => {
    const { envImports } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.values(o) as any).join(",") === "1,2";
       }`,
    );
    expect(envImports, `standalone module must have no env imports, got: ${envImports.join(", ")}`).toEqual([]);
  });
});
