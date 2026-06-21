// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2186 — standalone array `.length` through the externref boundary.
//
// A real array literal (and any array result) lowers to a `__vec_<elemKind>`
// struct `(length i32, data (ref array))`. When such a value is boxed to
// externref (e.g. assigned to an `any` local, or returned from an `any`-typed
// function), member access like `arr.length` routes through the native
// `__extern_length(externref)` runtime helper. Before this fix that helper only
// recognised a `$ObjVec` (enumeration result) or an array-like `$Object`, NOT
// the concrete `__vec_<elemKind>` struct — so it fell through to 0, and
// `const a: any = [1,2,3]; a.length` evaluated to 0 standalone (a latent bug
// surfaced while wiring the Proxy `ownKeys`/`apply` traps).
//
// Fix: every `__vec_<elemKind>` now subtypes a shared `$__vec_base` struct whose
// single field is `length` (field 0). `__extern_length` `ref.test`s/`ref.cast`s
// the boxed value against `$__vec_base` and returns its length uniformly,
// regardless of element kind. Element indexing (`a[i]`) through the externref
// boundary is element-type-polymorphic and tracked separately.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2186 standalone array .length through the externref boundary", () => {
  it("number array assigned to `any` reports its real length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [10, 20, 30];
        return a.length;
      }`),
    ).toBe(3);
  });

  it("string array assigned to `any` reports its real length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = ["x", "y"];
        return a.length;
      }`),
    ).toBe(2);
  });

  it("array returned from an `any`-typed function reports its real length", async () => {
    expect(
      await runStandalone(`function g(): any { return [1, 2, 3, 4]; }
        export function test(): number {
          return g().length;
        }`),
    ).toBe(4);
  });

  it("empty array through the boundary reports length 0", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: any = [];
        return a.length;
      }`),
    ).toBe(0);
  });

  it("length is read correctly after the array is grown via push", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: number[] = [];
        for (let i = 0; i < 5; i++) a.push(i);
        const b: any = a;
        return b.length;
      }`),
    ).toBe(5);
  });

  it("direct (typed) array .length is unchanged by the fix", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = [1, 2, 3, 4, 5, 6];
        return a.length;
      }`),
    ).toBe(6);
  });

  it("core array operations still validate and run (supertype-change regression guard)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a: number[] = [];
        for (let i = 0; i < 4; i++) a.push(i * 2);
        let s = 0;
        for (const x of a) s += x;
        const b = a.filter((x: number) => x > 0).map((x: number) => x + 1);
        return s + b.length;
      }`),
    ).toBe(0 + 2 + 4 + 6 + 3);
  });
});
