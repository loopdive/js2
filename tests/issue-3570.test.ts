// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3570 — standalone Number('+0x10') must be NaN (residual of #1836).
// A NonDecimalIntegerLiteral (0x/0o/0b) admits NO leading sign per §7.1.4.1
// StringToNumber. The '-' case was already NaN (#1836); this covers the '+'
// residual, which previously parsed the radix value (Number('+0x10') → 16).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function evalStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

const num = (expr: string) => `export function test(): number { return Number(${JSON.stringify(expr)}); }`;

describe("#3570 standalone Number() leading-'+' non-decimal literal → NaN", () => {
  it("returns NaN for '+' before a hex/octal/binary prefix", async () => {
    expect(await evalStandalone(num("+0x10"))).toBeNaN();
    expect(await evalStandalone(num("+0X1F"))).toBeNaN();
    expect(await evalStandalone(num("+0o17"))).toBeNaN();
    expect(await evalStandalone(num("+0O17"))).toBeNaN();
    expect(await evalStandalone(num("+0b101"))).toBeNaN();
    expect(await evalStandalone(num("+0B101"))).toBeNaN();
  });

  it("still returns NaN for '-' before a non-decimal prefix (no regression)", async () => {
    expect(await evalStandalone(num("-0x10"))).toBeNaN();
    expect(await evalStandalone(num("-0o17"))).toBeNaN();
    expect(await evalStandalone(num("-0b101"))).toBeNaN();
  });

  it("still parses UNSIGNED non-decimal literals (no regression)", async () => {
    expect(await evalStandalone(num("0x10"))).toBe(16);
    expect(await evalStandalone(num("0o17"))).toBe(15);
    expect(await evalStandalone(num("0b101"))).toBe(5);
  });

  it("still parses signed DECIMAL literals (no regression)", async () => {
    expect(await evalStandalone(num("+12"))).toBe(12);
    expect(await evalStandalone(num("-3.5e2"))).toBe(-350);
    expect(await evalStandalone(num("+0.25"))).toBe(0.25);
    // whitespace-wrapped signed decimal
    expect(await evalStandalone(num("   +42\t"))).toBe(42);
    // a leading-zero decimal (not legacy octal) with a sign
    expect(await evalStandalone(num("+08"))).toBe(8);
  });
});
