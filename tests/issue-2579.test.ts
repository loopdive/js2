// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2579 — `__any_strict_eq` / `__any_eq` tag-5 (string) arm was always-false in
 * standalone. The `$AnyValue`-boxed equality helpers compared same-tag string
 * operands via the `wasm:js-string` `equals` builtin, which is absent in
 * standalone (`strEqualsIdx === -1`), so the arm emitted `i32.const 0`. The fix
 * routes the standalone arm to the native `__str_equals` (with `__str_flatten`
 * for cons-strings) on the field-4 externval recovered to `$AnyString`.
 *
 * Surfaces via `Array.prototype.{indexOf,lastIndexOf,includes}.call(arrayLike,
 * str)`, which composes `__any_from_extern` + `__any_strict_eq` /
 * `__any_eq`-derived `__extern_strict_eq` / `__extern_same_value_zero`.
 */

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).test();
}

describe("#2579 — boxed tag-5 string equality routes to native __str_equals (standalone)", () => {
  it("Array.prototype.indexOf.call over a string array-like finds the match", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"x",1:"y",length:2}; return Array.prototype.indexOf.call(al, "y"); }`,
      ),
    ).toBe(1);
  });

  it("Array.prototype.includes.call over a string array-like returns true", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"x",1:"y",length:2}; return Array.prototype.includes.call(al, "y")?1:0; }`,
      ),
    ).toBe(1);
  });

  it("Array.prototype.lastIndexOf.call over a string array-like finds the last match", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"y",1:"x",2:"y",length:3}; return Array.prototype.lastIndexOf.call(al, "y"); }`,
      ),
    ).toBe(2);
  });

  it("cons-string element (concat) compares by content", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"ab",1:("x"+"y"),length:2}; return Array.prototype.indexOf.call(al, "xy"); }`,
      ),
    ).toBe(1);
  });

  it("different-length strings do not spuriously match (len early-out)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"abc",1:"de",length:2}; return Array.prototype.indexOf.call(al, "de"); }`,
      ),
    ).toBe(1);
  });

  it("a miss returns -1 / false", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:"x",1:"y",length:2}; return Array.prototype.indexOf.call(al, "z"); }`,
      ),
    ).toBe(-1);
  });

  // ── Non-regression guards ────────────────────────────────────────────────

  it("numeric array-like .call search is unaffected", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const al:any={0:10,1:20,length:2}; return Array.prototype.indexOf.call(al, 20); }`,
      ),
    ).toBe(1);
  });

  it("static string === is unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const a="hi"; return a==="hi"?1:0; }`)).toBe(1);
    expect(await runStandalone(`export function test(): number { const a="hi"; return a==="bye"?1:0; }`)).toBe(0);
  });
});
