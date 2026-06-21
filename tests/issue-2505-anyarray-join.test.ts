// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2505-family — standalone `Array.prototype.join()` / `toString()` on a
// boxed-any (`externref`) element array (`any[]`, mixed-type literals) emitted
// INVALID Wasm: `compileArrayJoinNative`'s string-element branch `ref.as_non_null`'d
// each `array.get` element (assuming a `$NativeString` ref) and `local.set` it
// into the `(ref $AnyString)` result local — but an `any[]` element is a raw
// `externref` (boxed via `__box_number`/`__box_boolean`), so the validator
// rejected the binary ("local.set expected (ref null N), found ref.as_non_null of
// (ref extern)").
//
// Fix: route a boxed-any element through `__extern_toString` (the SAME runtime
// ToString that `String(x)` / template-literals use for an `any` value), then
// `any.convert_extern` + `ref.cast $AnyString` for the concat fold. NOT
// `__any_to_string` (the $AnyValue-tag dispatcher) — an `any[]` element is a
// `__box_number` externref, not a $AnyValue, so that path mis-stringifies it to
// "[object Object]". Numeric / string / boolean typed-element joins unchanged.
//
// Assertions use `.length` / `.charCodeAt` of the joined string (an i32 return)
// so the test needs no native-string decoding (the #2074 pattern). Instantiates
// with empty imports `{}` — a leaked host import would fail instantiation.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2505 — standalone join/toString of a boxed-any (any[]) element array", () => {
  it('any[] [1,2,3].join(",") → "1,2,3" (valid Wasm + correct content)', async () => {
    expect(
      await runStandalone(`export function run(): number { const a: any[] = [1, 2, 3]; return a.join(",").length; }`),
    ).toBe(5);
    // first char is '1' (49), second is ',' (44) — proves real ToString, not "[object Object]"
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1, 2, 3]; return a.join(",").charCodeAt(0); }`,
      ),
    ).toBe(49);
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1, 2, 3]; return a.join(",").charCodeAt(1); }`,
      ),
    ).toBe(44);
  });

  it('any[] toString() → "1,2,3"', async () => {
    expect(
      await runStandalone(`export function run(): number { const a: any[] = [1, 2, 3]; return a.toString().length; }`),
    ).toBe(5);
  });

  it('mixed any[] [1,"x",true].join("-") → "1-x-true" (len 8)', async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [1, "x", true]; return a.join("-").length; }`,
      ),
    ).toBe(8);
  });

  it('any[] boolean elements [true,false].join(",") → "true,false" (len 10)', async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = [true, false]; return a.join(",").length; }`,
      ),
    ).toBe(10);
  });

  it('any[] string elements ["ab","cd"].join(",") → "ab,cd" (len 5)', async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: any[] = ["ab", "cd"]; return a.join(",").length; }`,
      ),
    ).toBe(5);
  });

  it('empty any[] join → "" (len 0)', async () => {
    expect(
      await runStandalone(`export function run(): number { const a: any[] = []; return a.join(",").length; }`),
    ).toBe(0);
  });

  // ── regressions: typed-element joins must be unchanged ──
  it('number[] [10,9,1,100].join(",") still → "10,9,1,100" (len 10)', async () => {
    expect(
      await runStandalone(`export function run(): number { const a = [10, 9, 1, 100]; return a.join(",").length; }`),
    ).toBe(10);
  });

  it('string[] ["aa","bb","cc"].join(",") still → "aa,bb,cc" (len 8)', async () => {
    expect(
      await runStandalone(`export function run(): number { const a = ["aa", "bb", "cc"]; return a.join(",").length; }`),
    ).toBe(8);
  });

  it('boolean[] [true,false,true].join(",") still → "true,false,true" (len 15)', async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = [true, false, true]; return a.join(",").length; }`,
      ),
    ).toBe(15);
  });
});
