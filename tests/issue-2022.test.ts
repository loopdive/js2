// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2022 — the `+` operator pre-committed to the STRING hint when one operand
// was a string, so an object with both `valueOf` and `toString` stringified via
// `toString`. Per §13.15.3, `+` applies ToPrimitive with the DEFAULT hint
// (valueOf before toString) to both operands BEFORE deciding concat vs add —
// even when the other operand is a string. So `objWithValueOf + ""` is "7"
// (valueOf), not "P!" (toString).
//
// Fix: object/`any` operands of `+` route through a new
// `__extern_to_string_default` host helper (ToPrimitive default hint) instead
// of `__extern_toString` / `coerceType(..., "string")` (string hint). Template
// literals and `String()` keep the string hint; relational/`-`/`*` keep the
// number hint — all unchanged.
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

const P = `class P { toString(): string { return "P!"; } valueOf(): number { return 7; } }`;
const Q = `class Q { toString(): string { return "Q!"; } }`;

describe("#2022 `+` uses ToPrimitive(default), not string hint", () => {
  it('obj with valueOf + "" uses valueOf (not toString)', async () => {
    expect(await run(`${P} export function test(): string { return (new P() as any) + ""; }`)).toBe("7"); // node: "7"
  });

  it("string + obj with valueOf uses valueOf", async () => {
    expect(await run(`${P} export function test(): string { return "x" + (new P() as any); }`)).toBe("x7"); // node: "x7"
  });

  it("a 3-operand concat chain applies the default hint to the object", async () => {
    expect(await run(`${P} export function test(): string { return "a" + (new P() as any) + "b"; }`)).toBe("a7b"); // node: "a7b"
  });

  it("obj with only toString still concats via toString", async () => {
    expect(await run(`${Q} export function test(): string { return (new Q() as any) + ""; }`)).toBe("Q!"); // node: "Q!"
  });

  it("template literals keep the STRING hint (toString)", async () => {
    expect(await run(`${P} export function test(): string { const p = new P(); return \`\${p}\`; }`)).toBe("P!"); // node: "P!"
  });

  it("relational comparison keeps the NUMBER hint (valueOf)", async () => {
    expect(await run(`${P} export function test(): number { const p = new P(); return (p as any) > 5 ? 1 : 0; }`)).toBe(
      1,
    ); // node: 7 > 5 → true
  });

  it("Symbol.toPrimitive overrides the hint when present", async () => {
    const src = `
      class R {
        [Symbol.toPrimitive](hint: string): any { return hint === "string" ? "STR" : 42; }
      }
      export function test(): string { return (new R() as any) + ""; }`;
    expect(await run(src)).toBe("42"); // node: default hint → 42 → "42"
  });
});
