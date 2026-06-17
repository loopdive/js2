// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2184 — linear-backend `&&`/`||` discarded the operand value.
 *
 * JS `a || b` ⇒ `ToBoolean(a) ? a : b`; `a && b` ⇒ `ToBoolean(a) ? b : a`.
 * Both yield an *operand*, not a 0/1 boolean. The linear backend's logical
 * lowering coerced its result to f64 and pushed the constants `0`/`1` on the
 * short-circuit arm, so `"" || "x"` returned `0` instead of `"x"` and
 * `0 || 42` returned `1` instead of `42`.
 *
 * The fix tees the LHS into a temp and yields the actual operand value, with
 * the `if` result type unified to the (same-typed) operand ValType. Mixed-type
 * operands (string `i32` vs number `f64`) keep the legacy boolean-producing
 * lowering — they can't share a single `if` result type without a boxed
 * representation, and that path is correct in boolean context (#1975). Covering
 * mixed-type *values* is carved out as a follow-up.
 *
 * The boolean-context use (#1975, PR #1412) must stay correct — guarded here.
 *
 * Validated on `target: "linear"` against Node operand-value semantics.
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

describe("#2184 linear backend && / || yield the operand value", () => {
  it("|| yields the RHS when the LHS is falsy (numeric)", async () => {
    expect(await runLinear(`const r = 0 || 42; return r;`)).toBe(42);
  });

  it("|| yields the LHS when it is truthy (numeric)", async () => {
    expect(await runLinear(`const r = 5 || 42; return r;`)).toBe(5);
  });

  it("&& yields the RHS when the LHS is truthy (numeric)", async () => {
    expect(await runLinear(`const r = 3 && 7; return r;`)).toBe(7);
  });

  it("&& yields the LHS when it is falsy (numeric)", async () => {
    expect(await runLinear(`const r = 0 && 7; return r;`)).toBe(0);
  });

  it("|| yields the RHS string operand when the LHS string is empty", async () => {
    // "" is falsy → r === "x", length 1.
    expect(await runLinear(`const r = "" || "x"; return r.length;`)).toBe(1);
  });

  it("&& yields the RHS string operand when the LHS string is truthy", async () => {
    // "a" is truthy → r === "bb", length 2.
    expect(await runLinear(`const r = "a" && "bb"; return r.length;`)).toBe(2);
  });

  it("|| yields the (truthy) LHS string operand", async () => {
    expect(await runLinear(`const r = "ab" || "x"; return r.length;`)).toBe(2);
  });

  it("&& yields the (falsy, empty) LHS string operand", async () => {
    expect(await runLinear(`const r = "" && "x"; return r.length;`)).toBe(0);
  });

  it("chains evaluate left-to-right and yield the final operand", async () => {
    expect(await runLinear(`const r = 0 || 0 || 9; return r;`)).toBe(9);
    expect(await runLinear(`const r = 1 && 2 && 3; return r;`)).toBe(3);
  });

  it("the operand value flows into a typed local", async () => {
    expect(await runLinear(`let x = 0 || 7; x = x + 1; return x;`)).toBe(8);
  });

  // ── boolean-context regression guards (#1975 path must stay correct) ──
  it("numeric boolean-context && / || unchanged", async () => {
    expect(await runLinear(`if (0 || 5) return 1; return 0;`)).toBe(1);
    expect(await runLinear(`if (3 && 0) return 1; return 0;`)).toBe(0);
  });

  it("mixed string/number boolean-context unchanged (#1975)", async () => {
    expect(await runLinear(`const s = "a"; if (s && 2) return 1; return 0;`)).toBe(1);
    expect(await runLinear(`const s = ""; if (s || 0) return 1; return 0;`)).toBe(0);
  });
});
