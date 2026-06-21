// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2166 PR-C2 — standalone numeric element indexing on an externref `$ObjVec`.
//
// A standalone `any[<numericIndex>]` read previously always lowered to the
// string-keyed `__extern_get(v, ToString(key))`. For an `$ObjVec` (the
// externref array vector produced by `Object.values`/`Object.entries`, by the
// pure-Wasm `JSON.parse` of an array (#2166 PR-C), and by the array-method
// machinery) the elements are positional, not string-keyed, so `__extern_get`
// found nothing and the read returned `0`/`undefined`.
//
// Fix (src/codegen/property-access.ts, compileElementAccessBody externref arm):
// when the index expression is provably numeric, route through the positional
// `__extern_get_idx(v, f64)` — which ref.tests `$ObjVec` and returns `data[i]`,
// and for an array-like `$Object` delegates to `__extern_get(v, ToString(i))`
// (its #2036 arm), so it is a correct superset of the string-key path for a
// numeric index. Scoped to standalone/WASI; host mode keeps the JS fast path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function standaloneNum(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: Record<string, unknown> = {};
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

describe("#2166 PR-C2 — standalone $ObjVec numeric element indexing", () => {
  it("Object.values(obj)[i] reads the positional value (was 0)", async () => {
    expect(
      await standaloneNum(`const o: any = { a: 5, b: 9 }; const v: any = Object.values(o); return v[1] as number;`),
    ).toBe(9);
  });

  it("Object.values(obj)[i] first element", async () => {
    expect(
      await standaloneNum(`const o: any = { a: 5, b: 9 }; const v: any = Object.values(o); return v[0] as number;`),
    ).toBe(5);
  });

  it("a numeric variable index also routes positionally", async () => {
    expect(
      await standaloneNum(
        `const o: any = { a: 5, b: 9, c: 12 }; const v: any = Object.values(o); const i = 2; return v[i] as number;`,
      ),
    ).toBe(12);
  });

  it(".length still works alongside the indexed read", async () => {
    expect(
      await standaloneNum(`const o: any = { a: 5, b: 9 }; const v: any = Object.values(o); return v.length as number;`),
    ).toBe(2);
  });

  it("an out-of-bounds index returns the null/absent sentinel, not a trap", async () => {
    // v[5] on a 2-element vec → `__extern_get_idx` returns the null externref
    // (matching the host import's null/undefined fallback) — no trap. ToNumber
    // of the standalone null sentinel is 0, so the read is well-defined.
    expect(
      await standaloneNum(`const o: any = { a: 5, b: 9 }; const v: any = Object.values(o); return v[5] as number;`),
    ).toBe(0);
  });

  it("a string-keyed dynamic read is unaffected (stays on __extern_get)", async () => {
    // o["a"] on a real $Object still resolves by string key.
    expect(await standaloneNum(`const o: any = { a: 7 }; const k = "a"; return o[k] as number;`)).toBe(7);
  });
});
