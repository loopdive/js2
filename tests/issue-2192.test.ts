// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2192 — standalone caught-Error `.message`/`.name` compared `=== literal` inline.
//
// A caught Error's `.message`/`.name`/`.stack` read lowers (via the
// property-access `$Error`-struct guard) to a native-string ref, but the
// `catch (e)` binding is typed `any`, so the string-equality dispatch in
// binary-ops missed it and fell through to `ref.eq` (struct identity → always
// false for equal content). So `e.message === "hi"` was false even though
// `const m = e.message; m === "hi"` worked. Fix: recognise the caught-Error
// string property read at the AST level and route the equality to
// `__str_equals` (content compare). This is how test262 asserts —
// `assert.sameValue(e.message, "...")` / `e.message === "..."`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2192 standalone caught-Error .message/.name === literal (inline)", () => {
  it("e.message === literal (inline) is true", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { throw new Error("hi"); } catch (e: any) { return e.message === "hi" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("e.message !== a different literal is true", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { throw new Error("hi"); } catch (e: any) { return e.message !== "no" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("e.name === 'RangeError' (inline)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { throw new RangeError("r"); } catch (e: any) { return e.name === "RangeError" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("e.name === 'TypeError' (inline)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { throw new TypeError("t"); } catch (e: any) { return e.name === "TypeError" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("user Error subclass .message === literal (inline)", async () => {
    expect(
      await runStandalone(`class MyErr extends Error { constructor(m: string) { super(m); } }
      export function test(): number {
        try { throw new MyErr("cm"); } catch (e: any) { return e.message === "cm" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("reading into a typed local still works (no regression)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { throw new Error("hi"); } catch (e: any) { const m: string = e.message; return m === "hi" ? 1 : 0; }
      }`),
    ).toBe(1);
  });

  it("plain object .message === literal is unaffected (no regression)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { message: "x" }; return o.message === "x" ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
