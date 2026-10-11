// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6642 (#5383 S61) — native StringToBigInt for `--target standalone`.
//
// WHAT THIS WITNESSES. `__bigint_ctor`'s standalone body (registry/imports.ts)
// ended in `throw SyntaxError "Cannot convert string to a BigInt in standalone
// mode"` for every string operand, so `BigInt(<string variable>)` was a hard
// throw — the literal spellings that appeared to work are compile-time folds in
// `call-identifier.ts`, not the runtime helper (measured S60, re-measured S61).
// The scan is now real: §7.1.14 StringToBigInt / StringIntegerLiteral, spliced
// inline into `__bigint_ctor` and accumulating straight into the i64 the
// `$BigInt` carrier holds.
//
// PRECISION IS THE POINT, which is why the headline case is an 18-digit
// nanosecond epoch: routing through `__str_to_number` + `i64.trunc_sat_f64_s`
// would answer `217175010123456792`. An f64 carries ~15.95 significant decimal
// digits; this value has 18.
//
// Revert-and-measure against `10873df1e0` (the S59+S60 head this branch starts
// from) is recorded in `plan/issues/6642-link-bigint-value-survival.md`'s S61
// section: every TEETH case below throws SyntaxError on that tree.
//
// NOT witnessed here, deliberately: `globalThis.BigInt` (the realm-level
// constructor) is still absent under standalone. Its two links were built and
// measured in S61 and then held back — alone they turn the target ZonedDateTime
// rows from a wrong value into a thrown TypeError, because a FIFTH link
// (`<any>.toString(radix)` on a number/bigint receiver) is missing. See the
// issue's S61 section for the measurements and the exact next step.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Compile+run a standalone module whose single export answers a NUMBER.
 *
 * Numeric, never a string: a string-returning standalone export does not
 * marshal out of the instance (it reads `undefined` on the host side), which is
 * how an earlier probe in this issue mistook every answer for "absent".
 */
async function run(body: string): Promise<number> {
  const source = `export function f(): number {
    try { ${body} } catch (e) {
      if (e instanceof SyntaxError) return 2;
      if (e instanceof TypeError) return 3;
      return 4;
    }
  }`;
  const result = await compile(source, STANDALONE);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const instance = await WebAssembly.instantiate(new WebAssembly.Module(result.binary), {});
  return (instance.exports as { f: () => number }).f();
}

/** `const s: any = <literal>` defeats the compile-time fold in call-identifier.ts. */
const via = (text: string): string => `const s: any = ${JSON.stringify(text)};`;

describe("#6642 native StringToBigInt under --target standalone", () => {
  it("parses a decimal string EXACTLY, past the f64 significand", { timeout: 300_000 }, async () => {
    // TEETH — SyntaxError on `10873df1e0`.
    expect(await run(`${via("217175010123456789")} return BigInt(s) === 217175010123456789n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("12")} return BigInt(s) === 12n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("-42")} return BigInt(s) === -42n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("+7")} return BigInt(s) === 7n ? 1 : 0;`)).toBe(1);
  });

  it("trims StrWhiteSpace and answers 0n for an empty literal", { timeout: 300_000 }, async () => {
    expect(await run(`${via("  9  ")} return BigInt(s) === 9n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("   ")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(1);
  });

  it("reads the three NonDecimalIntegerLiteral prefixes", { timeout: 300_000 }, async () => {
    expect(await run(`${via("0x10")} return BigInt(s) === 16n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("0XFF")} return BigInt(s) === 255n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("0o17")} return BigInt(s) === 15n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("0b101")} return BigInt(s) === 5n ? 1 : 0;`)).toBe(1);
    // "0" is NOT a radix prefix, and a leading zero is an ordinary decimal digit.
    expect(await run(`${via("0")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(1);
    expect(await run(`${via("09")} return BigInt(s) === 9n ? 1 : 0;`)).toBe(1);
  });

  it("throws SyntaxError on anything that is not a whole StringIntegerLiteral", { timeout: 300_000 }, async () => {
    // GUARDS — these must NOT become a silent answer. `BigInt` is not
    // `parseInt`: there is no longest-prefix rule, so "12abc" is a throw.
    expect(await run(`${via("12abc")} return BigInt(s) === 12n ? 1 : 0;`)).toBe(2);
    expect(await run(`${via("1.5")} return BigInt(s) === 1n ? 1 : 0;`)).toBe(2);
    expect(await run(`${via("1e3")} return BigInt(s) === 1000n ? 1 : 0;`)).toBe(2);
    expect(await run(`${via("0x")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(2);
    expect(await run(`${via("+")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(2);
    // A sign is decimal-only (§7.1.14) — the same rule `Number("-0x10")` obeys.
    expect(await run(`${via("-0x10")} return BigInt(s) === 0n ? 1 : 0;`)).toBe(2);
  });

  it("leaves the non-string operands exactly as they were", { timeout: 300_000 }, async () => {
    // CONTROLS — all three already passed on `10873df1e0` and must not move.
    expect(await run(`const n: any = 12; return BigInt(n) === 12n ? 1 : 0;`)).toBe(1);
    expect(await run(`const b: any = true; return BigInt(b) === 1n ? 1 : 0;`)).toBe(1);
    expect(await run(`const n: any = null; return BigInt(n) === 0n ? 1 : 0;`)).toBe(3);
  });
});
