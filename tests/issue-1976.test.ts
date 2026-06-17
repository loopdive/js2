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
 *  3. `.length` returned the UTF-8 BYTE count, not the JS UTF-16 code-unit
 *     count (`"é世😀".length` → 9, Node → 4). The user-facing `.length` property
 *     now routes through a new `__str_length_utf16` runtime fn that scans the
 *     UTF-8 bytes and counts code units (astral code points = 2). The internal
 *     `__str_len` (byte count) is unchanged — slice/indexOf still index by
 *     byte. (Full code-unit-offset slice/charCodeAt is the larger follow-up.)
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

  describe(".length returns UTF-16 code units, not UTF-8 bytes", () => {
    // [source string, expected JS .length]. Each expected value === the same
    // string's `.length` in Node (UTF-16 code units).
    const cases: Array<[string, number]> = [
      ["hello", 5], // ASCII: 1 byte = 1 code unit (unchanged)
      ["", 0], // empty
      ["é", 1], // U+00E9: 2 UTF-8 bytes, 1 code unit
      ["世", 1], // U+4E16: 3 UTF-8 bytes, 1 code unit
      ["😀", 2], // U+1F600: 4 UTF-8 bytes, astral → surrogate pair (2 units)
      ["é世😀", 4], // 1 + 1 + 2 (the issue's headline repro: was 9)
      ["😀😀", 4], // 2 astral code points → 4 code units (was 8)
      ["a😀b", 4], // mixed ASCII + astral: 1 + 2 + 1
    ];
    for (const [s, want] of cases) {
      it(`${JSON.stringify(s)}.length -> ${want}`, async () => {
        // The literal is embedded directly; the linear string stores it as UTF-8.
        expect(await runLinear(`const s = ${JSON.stringify(s)}; return s.length;`)).toBe(want);
      });
    }

    it(".length of a concatenated multi-byte string counts code units", async () => {
      // "é" (1) + "😀" (2) → 3 code units; exercises length-after-__str_concat.
      expect(await runLinear(`const a = "é" + "😀"; return a.length;`)).toBe(3);
    });
  });
});
