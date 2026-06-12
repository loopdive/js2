// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1974 — the linear backend's `%` (PercentToken) arm used to be empty, so a
 * remainder expression left both operands on the stack and silently evaluated
 * to the divisor (`7 % 2` → `2`). The arm now spills to locals and emits
 * `a - trunc(a/b)*b` (sign of the dividend, matching JS for finite operands).
 *
 * Resolved on main (the #1937 fill of the empty arm); these cases lock the
 * behaviour in for `target: "linear"` and guard stack discipline in non-return
 * positions.
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

describe("#1974 linear backend modulo (%) is correct", () => {
  const cases: Array<[string, number]> = [
    ["7 % 2", 1],
    ["-7 % 2", -1], // sign follows the dividend
    ["7 % -2", 1],
    ["5.5 % 2", 1.5],
    ["10 % 3", 1],
    ["9 % 3", 0],
    ["1 % 5", 1],
  ];

  for (const [expr, want] of cases) {
    it(`${expr} === ${want}`, async () => {
      expect(await runLinear(`return ${expr};`)).toBe(want);
    });
  }

  it("% in a non-return position leaves no leftover stack value", async () => {
    // If the arm leaked operands, this multi-statement function would fail to
    // validate (or compute wrong). Both `%` results feed into the sum.
    expect(await runLinear(`const a = 7 % 3; const b = 8 % 5; return a + b;`)).toBe(1 + 3);
  });

  it("% as a loop-body subexpression validates and computes", async () => {
    expect(await runLinear(`let s = 0; for (let i = 0; i < 10; i++) { if (i % 3 === 0) s += i; } return s;`)).toBe(
      0 + 3 + 6 + 9,
    );
  });
});
