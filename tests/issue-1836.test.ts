// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1836 — standalone Number<->String conformance.
// Slice: ToNumber(String) octal (0o/0O) and binary (0b/0B) prefix parsing in
// the no-JS-host path (§7.1.4.1 StringToNumber → NonDecimalIntegerLiteral).
// Previously only the hex (0x/0X) prefix was handled; octal/binary returned NaN.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function evalStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#1836 standalone Number() octal/binary prefix", () => {
  it("parses 0o / 0O octal literals", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o17"); }`)).toBe(15);
    expect(await evalStandalone(`export function test(): number { return Number("0O17"); }`)).toBe(15);
    expect(await evalStandalone(`export function test(): number { return Number("0o0"); }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { return Number("0o777"); }`)).toBe(511);
  });

  it("parses 0b / 0B binary literals", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0b101"); }`)).toBe(5);
    expect(await evalStandalone(`export function test(): number { return Number("0B101"); }`)).toBe(5);
    expect(await evalStandalone(`export function test(): number { return Number("0b0"); }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { return Number("0b1111"); }`)).toBe(15);
  });

  it("still parses 0x / 0X hex literals (no regression)", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0x1F"); }`)).toBe(31);
    expect(await evalStandalone(`export function test(): number { return Number("0XfF"); }`)).toBe(255);
  });

  it("returns NaN for digits out of range for the radix", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o8"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("0b2"); }`)).toBeNaN();
  });

  it("returns NaN when the prefix has no following digit", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("0b"); }`)).toBeNaN();
  });

  it("returns NaN for a signed non-decimal literal (spec: NonDecimalIntegerLiteral is unsigned)", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("-0x1F"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("-0o17"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("-0b101"); }`)).toBeNaN();
  });

  it("treats a leading-zero decimal as decimal, not octal", async () => {
    // "08" is a decimal StrNumericLiteral (8), NOT legacy octal.
    expect(await evalStandalone(`export function test(): number { return Number("08"); }`)).toBe(8);
    expect(await evalStandalone(`export function test(): number { return Number("017"); }`)).toBe(17);
  });

  it("parses plain decimal strings unchanged", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("17"); }`)).toBe(17);
    expect(await evalStandalone(`export function test(): number { return Number("0"); }`)).toBe(0);
  });
});

// Slice: StrWhiteSpace set for ToNumber/parseInt/parseFloat (§19.2.4/.5, §7.1.4.1
// → §11.2 WhiteSpace ∪ §11.3 LineTerminator). Previously only space/tab/LF/VT/
// FF/CR/NBSP were trimmed; the BOM, LS/PS line terminators, and the rest of the
// Zs category were not, so e.g. Number("﻿12") returned NaN.
describe("#1836 standalone whitespace set (ToNumber/parseInt/parseFloat)", () => {
  it("trims the BOM / ZWNBSP (U+FEFF), leading and trailing", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("\\uFEFF12"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("12\\uFEFF"); }`)).toBe(12);
  });

  it("trims LS (U+2028) and PS (U+2029) line terminators", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("\\u202812"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u202912"); }`)).toBe(12);
  });

  it("trims the Zs space-separator category", async () => {
    // OGHAM SPACE, EN QUAD (range start), HAIR SPACE (range end), NARROW/MEDIUM/
    // IDEOGRAPHIC space.
    expect(await evalStandalone(`export function test(): number { return Number("\\u168012"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u200012"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u200a12"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u202f12"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u205f12"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return Number("\\u300012"); }`)).toBe(12);
  });

  it("applies the same set to parseInt and parseFloat", async () => {
    expect(await evalStandalone(`export function test(): number { return parseInt("\\u2028  42"); }`)).toBe(42);
    expect(await evalStandalone(`export function test(): number { return parseFloat("\\uFEFF3.14"); }`)).toBe(3.14);
  });

  it("does not over-trim: ordinary leading space still works, non-ws still rejected", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("  7"); }`)).toBe(7);
    // 'a' (U+0061) is NOT whitespace — must not be skipped, so the parse fails.
    expect(await evalStandalone(`export function test(): number { return Number("a12"); }`)).toBeNaN();
    // A character just outside the Zs range (U+200B ZERO WIDTH SPACE is Cf, not
    // whitespace) must NOT be trimmed.
    expect(await evalStandalone(`export function test(): number { return Number("\\u200b12"); }`)).toBeNaN();
  });
});

// Slice: Number.prototype.toFixed for |x| >= 1e21 (§21.1.3.3 step 5 → ToString).
// Previously the scaled fixed-point path printed a bogus 22-digit integer with a
// spurious fractional part; it must defer to ToString(x).
describe("#1836 standalone toFixed |x| >= 1e21 (§21.1.3.3)", () => {
  async function callStr(method: string): Promise<number> {
    // Returns 1 if toFixed(2) equals toString() AND has no '.' — i.e. the
    // step-5 ToString deferral fired (in-Wasm comparison; native strings aren't
    // JS strings).
    const src = `export function test(): number {
      var x = ${method};
      var a = x.toFixed(2);
      return (a === x.toString() && a.indexOf(".") < 0) ? 1 : 0;
    }`;
    return evalStandalone(src);
  }

  it("defers to ToString for x >= 1e21", async () => {
    expect(await callStr("1e21")).toBe(1);
    expect(await callStr("1e30")).toBe(1);
  });

  it("does not change normal-magnitude toFixed", async () => {
    expect(
      await evalStandalone(`export function test(): number { return (3.14159).toFixed(2) === "3.14" ? 1 : 0; }`),
    ).toBe(1);
    expect(await evalStandalone(`export function test(): number { return (0).toFixed(0) === "0" ? 1 : 0; }`)).toBe(1);
    expect(
      await evalStandalone(`export function test(): number { return (-2.5).toFixed(1) === "-2.5" ? 1 : 0; }`),
    ).toBe(1);
  });
});

// Slice: Number.prototype.toString(radix) for FRACTIONAL values (§6.1.6.1.20,
// §21.1.3.6). Previously the radix formatter only handled integers and TRAPPED
// (`unreachable`) on any non-integer, e.g. (3.5).toString(2). Now the integer
// part is rendered LSB-first then reversed and the fractional part is appended
// MSB-first (multiply-by-radix), up to MAX_FRAC_DIGITS or until exhausted.
describe("#1836 standalone toString(radix) fractional values (§6.1.6.1.20)", () => {
  it("renders fractional binary values (no more unreachable trap)", async () => {
    expect(
      await evalStandalone(`export function test(): number { return (3.5).toString(2) === "11.1" ? 1 : 0; }`),
    ).toBe(1);
    expect(await evalStandalone(`export function test(): number { return (0.5).toString(2) === "0.1" ? 1 : 0; }`)).toBe(
      1,
    );
    expect(
      await evalStandalone(`export function test(): number { return (0.25).toString(2) === "0.01" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("renders a leading 0 for values in (0,1)", async () => {
    // intPart == 0 must still emit "0" before the point.
    expect(await evalStandalone(`export function test(): number { return (0.5).toString(2) === "0.1" ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("handles negative fractional values", async () => {
    expect(
      await evalStandalone(`export function test(): number { return (-3.5).toString(2) === "-11.1" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("renders fractional hex (radix 16)", async () => {
    expect(
      await evalStandalone(`export function test(): number { return (10.5).toString(16) === "a.8" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("does not change integer radix output (no regression)", async () => {
    expect(await evalStandalone(`export function test(): number { return (255).toString(16) === "ff" ? 1 : 0; }`)).toBe(
      1,
    );
    expect(await evalStandalone(`export function test(): number { return (10).toString(2) === "1010" ? 1 : 0; }`)).toBe(
      1,
    );
    expect(
      await evalStandalone(`export function test(): number { return (-255).toString(16) === "-ff" ? 1 : 0; }`),
    ).toBe(1);
    expect(await evalStandalone(`export function test(): number { return (0).toString(2) === "0" ? 1 : 0; }`)).toBe(1);
  });
});

// Slice: strict ToNumber(String) fallback (§7.1.4 → §7.1.4.1 StringToNumber).
// `ToNumber` must parse a full StringNumericLiteral, not the parseFloat longest
// prefix grammar. Previously a dynamic unary + string could reuse parseFloat and
// turn "12abc" into 12 instead of NaN.
describe("#1836 standalone strict ToNumber(String) fallback (§7.1.4.1)", () => {
  it("unary + rejects trailing junk instead of parseFloat-prefixing it", async () => {
    expect(await evalStandalone(`export function test(): number { var s = "12abc"; return +s; }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { var s = "  12abc  "; return +s; }`)).toBeNaN();
  });

  it("Number(string variable) rejects trailing junk through the same StringToNumber path", async () => {
    expect(await evalStandalone(`export function test(): number { var s = "12abc"; return Number(s); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { var s = "Infinityx"; return Number(s); }`)).toBeNaN();
  });

  it("keeps ToNumber-only accepted strings distinct from parseFloat", async () => {
    expect(await evalStandalone(`export function test(): number { var s = ""; return +s; }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { var s = "   "; return +s; }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { var s = "0x10"; return +s; }`)).toBe(16);
    expect(await evalStandalone(`export function test(): number { var s = "0o10"; return +s; }`)).toBe(8);
    expect(await evalStandalone(`export function test(): number { var s = "0b10"; return +s; }`)).toBe(2);
  });

  it("uses StringToNumber for string arithmetic numeric coercion", async () => {
    expect(await evalStandalone(`export function test(): number { var s = "12abc"; return s - 0; }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { var s = "0x10"; return s - 0; }`)).toBe(16);
  });

  it("does not change parseFloat's longest-prefix behavior", async () => {
    expect(await evalStandalone(`export function test(): number { return parseFloat("12abc"); }`)).toBe(12);
    expect(await evalStandalone(`export function test(): number { return parseFloat("0x10"); }`)).toBe(0);
  });
});
