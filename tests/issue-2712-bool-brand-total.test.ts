// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

// #2712 (I1+I2) — the optional i32 boolean brand made TOTAL at producers.
//
// Before: comparison/equality/relational/in/instanceof results were born
// brandless `{kind:"i32"}` (only literals #2795 + declared storage branded), so
// a computed predicate boxed into a Set/Map key/element or a property key reified
// as the *number* 1/0 — `new Set([(n<2)]).has(1)` was wrongly true.
//
// Fix: (I1) brand those comparison results at the single dispatch chokepoint
// (expressions.ts `BOOLEAN_PRODUCING_BINARY_OPS`), and (I2) route the Set/Map
// key/element coercion (map-runtime.ts) through `__box_boolean` when branded.
// Arithmetic/bitwise/logical results are NOT branded.

async function run<T>(src: string): Promise<T> {
  const exports = await compileAndInstantiate(src);
  return (exports as { f: () => T }).f();
}

describe("#2712 boolean brand-total at producers", () => {
  describe("the live repro — computed predicate into Set/Map", () => {
    it("new Set([(n<2)]).has(1) === false (boolean element, not number 1)", async () => {
      expect(
        await run(`export function f(): number {
          const n = 1;
          return new Set<any>([(n < 2) as any]).has(1) ? 1 : 0;
        }`),
      ).toBe(0);
    });

    it("new Set([(n<2)]).has(true) === true", async () => {
      expect(
        await run(`export function f(): number {
          const n = 1;
          return new Set<any>([(n < 2) as any]).has(true) ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("Map key (n<2) is a boolean: get(true)===v, get(1)===undefined", async () => {
      expect(
        await run(`export function f(): number {
          const n = 1;
          const m = new Map<any, number>();
          m.set((n < 2) as any, 42);
          return (m.get(true) ?? 0) * 100 + (m.get(1) ?? 7); // 42*100 + 7 (miss) = 4207
        }`),
      ).toBe(4207);
    });

    it("`in`-operator result boxed into a Set is a boolean", async () => {
      expect(
        await run(`export function f(): number {
          const o = { x: 1 };
          const b: any = ("x" in o);
          return new Set<any>([b]).has(true) ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("equality (===) result boxed into a Set is a boolean", async () => {
      expect(
        await run(`export function f(): number {
          const b: any = (1 === 1);
          return new Set<any>([b]).has(1) ? 1 : 0; // false — element is boolean true
        }`),
      ).toBe(0);
    });
  });

  describe("brand is structurally inert — no arithmetic/branch regression", () => {
    it("number Set key is unaffected: has(1) true, has(true) false", async () => {
      expect(
        await run(`export function f(): number {
          const s = new Set<any>([1]);
          return (s.has(1) ? 1 : 0) * 10 + (s.has(true) ? 1 : 0);
        }`),
      ).toBe(10);
    });

    it("comparison as a branch condition still works", async () => {
      expect(await run(`export function f(): number { const n = 3; if (n < 5) return 7; return 0; }`)).toBe(7);
    });

    it("comparison used in arithmetic still coerces to number 1/0", async () => {
      expect(await run(`export function f(): number { return ((2 < 3) as any) + 1; }`)).toBe(2);
    });

    it("arithmetic result into a Set stays a number", async () => {
      expect(
        await run(`export function f(): number {
          const x = 1;
          return new Set<any>([x + 0]).has(1) ? 1 : 0; // number 1 → true
        }`),
      ).toBe(1);
    });
  });

  describe("typeof + property-key + Object.values behavioral set", () => {
    it("typeof a computed predicate is 'boolean'", async () => {
      expect(await run(`export function f(): string { const b: any = (1 === 1); return typeof b; }`)).toBe("boolean");
    });

    it("o[true] keys 'true' (not '1')", async () => {
      expect(
        await run(`export function f(): string { const o: any = {}; o[true] = "T"; return o["true"] ?? "MISS"; }`),
      ).toBe("T");
    });

    it("Object.values({a:true})[0] === true", async () => {
      expect(
        await run(`export function f(): number {
          const v: any = Object.values({ a: true });
          return v[0] === true ? 1 : 0;
        }`),
      ).toBe(1);
    });
  });
});
