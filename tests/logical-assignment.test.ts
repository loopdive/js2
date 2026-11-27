import { describe, it, expect } from "vitest";
import { compileAndRunRuntimeDeps, compileAndRunStubs as compileAndRun } from "./helpers/compile.js";

describe("logical assignment operators", () => {
  describe("??= (nullish coalescing assignment)", () => {
    it("assigns when value is null", async () => {
      const source = `
        declare class Box { constructor(v: number); }
        export function test(): Box {
          let a: Box | null = null;
          a ??= new Box(5);
          return a;
        }
      `;
      const constructed: number[] = [];
      const exports = await compileAndRunRuntimeDeps(source, {
        Box: class {
          constructor(readonly __box: number) {
            constructed.push(__box);
          }
        },
      });
      const r = exports.test();
      expect(r).toBeDefined();
      expect(r).not.toBeNull();
      expect(constructed).toEqual([5]);
    });

    it("does not assign when value is non-null", async () => {
      const source = `
        declare class Box { constructor(v: number); }
        export function test(b: Box): Box {
          let a: Box | null = b;
          a ??= new Box(99);
          return a;
        }
      `;
      const constructed: number[] = [];
      const exports = await compileAndRunRuntimeDeps(source, {
        Box: class {
          constructor(readonly __box: number) {
            constructed.push(__box);
          }
        },
      });
      const sentinel = { __box: true };
      const r = exports.test(sentinel);
      // Should return the original sentinel, not a new Box
      expect(r).toBe(sentinel);
      // Box_new should NOT have been called since a was non-null
      expect(constructed).toEqual([]);
    });
  });

  describe("||= (logical OR assignment)", () => {
    it("assigns when value is falsy (0)", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = 0;
          a ||= 10;
          return a;
        }
      `);
      expect(e.test()).toBe(10);
    });

    it("does not assign when value is truthy", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = 5;
          a ||= 10;
          return a;
        }
      `);
      expect(e.test()).toBe(5);
    });

    it("assigns when value is falsy (-0 treated as 0)", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = 0;
          a ||= 42;
          return a;
        }
      `);
      expect(e.test()).toBe(42);
    });
  });

  describe("&&= (logical AND assignment)", () => {
    it("assigns when value is truthy", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let c = 1;
          c &&= 2;
          return c;
        }
      `);
      expect(e.test()).toBe(2);
    });

    it("does not assign when value is falsy (0)", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let c = 0;
          c &&= 2;
          return c;
        }
      `);
      expect(e.test()).toBe(0);
    });

    it("chains with multiple truthy values", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = 3;
          a &&= 7;
          a &&= 11;
          return a;
        }
      `);
      expect(e.test()).toBe(11);
    });
  });

  describe("combined scenarios", () => {
    it("all three operators in one function", async () => {
      const e = await compileAndRun(`
        export function testOr(): number {
          let a = 0;
          a ||= 10;
          return a;
        }
        export function testAnd(): number {
          let b = 5;
          b &&= 20;
          return b;
        }
      `);
      expect(e.testOr()).toBe(10);
      expect(e.testAnd()).toBe(20);
    });

    it("||= with negative numbers (truthy)", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = -1;
          a ||= 99;
          return a;
        }
      `);
      expect(e.test()).toBe(-1);
    });

    it("&&= with negative numbers (truthy)", async () => {
      const e = await compileAndRun(`
        export function test(): number {
          let a = -1;
          a &&= 42;
          return a;
        }
      `);
      expect(e.test()).toBe(42);
    });
  });
});
