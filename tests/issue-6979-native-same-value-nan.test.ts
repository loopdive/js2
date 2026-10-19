// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { descriptorRuntime } from "./helpers/native-descriptor-fixture.js";

const patterns = [0x7ff8000000000001n, 0x7ff8000000000002n, 0xfff8000000000001n] as const;
function fromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
}
function bitsOf(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
const controls = [
  [0, -0],
  [-0, 0],
  [0, 0],
  [-0, -0],
  [42, 42],
  [42, 43],
  [Infinity, Infinity],
  [Infinity, -Infinity],
  [Number.MIN_VALUE, 0],
] as const;
for (const displaced of [false, true])
  describe("native SameValue and frozen data descriptors, displaced=" + displaced, () => {
    let r: ReturnType<typeof descriptorRuntime>;
    beforeAll(() => {
      r = descriptorRuntime(displaced);
    });

    const redefine = (a: unknown, b: unknown): boolean => {
      const object = r.create();
      r.defineData(object, r.key(), a, 128); // value present, non-writable/non-configurable.
      try {
        r.defineData(object, r.key(), b, 128);
        return true;
      } catch (error) {
        expect(error instanceof WebAssembly.Exception).toBe(true);
        expect((error as WebAssembly.Exception).is(r.exception)).toBe(true);
        return false;
      }
    };
    for (const a of patterns)
      for (const b of patterns)
        it(`equates actual distinct NaN payloads ${a.toString(16)}/${b.toString(16)}`, () => {
          const left = r.boxNumber(fromBits(a)),
            right = r.boxNumber(fromBits(b));
          // Positive instrument control: the real native carrier retained these exact bits.
          expect(bitsOf(r.unboxNumber(left))).toBe(a);
          expect(bitsOf(r.unboxNumber(right))).toBe(b);
          expect(Object.is(fromBits(a), fromBits(b))).toBe(true);
          expect(r.sameValue(left, right)).toBe(1);
          expect(redefine(left, right)).toBe(true);
          const host = {};
          Object.defineProperty(host, "value", { value: fromBits(a) });
          expect(() => Object.defineProperty(host, "value", { value: fromBits(b) })).not.toThrow();
        });

    it.each(controls)("preserves finite/signed-zero/infinite equality for %s and %s", (a, b) => {
      const left = r.boxNumber(a),
        right = r.boxNumber(b);
      const equal = Object.is(a, b);
      expect(r.sameValue(left, right)).toBe(Number(equal));
      expect(redefine(left, right)).toBe(equal);
    });

    it("never equates NaN to a non-NaN number in either operand order", () => {
      for (const bits of patterns)
        for (const value of [0, -0, 42, Infinity, -Infinity, Number.MIN_VALUE]) {
          const nan = r.boxNumber(fromBits(bits)),
            finite = r.boxNumber(value);
          expect(r.sameValue(nan, finite)).toBe(0);
          expect(r.sameValue(finite, nan)).toBe(0);
          expect(redefine(nan, finite)).toBe(false);
          expect(redefine(finite, nan)).toBe(false);
        }
    });

    it("does not coerce undefined, null or Boolean carriers into a numeric NaN", () => {
      const nan = r.boxNumber(fromBits(patterns[0]));
      for (const other of [r.undefinedValue(), null, r.boxBoolean(0), r.boxBoolean(1), r.wide64()]) {
        expect(r.sameValue(nan, other)).toBe(0);
        expect(r.sameValue(other, nan)).toBe(0);
        expect(redefine(nan, other)).toBe(false);
        expect(redefine(other, nan)).toBe(false);
      }
      expect(r.sameValue(r.undefinedValue(), r.undefinedValue())).toBe(1);
      expect(r.sameValue(null, null)).toBe(1);
    });
  });
