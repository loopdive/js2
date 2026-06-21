// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1536c — a user subclass of a built-in Error (`class MyError extends Error {}`)
// must compile, instantiate, and run under `--target standalone` with ZERO
// `env::` host imports.
//
// Before: the externref-backed subclass routed instance creation through the
// `__new_<Parent>` JS host import and `instanceof` through `__tag_user_class` +
// `__instanceof` host imports — so standalone leaked `env::__new_Error` /
// `env::__tag_user_class` and failed to instantiate.
//
// Fix (gated `ctx.wasi || ctx.standalone`; JS-host path untouched):
//  1. Instance creation (implicit derived ctor + `compileSuperCall`,
//     `class-bodies.ts`) emits the native `__new_<Parent>` internal function
//     (`emitWasiErrorConstructor`) and calls it — a real `$Error_struct` with
//     the parent `$tag`, `.message`, `.name`.
//  2. The host `__tag_user_class` tagging is skipped standalone; `instanceof`
//     resolves natively via the `$Error_struct` `$tag` set — both
//     `instanceof MyError` and `instanceof Error` (identifiers.ts).
//  3. `.message`/`.name`/`.stack` on a user-Error-subclass receiver read the
//     `$Error_struct` field directly (property-access.ts), not the generic
//     `__extern_get` host path.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, assert zero host imports, instantiate, return test(). */
async function runStandalone<T = number>(src: string): Promise<T> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): T }).test();
}

describe("#1536c user Error subclass — standalone (zero host imports)", () => {
  it("new MyError(msg).message reads back correctly", async () => {
    // length + char code, since the standalone string is an opaque $AnyString.
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { return new MyError("boom").message.length; }`),
    ).toBe(4);
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { return new MyError("boom").message.charCodeAt(0); }`),
    ).toBe(98); // 'b'
  });

  it("new MyError(msg).message === literal", async () => {
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { return new MyError("boom").message === "boom" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("instance instanceof Error is true (subtype of built-in parent)", async () => {
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { return (new MyError("x")) instanceof Error ? 1 : 0; }`),
    ).toBe(1);
  });

  it("instance instanceof MyError is true (user subclass)", async () => {
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { return (new MyError("x")) instanceof MyError ? 1 : 0; }`),
    ).toBe(1);
  });

  it("a non-Error value is NOT instanceof MyError", async () => {
    expect(
      await runStandalone(`class MyError extends Error {}
        export function test(): number { const o = { x: 1 }; return (o as any) instanceof MyError ? 1 : 0; }`),
    ).toBe(0);
  });

  it("explicit constructor with super(msg) works standalone", async () => {
    expect(
      await runStandalone(`class MyError extends Error { constructor(m: string) { super(m); } }
        export function test(): number { return new MyError("hello").message.length; }`),
    ).toBe(5);
    expect(
      await runStandalone(`class MyError extends Error { constructor(m: string) { super(m); } }
        export function test(): number { return (new MyError("x")) instanceof MyError ? 1 : 0; }`),
    ).toBe(1);
  });

  it("subclass of a non-Error built-in error (TypeError) chains both ways", async () => {
    expect(
      await runStandalone(`class MyTE extends TypeError {}
        export function test(): number { return (new MyTE("x")) instanceof TypeError ? 1 : 0; }`),
    ).toBe(1);
    expect(
      await runStandalone(`class MyTE extends TypeError {}
        export function test(): number { return (new MyTE("x")) instanceof Error ? 1 : 0; }`),
    ).toBe(1);
  });
});
