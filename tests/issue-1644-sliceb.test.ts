import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1644 Slice B — BigInt(value) constructor (§21.2.1.1).
//
// The constructor coerces via ToPrimitive(number); a resulting Number goes
// through NumberToBigInt (RangeError unless a safe integer); anything else
// goes through ToBigInt (StringToBigInt parses hex/octal/binary/decimal and
// throws SyntaxError on malformed input; boolean → 0n/1n; Symbol → TypeError).
describe("#1644 Slice B — BigInt(string|number) constructor", () => {
  it("parses a decimal string", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return BigInt("42");
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("bigint");
    expect(v).toBe(42n);
  });

  it("parses hex / octal / binary strings", async () => {
    const exports = await compileToWasm(`
      export function test(s: any): any {
        return BigInt(s);
      }
    `);
    expect(exports.test("0xff")).toBe(255n);
    expect(exports.test("0o17")).toBe(15n);
    expect(exports.test("0b101")).toBe(5n);
    expect(exports.test("")).toBe(0n);
    expect(exports.test("  42  ")).toBe(42n);
  });

  it("throws SyntaxError on a malformed numeric string", async () => {
    const exports = await compileToWasm(`
      export function test(s: any): any {
        return BigInt(s);
      }
    `);
    expect(() => exports.test("10n")).toThrow(SyntaxError);
    expect(() => exports.test("10.5")).toThrow(SyntaxError);
    expect(() => exports.test("abc")).toThrow(SyntaxError);
  });

  it("throws RangeError on a non-integer number", async () => {
    const exports = await compileToWasm(`
      export function test(n: number): any {
        return BigInt(n);
      }
    `);
    expect(() => exports.test(1.5)).toThrow(RangeError);
    expect(() => exports.test(0.00005)).toThrow(RangeError);
    expect(() => exports.test(NaN)).toThrow(RangeError);
    expect(() => exports.test(Infinity)).toThrow(RangeError);
  });

  it("accepts an integer number", async () => {
    const exports = await compileToWasm(`
      export function test(n: number): any {
        return BigInt(n);
      }
    `);
    expect(exports.test(255)).toBe(255n);
    expect(exports.test(-7)).toBe(-7n);
  });

  it("native integer literal — no host roundtrip, no RangeError", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return BigInt(100);
      }
    `);
    expect(exports.test()).toBe(100n);
  });
});
