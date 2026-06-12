// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2125 — native (standalone) `String.prototype.split(sep, limit)` ignored the
 * `limit` argument (§22.1.3.23): it was never compiled, so the result was never
 * capped, and `split(undefined)` produced an invalid Wasm module.
 *
 * `__str_split` now takes an i32 `limit` param (0xFFFFFFFF = no limit; 0 → []),
 * and the call site compiles `arguments[1]` (ToUint32) or passes -1. Validated
 * against Node on the pure-WasmGC standalone backend.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNum(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2125 native String.prototype.split honours the limit argument", () => {
  it('"a,b,c".split(",", 2).length === 2', async () => {
    expect(await runNum(`return "a,b,c".split(",", 2).length;`)).toBe(2);
  });

  it('"a,b".split(",", 0).length === 0 (empty array)', async () => {
    expect(await runNum(`return "a,b".split(",", 0).length;`)).toBe(0);
  });

  it("split with no limit returns all pieces", async () => {
    expect(await runNum(`return "a,b,c".split(",").length;`)).toBe(3);
  });

  it("limit caps but keeps the leading pieces' contents", async () => {
    // "a,b,c".split(",", 2) === ["a", "b"]
    expect(await runNum(`const a = "a,b,c".split(",", 2); return a[0].charCodeAt(0) * 10 + a[1].charCodeAt(0);`)).toBe(
      97 * 10 + 98,
    );
  });

  it("empty-separator split (per-char) respects the limit", async () => {
    expect(await runNum(`return "abcd".split("", 2).length;`)).toBe(2);
    expect(await runNum(`return "abc".split("").length;`)).toBe(3);
  });

  it("limit 1 yields a single piece", async () => {
    expect(await runNum(`return "a,b,c".split(",", 1).length;`)).toBe(1);
  });

  it("the limit expression's side effects run exactly once", async () => {
    expect(await runNum(`let n = 0; const lim = () => { n++; return 2; }; "a,b,c".split(",", lim()); return n;`)).toBe(
      1,
    );
  });
});
