// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1976 — linear-backend string fixes:
 *
 *  1. Relational operators (`<` `<=` `>` `>=`) on strings compared the i32
 *     POINTER addresses instead of the content. They now route through a new
 *     `__str_cmp` runtime fn (lexicographic, -1/0/1).
 *  2. `s += t` and `const x = "a" + b` for string operands produced an INVALID
 *     module (the concat result is an i32 pointer but was typed/added as f64).
 *     String `+=` now calls `__str_concat`, and `inferExprType` treats a string
 *     `+` as an i32 result so the local/global gets the right type.
 *
 * (The UTF-8→UTF-16 `.length` divergence for non-ASCII is a separate, larger
 * storage-strategy change tracked in the issue; ASCII lengths are correct.)
 *
 * Validated on `target: "linear"` against Node.
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

describe("#1976 linear backend string relationals and concat typing", () => {
  describe("relational operators compare by content (not pointer address)", () => {
    const cases: Array<[string, number]> = [
      [`"zzz" < "aaa"`, 0],
      [`"b" < "abc"`, 0],
      [`"aaa" < "zzz"`, 1],
      [`"abc" <= "abc"`, 1],
      [`"abc" < "abd"`, 1],
      [`"abc" > "abb"`, 1],
      [`"ab" < "abc"`, 1], // prefix is "less"
      [`"abc" >= "abc"`, 1],
      [`"b" > "a"`, 1],
      [`"A" < "a"`, 1], // 'A' (65) < 'a' (97)
    ];
    for (const [expr, want] of cases) {
      it(`${expr} -> ${want}`, async () => {
        expect(await runLinear(`return ${expr} ? 1 : 0;`)).toBe(want);
      });
    }
  });

  describe("string concatenation produces a valid module and correct result", () => {
    it("compound assign: s += t", async () => {
      expect(await runLinear(`let s = ""; s += "ab"; return s.length;`)).toBe(2);
      expect(await runLinear(`let s = "x"; s += "yz"; return s.length;`)).toBe(3);
    });

    it("declaration: const a = x + y", async () => {
      expect(await runLinear(`const a = "ab" + "c"; return a.length;`)).toBe(3);
    });

    it("repeated += in a loop builds up correctly", async () => {
      expect(await runLinear(`let s = ""; for (let i = 0; i < 4; i++) s += "x"; return s.length;`)).toBe(4);
    });

    it("concatenated string still compares by content", async () => {
      expect(await runLinear(`const a = "ab" + "c"; return a === "abc" ? 1 : 0;`)).toBe(1);
      expect(await runLinear(`const a = "ab" + "c"; return a < "abd" ? 1 : 0;`)).toBe(1);
    });
  });

  it("ASCII .length is unaffected", async () => {
    expect(await runLinear(`return "hello".length;`)).toBe(5);
  });
});
