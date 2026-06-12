// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1962 — spreading a string in an array literal (`[..."ab"]`) must iterate the
 * string's CODE POINTS, not silently yield an empty array, on the pure-WasmGC
 * standalone backend (§13.2.5.5 ArrayAccumulation → string iterator).
 *
 * The miscompile (empty array) was resolved on main before this regression
 * guard landed; these cases lock in the spread → code-point behaviour so it
 * can't silently regress. Validated against Node semantics via length / element
 * code-unit reads.
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

describe("#1962 array-literal string spread iterates code points (standalone)", () => {
  it('[..."ab"].length === 2', async () => {
    expect(await runNum(`return [..."ab"].length;`)).toBe(2);
  });

  it("spread elements are the individual characters", async () => {
    expect(await runNum(`return [..."ab"][0].charCodeAt(0);`)).toBe(97); // 'a'
    expect(await runNum(`return [..."ab"][1].charCodeAt(0);`)).toBe(98); // 'b'
  });

  it("empty string spreads to an empty array", async () => {
    expect(await runNum(`return [...""].length;`)).toBe(0);
  });

  it("non-BMP code point counts as one element (not two surrogates)", async () => {
    expect(await runNum(`return [..."a😀"].length;`)).toBe(2);
  });

  it("multiple spreads concatenate", async () => {
    expect(await runNum(`return [..."ab", ..."cde"].length;`)).toBe(5);
  });

  it("spread mixed with literal elements", async () => {
    expect(await runNum(`return ["x", ..."ab", "y"].length;`)).toBe(4);
  });
});
