// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2888 (sub-slice of #2873) — standalone relational comparison (`<`,`<=`,`>`,
// `>=`) with a `String` wrapper-object operand emitted invalid Wasm.
//
// `compileStringBinaryOp`'s relational arm pushed both operands raw and called
// the native `__str_compare` helper, which takes `(ref $AnyString,
// ref $AnyString)`. A non-native-string operand — a `String` wrapper object
// (`new String("1")`), a boxed/dynamic externref, or a number — is NOT a native
// `ref $AnyString`, so the call tripped the helper's param type and the module
// failed Wasm validation:
//   `call[0] expected type (ref null 6), found local.tee of type externref`
//   `any.convert_extern[0] expected externref, found ref.cast null of (ref null 6)`
// The `+` concat case already lowered each operand to a native `ref $AnyString`
// via `compileNativeConcatOperand` (ToString); relational did not. Fix: mirror
// that under `noJsHost` (standalone / WASI). This flips the test262
// `language/expressions/{less-than,greater-than,less-than-or-equal,
// greater-than-or-equal}/S11.8.x_A3.2_T1.x` String-wrapper relational cluster
// from compile_error to pass, host-free, with zero host (gc) regression.
//
// String returns from a standalone module are native-string refs (not JS
// strings), so these assert via boolean → number (1/0) exports.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host import may leak under standalone.
  expect(r.imports ?? []).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2888 — standalone relational with String wrapper operand (was invalid Wasm)", () => {
  it("new String('1') < '1'  →  false", async () => {
    expect(
      await runStandalone(`export function test(): number { const a = new String("1"); return (a < "1") ? 1 : 0; }`),
    ).toBe(0);
  });

  it("'1' < new String('1')  →  false", async () => {
    expect(
      await runStandalone(`export function test(): number { const b = new String("1"); return ("1" < b) ? 1 : 0; }`),
    ).toBe(0);
  });

  it("new String('1') < new String('2')  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new String("1"); const b = new String("2"); return (a < b) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("new String('x') > '1'  →  true (lexicographic)", async () => {
    expect(
      await runStandalone(`export function test(): number { const a = new String("x"); return (a > "1") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new String('2') >= '10'  →  true (code-unit order, '2' > '1')", async () => {
    expect(
      await runStandalone(`export function test(): number { const a = new String("2"); return (a >= "10") ? 1 : 0; }`),
    ).toBe(1);
  });

  it("new String('1') <= new String('1')  →  true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new String("1"); const b = new String("1"); return (a <= b) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("plain string relational still works (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { return ("a" < "b") ? 1 : 0; }`)).toBe(1);
  });
});
