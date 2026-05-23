// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1461 — Array.prototype.* called on array-like / exotic receivers.
 *
 * Spec gap audit: when Array.prototype.METHOD.call(O, ...) is invoked with
 * a generic array-like O (plain object with `.length`, arguments object,
 * boxed String, etc.), several spec corners were wrong in the
 * `src/codegen/array-methods.ts` generic dispatch path.
 *
 * Each test below pins one bullet from the acceptance criteria of the
 * issue file. The covered acceptance bullets are:
 *
 *   1. `length` is read via `ToLength(Get(O, "length"))` — NaN, negative,
 *      and non-integer values clamp to spec-correct iteration bounds.
 *   2. Hole-skipping via HasProperty for forEach/some/every/find/filter/
 *      map and the reducers.
 *   5. indexOf / lastIndexOf use strict-equality semantics: NaN never
 *      matches via indexOf; `includes` finds NaN via SameValueZero.
 *   7. The callback's third argument (`obj`) is the original receiver,
 *      not a coerced copy — `obj === receiver` must hold.
 *
 * Test262 cases this targets (samples):
 *   built-ins/Array/prototype/filter/15.4.4.20-1-15.js
 *   built-ins/Array/prototype/some/15.4.4.17-1-8.js
 *   built-ins/Array/prototype/indexOf/15.4.4.14-2-7.js
 *   built-ins/Array/prototype/every/15.4.4.16-1-15.js
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1461 — Array.prototype.* on array-like / exotic receivers", () => {
  describe("Acceptance bullet 1: ToLength on length", () => {
    it("length=NaN performs 0 iterations", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            let n: number = 0;
            function cb(): boolean { n++; return true; }
            const obj: any = { 0: "a", 1: "b", length: NaN };
            Array.prototype.forEach.call(obj, cb);
            return n;
          }
        `),
      ).toBe(0);
    });

    it("length=-1 performs 0 iterations", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            let n: number = 0;
            function cb(): boolean { n++; return true; }
            const obj: any = { 0: "a", 1: "b", length: -1 };
            Array.prototype.forEach.call(obj, cb);
            return n;
          }
        `),
      ).toBe(0);
    });

    it("length=2.7 truncates toward 0 (2 iterations)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            let n: number = 0;
            function cb(): boolean { n++; return true; }
            const obj: any = { 0: "a", 1: "b", 2: "c", length: 2.7 };
            Array.prototype.forEach.call(obj, cb);
            return n;
          }
        `),
      ).toBe(2);
    });
  });

  describe("Acceptance bullet 2: hole-skipping (HasProperty)", () => {
    it("forEach skips holes on array-like with missing index 0", async () => {
      // {1: 'b', length: 2} has a hole at 0. forEach should visit only idx 1.
      expect(
        await runWasm(`
          export function test(): number {
            let count: number = 0;
            function cb(val: any, idx: number): boolean {
              count++;
              return true;
            }
            const obj: any = { 1: "b", length: 2 };
            Array.prototype.forEach.call(obj, cb);
            return count;
          }
        `),
      ).toBe(1);
    });

    it("every returns true when all PRESENT elements pass (holes ignored)", async () => {
      // {0: 11, 2: 12, length: 3} — index 1 is a hole. every>10 should be true.
      expect(
        await runWasm(`
          export function test(): number {
            function cb(val: any): boolean { return val > 10; }
            const obj: any = { 0: 11, 2: 12, length: 3 };
            return Array.prototype.every.call(obj, cb) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });

  describe("Acceptance bullet 5: strict-equality / SameValueZero", () => {
    it("indexOf(NaN) returns -1 on array-like (strict ===)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = { 0: NaN, length: 1 };
            return Array.prototype.indexOf.call(obj, NaN);
          }
        `),
      ).toBe(-1);
    });

    it("includes(NaN) finds NaN via SameValueZero", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = { 0: NaN, length: 1 };
            return Array.prototype.includes.call(obj, NaN) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("indexOf({1: true, length: 2}, true) returns 1 (hole at 0)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = { 1: true, length: 2 };
            return Array.prototype.indexOf.call(obj, true);
          }
        `),
      ).toBe(1);
    });
  });

  describe("Acceptance bullet 7: callback's third arg is the receiver", () => {
    it("forEach passes original receiver as third arg", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const target: any = { 0: "a", 1: "b", length: 2 };
            let same: number = 0;
            function cb(val: any, idx: number, obj: any): boolean {
              if (obj === target) same++;
              return true;
            }
            Array.prototype.forEach.call(target, cb);
            return same;
          }
        `),
      ).toBe(2);
    });

    it("filter passes original receiver as third arg", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const target: any = { 0: "a", 1: "b", length: 2 };
            let same: number = 0;
            function cb(val: any, idx: number, obj: any): boolean {
              if (obj === target) same++;
              return false;
            }
            Array.prototype.filter.call(target, cb);
            return same;
          }
        `),
      ).toBe(2);
    });
  });

  describe("Core method correctness on array-like receivers", () => {
    it("filter copies elements from array-like", async () => {
      expect(
        await runWasm(`
          export function test(): any {
            function cb(): boolean { return true; }
            const target: any = { 0: "a", 1: "b", length: 2 };
            const newArr: any = Array.prototype.filter.call(target, cb);
            return newArr.length;
          }
        `),
      ).toBe(2);
    });

    it("map applies callback to each element", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            function cb(v: any): number { return v * 2; }
            const obj: any = { 0: 1, 1: 2, 2: 3, length: 3 };
            const r: any = Array.prototype.map.call(obj, cb);
            return r[1];
          }
        `),
      ).toBe(4);
    });

    it("some returns true on first match (array-like)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            function cb(v: any): boolean { return v > 5; }
            const obj: any = { 0: 1, 1: 2, 2: 9, length: 3 };
            return Array.prototype.some.call(obj, cb) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("find returns matching element on array-like", async () => {
      expect(
        await runWasm(`
          export function test(): any {
            function cb(v: any): boolean { return v > 5; }
            const obj: any = { 0: 1, 1: 9, 2: 12, length: 3 };
            return Array.prototype.find.call(obj, cb);
          }
        `),
      ).toBe(9);
    });

    it("findIndex returns index on array-like", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            function cb(v: any): boolean { return v === 9; }
            const obj: any = { 0: 1, 1: 9, 2: 12, length: 3 };
            return Array.prototype.findIndex.call(obj, cb);
          }
        `),
      ).toBe(1);
    });

    it("indexOf forward-search on array-like (presence)", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = { 0: 10, 1: 20, 2: 30, length: 3 };
            return Array.prototype.indexOf.call(obj, 20);
          }
        `),
      ).toBe(1);
    });

    it("lastIndexOf reverse-search on array-like", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = { 0: 10, 1: 20, 2: 20, 3: 30, length: 4 };
            return Array.prototype.lastIndexOf.call(obj, 20);
          }
        `),
      ).toBe(2);
    });
  });

  describe("Acceptance bullet 3: reduce / reduceRight initial-value-absent hole scan", () => {
    // Spec §23.1.3.21 / §23.1.3.22 step 6/7: when `initialValue` is omitted,
    // the accumulator MUST be the first present element (scanned via
    // HasProperty), not blindly `receiver[0]` / `receiver[len-1]`.
    it("reduce no-initial scans past hole at index 0", async () => {
      // {1: 10, 2: 20, length: 3} — acc starts at index 1 (=10), then 10+20=30.
      expect(
        await runWasm(`
          export function test(): number {
            function add(a: any, b: any): number { return a + b; }
            const obj: any = { 1: 10, 2: 20, length: 3 };
            return Array.prototype.reduce.call(obj, add) as number;
          }
        `),
      ).toBe(30);
    });

    it("reduceRight no-initial scans past hole at last index", async () => {
      // {0: 10, 1: 20, length: 3} — acc starts at index 1 (=20), then 20+10=30.
      expect(
        await runWasm(`
          export function test(): number {
            function add(a: any, b: any): number { return a + b; }
            const obj: any = { 0: 10, 1: 20, length: 3 };
            return Array.prototype.reduceRight.call(obj, add) as number;
          }
        `),
      ).toBe(30);
    });

    it("reduce no-initial on all-holes throws TypeError", async () => {
      // {length: 3} with no present indices — spec: throw TypeError.
      let threw = false;
      try {
        await runWasm(`
          export function test(): number {
            function add(a: any, b: any): number { return 0; }
            const obj: any = { length: 3 };
            return Array.prototype.reduce.call(obj, add) as number;
          }
        `);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  describe("Boxed String wrapper as receiver", () => {
    // Array.prototype.METHOD.call(new String("..."), cb): per spec the String
    // wrapper exposes integer-indexed accessors and a `length` property, so
    // generic array-like iteration must work on it (test262 some/1-8.js).
    it("forEach on new String() visits each code unit position", async () => {
      expect(
        await runWasm(`
          export function test(): number {
            let count: number = 0;
            function cb(): boolean { count++; return true; }
            const s: any = new String("abc");
            Array.prototype.forEach.call(s, cb);
            return count;
          }
        `),
      ).toBe(3);
    });

    it("indexOf on new String() finds character", async () => {
      // Bracket-indexing into a String wrapper yields a length-1 string.
      expect(
        await runWasm(`
          export function test(): number {
            const obj: any = new String("hello");
            return Array.prototype.indexOf.call(obj, "l");
          }
        `),
      ).toBe(2);
    });

    it("some on new String() detects match with obj instanceof String", async () => {
      // Mirrors test262 built-ins/Array/prototype/some/15.4.4.17-1-8.js.
      expect(
        await runWasm(`
          export function test(): number {
            function cb(val: any, idx: number, obj: any): boolean {
              return obj instanceof String;
            }
            const obj: any = new String("hello");
            return Array.prototype.some.call(obj, cb) ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });
});
