// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6656 slice 4 — BigInt values WIDER than 64 bits under `--target standalone`.
//
// WHAT WAS BROKEN. The standalone bigint carrier is one i64, so every value
// past 2^63 wrapped modulo 2^64: `864n * 10n ** 19n` (Temporal's epoch-ns
// limit) became 6923773503929843712, a valid instant, and the three standalone
// Temporal rows that expect a RangeError at that limit never got one. A fourth
// defect sat in front of the third row: unary `-` on a bigint held in a
// reference slot (a script-global `var`) ran ToNumber and answered the NUMBER
// NaN, which the polyfill rejects with "cannot convert number to bigint".
//
// THE FIX. A `$BigIntWide` carrier — a SUBTYPE of `$BigInt` holding sign and
// base-2^32 limbs (src/codegen/bigint-wide.ts). Constant bigint expressions
// whose i64 lowering would wrap are evaluated exactly at compile time; a wide
// result is materialised as the new carrier wherever the context holds a
// reference. ToString (narrowed `x.toString(r)`, `String(x)`, the dynamic
// routes), `===`, unary `-` on a carrier, `BigInt(x)` into a reference slot
// (a runtime string past 2^63, or a carrier), and `BigUint64Array` /
// `getBigUint64` reads into a reference slot are exact across the boundary.
//
// Every probe routes values through helpers that also see a NON-bigint call
// site, so their parameters are reference slots (`any`), not i64 — the i64
// lane still wraps, by design, and is not what this file measures.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object; every probe
// answers a number (1 = spec answer), because a standalone string is a WasmGC
// array the host cannot read.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const SOURCE = `
  function Lo(t) { let n = t; if (typeof n === "number") return "num"; if (typeof n === "bigint") return n.toString(10); return "other"; }
  function LoS(t) { let n = t; if (typeof n === "bigint") return String(n); return "other"; }
  function Ty(t) { return typeof t; }
  function Str(t) { return String(t); }
  function Rad(t, r) { return t.toString(r); }
  function Eq(a, b) { return a === b; }
  function NegLo(t) { return Lo(-(/** @type {bigint} */ (t))); }
  function NegEq(t, u) { return Eq(-(/** @type {bigint} */ (t)), u); }
  function Ctor(t) { return Eq(BigInt(t), t); }

  // Controls: the same helpers on ordinary values (also what makes their
  // parameters reference slots).
  export function controls() {
    return Lo("x") === "other" && LoS("x") === "other" && Str("s") === "s" && Rad(255, 16) === "ff" &&
      Ty("s") === "string" && Eq("a", "a") && NegLo(3) === "num" && !NegEq(3, "x") &&
      Lo(5n) === "5" && Eq(5n, 5n) && !Eq(5n, 6n) && Lo(9007199254740993n) === "9007199254740993" &&
      Rad(-255n, 16) === "-ff" && !Ctor(1) && Ctor(7n) ? 1 : 0;
  }

  // ToString of a wide value, every route.
  export function narrowedToString() { return Lo(864n * 10n ** 19n) === "8640000000000000000000" ? 1 : 0; }
  export function narrowedToStringNeg() { return Lo(-(864n * 10n ** 19n)) === "-8640000000000000000000" ? 1 : 0; }
  export function narrowedString() { return LoS(2n ** 64n) === "18446744073709551616" ? 1 : 0; }
  export function dynamicString() { return Str(2n ** 70n) === "1180591620717411303424" ? 1 : 0; }
  export function radix16() { return Rad(2n ** 70n, 16) === "400000000000000000" ? 1 : 0; }
  export function radix2() { return Rad(-(2n ** 64n) - 1n, 2) === "-1" + "0".repeat(63) + "1" ? 1 : 0; }
  export function radix36() { return Rad(864n * 10n ** 19n, 36) === "1eneo3mngujl6o0" ? 1 : 0; }
  export function literalPastI64() { return Lo(18446744073709551617n) === "18446744073709551617" ? 1 : 0; }
  export function stillBigint() { return Ty(2n ** 70n) === "bigint" ? 1 : 0; }

  // === is BigInt::equal, not a comparison of the low 64 bits.
  export function eqSame() { return Eq(2n ** 64n, 18446744073709551616n) ? 1 : 0; }
  export function eqLowBitsDiffer() { return Eq(2n ** 64n, 0n) ? 0 : 1; }
  export function eqSignDiffers() { return Eq(2n ** 64n, -(2n ** 64n)) ? 0 : 1; }

  // Unary minus on a carrier in a reference slot — it answered the NUMBER NaN
  // even for a small value — and exact across the i64 boundary.
  export function negSmall() { return NegEq(5n, -5n) && NegLo(5n) === "-5" ? 1 : 0; }
  export function negWide() { return NegLo(864n * 10n ** 19n) === "-8640000000000000000000" ? 1 : 0; }
  export function negPromotesMin() { return NegLo(-9223372036854775808n) === "9223372036854775808" ? 1 : 0; }
  export function negDemotesToMin() { return NegEq(9223372036854775808n, -9223372036854775808n) ? 1 : 0; }

  // Constant folding: exact comparisons, and an exact i64 result when only an
  // intermediate step left the i64 range.
  export function constantCompare() { return (2n ** 64n === 0n) === false && 2n ** 64n > 2n ** 63n && -(2n ** 64n) < 0n ? 1 : 0; }
  export function foldedCalls() {
    return Eq(BigInt("18446744073709551616"), 2n ** 64n) &&
      Eq(BigInt.asIntN(65, 0xabcdef0123456789abcdefn), -0xfedcba9876543211n) &&
      Eq(BigInt.asUintN(200, -1n), 2n ** 200n - 1n) &&
      BigInt.asIntN(64, 0xabcdef0123456789abcdefn) === 0x0123456789abcdefn ? 1 : 0;
  }

  // BigInt(string) built at runtime, and BigInt(wide), into a reference slot.
  export function runtimeParseBinary() {
    let s = "0b1";
    for (let i = 0; i < 128; i++) s += "0";
    return Eq(BigInt(s), 2n ** 128n) && !Eq(BigInt(s), 0n) ? 1 : 0;
  }
  export function runtimeParseForms() {
    return Eq(BigInt(" 0x" + "f".repeat(20) + "\\n"), 16n ** 20n - 1n) &&
      Eq(BigInt("-" + "9".repeat(30)), -(10n ** 30n - 1n)) &&
      Eq(BigInt("0O" + "7".repeat(30)), 8n ** 30n - 1n) &&
      Eq(BigInt("+" + "18446744073709551617"), 18446744073709551617n) ? 1 : 0;
  }
  export function runtimeParseStaysCanonical() {
    return Eq(BigInt("-" + "9223372036854775808"), -9223372036854775808n) &&
      Eq(BigInt("0x" + "7fffffffffffffff"), 9223372036854775807n) && Ctor(-5n) ? 1 : 0;
  }
  // A 64-bit UNSIGNED read into a reference slot is the unsigned value.
  export function unsignedReads() {
    const u = new BigUint64Array(2);
    u[0] = -2n;
    u[1] = 5n;
    const s = new BigInt64Array(1);
    s[0] = -2n;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigInt64(0, -2n);
    return Eq(u[0], 18446744073709551614n) && Eq(u[1], 5n) && Eq(s[0], -2n) &&
      Eq(dv.getBigUint64(0), 2n ** 64n - 2n) && Eq(dv.getBigInt64(0), -2n) ? 1 : 0;
  }
  export function ctorOfWide() { return Ctor(2n ** 70n) && Ctor(-(2n ** 64n)) ? 1 : 0; }

  export function foldBackIntoI64() { return (2n ** 64n) / (2n ** 35n) === 536870912n && (2n ** 64n - 1n) % 7n === 1n ? 1 : 0; }
`;

async function exportsOf(): Promise<Record<string, () => unknown>> {
  const entry = "/__main.js";
  const result = await compileMulti({ [entry]: SOURCE }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "off",
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

const ROWS = [
  "narrowedToString",
  "narrowedToStringNeg",
  "narrowedString",
  "dynamicString",
  "radix16",
  "radix2",
  "radix36",
  "literalPastI64",
  "stillBigint",
  "eqSame",
  "eqLowBitsDiffer",
  "eqSignDiffers",
  "negSmall",
  "negWide",
  "negPromotesMin",
  "negDemotesToMin",
  "constantCompare",
  "foldedCalls",
  "runtimeParseBinary",
  "runtimeParseForms",
  "runtimeParseStaysCanonical",
  "ctorOfWide",
  "unsignedReads",
  "foldBackIntoI64",
] as const;

describe("#6656 slice 4 — standalone BigInt past 64 bits", () => {
  let exports: Record<string, () => unknown>;

  it("compiles host-free, and the controls hold", async () => {
    exports = await exportsOf();
    expect(exports.controls!()).toBe(1);
  }, 60_000);

  for (const row of ROWS) {
    it(row, () => {
      expect(exports[row]!()).toBe(1);
    });
  }
});
