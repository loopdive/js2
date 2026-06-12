// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1975 — linear-backend ToBoolean was wrong for strings. A string value is an
 * i32 POINTER (always nonzero), so `emitTruthyCoercion`'s i32 branch left it
 * unchanged and every string — including `""` — was truthy. JS
 * ToBoolean(string) is `length !== 0`, so `""` must be falsy.
 *
 * (The NaN case — `f64.abs(x) > 0` — was already fixed by #1937; this guards it
 * too.) The coercion feeds `if`/`while`/`for`/ternary and the left operand of
 * `&&`/`||`, so a string condition now branches correctly in every position.
 *
 * Validated on `target: "linear"` against Node ToBoolean semantics.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLinear(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { fileName: "test.ts", target: "linear" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#1975 linear backend ToBoolean for strings and NaN", () => {
  it("empty string is falsy in an `if`", async () => {
    expect(await runLinear(`const s = ""; if (s) return 1; return 0;`)).toBe(0);
  });

  it("a non-empty string is truthy", async () => {
    expect(await runLinear(`const s = "a"; if (s) return 1; return 0;`)).toBe(1);
  });

  it("NaN is falsy (regression guard for #1937)", async () => {
    expect(await runLinear(`const x = 0 / 0; if (x) return 1; return 0;`)).toBe(0);
  });

  it("0 and -0 are falsy, nonzero numbers truthy", async () => {
    expect(await runLinear(`const x = 0; if (x) return 1; return 0;`)).toBe(0);
    expect(await runLinear(`const x = -0; if (x) return 1; return 0;`)).toBe(0);
    expect(await runLinear(`const x = 5; if (x) return 1; return 0;`)).toBe(1);
  });

  it("empty string is falsy as a `while` condition", async () => {
    expect(await runLinear(`let s = ""; let n = 0; while (s) { n++; break; } return n;`)).toBe(0);
  });

  it("empty string is falsy in a ternary", async () => {
    expect(await runLinear(`const s = ""; return s ? 1 : 0;`)).toBe(0);
  });

  it("string truthiness drives && / || short-circuit (boolean context)", async () => {
    // "" is falsy, so `"" && 1` short-circuits to falsy; `"" || 1` takes the RHS.
    expect(await runLinear(`const s = ""; if (s && 1) return 1; return 0;`)).toBe(0);
    expect(await runLinear(`const s = ""; if (s || 1) return 1; return 0;`)).toBe(1);
    // "a" is truthy, so `"a" && 1` proceeds to the RHS.
    expect(await runLinear(`const s = "a"; if (s && 1) return 1; return 0;`)).toBe(1);
  });

  it("string .length still works (coercion does not disturb length reads)", async () => {
    expect(await runLinear(`const s = "abc"; return s.length;`)).toBe(3);
    expect(await runLinear(`const s = ""; return s.length;`)).toBe(0);
  });
});
