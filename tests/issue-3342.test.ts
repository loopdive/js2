// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3342 — standalone `(Object.values(o) as any).join(sep)` /
// `(Object.getOwnPropertyNames(o) as any).join(sep)` must not leak a
// `env::Uint8ClampedArray_join` host import.
//
// Carved out of #3155 (which made `Object.keys(o).join(...)` host-free via the
// native externref-`join` path). This case has a DISTINCT root cause: the
// `as any` cast makes the receiver `any`-typed, so the call reaches the
// `any`-receiver fallback `tryExternClassMethodOnAny` (calls-closures.ts). That
// helper first-matches whichever extern class registered a `join` method with
// all-externref params — a TypedArray view (`Uint8ClampedArray`) is registered
// first, so the call bound `env::Uint8ClampedArray_join`. Under `--target
// standalone` there is no JS host to satisfy that import, so the module fails to
// instantiate against an empty `{}` import object (real test262 symptom: the
// join never runs).
//
// The fix routes a `join` on an `any`-typed receiver to the native externref
// `join` (`compileArrayJoinExtern`, host-free under `noJsHost` since #3155)
// before the first-match loop can bind the TypedArray host import. The JS-host
// lane is untouched (the guard is gated on `noJsHost`), so host-lane codegen is
// byte-identical.
//
// Note the `as any` on the receiver is the actual trigger — `Object.keys()`,
// `Object.values()` and `Object.getOwnPropertyNames()` are ALL host-free without
// the cast (they infer a concrete array type and dispatch through the array-
// methods native path). With the cast, all three previously leaked the same
// `Uint8ClampedArray_join` import; this guard fixes the whole `any`-join class.
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

describe("#3342 — standalone (Object.values/getOwnPropertyNames as any).join is host-free", () => {
  it("Object.values(o) as any: no Uint8ClampedArray_join leak and correct join", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.values(o) as any).join(",") === "1,2";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(envImports).toEqual([]);
    expect(result).toBe(1);
  });

  it("Object.getOwnPropertyNames(o) as any: no leak and correct join", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.getOwnPropertyNames(o) as any).join(",") === "a,b";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(envImports).toEqual([]);
    expect(result).toBe(1);
  });

  it("Object.keys(o) as any: the cast path is host-free too", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.keys(o) as any).join(",") === "a,b";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("multi-char separator is respected", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2, c: 3 };
         return (Object.values(o) as any).join(" - ") === "1 - 2 - 3";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("default separator (no arg) folds with comma", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = { a: 1, b: 2 };
         return (Object.values(o) as any).join() === "1,2";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("empty object joins to the empty string", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const o: any = {};
         return (Object.values(o) as any).join(",") === "";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });

  it("plain array typed as any still joins host-free", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         const a: any = [1, 2, 3];
         return (a).join(",") === "1,2,3";
       }`,
    );
    expect(envImports).not.toContain("Uint8ClampedArray_join");
    expect(result).toBe(1);
  });
});
