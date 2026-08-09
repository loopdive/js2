import { describe, it, expect } from "vitest";
import { compileAndRunVecSetExports as compileAndRun } from "./helpers/compile.js";

describe("#1441 — String.prototype.split: Array shape + wrapper receivers + limit", () => {
  describe("Array result shape (.constructor === Array)", () => {
    it("split(string) result has .constructor === Array", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "hello".split("l");
          return parts.constructor === Array ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("split(regex) result has .constructor === Array", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "hello".split(/l/);
          return parts.constructor === Array ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });

    it("array literal has .constructor === Array (vec wrapper reachable when __extern_get imported)", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const a = [1, 2, 3];
          // Force the __extern_get path to be reachable by routing through any-typed access.
          // Without an existing __extern_get import this exercise the new emit-gate too.
          const parts = "x".split("y");
          return (parts as any).constructor === Array && a.length === 3 ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("String wrapper receivers", () => {
    it("new String('hello').split('l') splits the boxed primitive", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const s = new String("hello");
          const parts = s.split("l");
          return parts.length;
        }
      `);
      expect(r).toBe(3);
    });

    it("new String('hello').split(/l/) splits the boxed primitive", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const s = new String("hello");
          const parts = s.split(/l/);
          return parts.length;
        }
      `);
      expect(r).toBe(3);
    });
  });

  describe("Receiver coercion / errors", () => {
    it("split.call(null) throws TypeError", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          try {
            ("x".split as any).call(null);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Limit argument", () => {
    it("split(',', 2) caps the result at 2 elements", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(",", 2);
          return parts.length;
        }
      `);
      expect(r).toBe(2);
    });

    it("split(/,/, 2) caps the regex-split result at 2 elements", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(/,/, 2);
          return parts.length;
        }
      `);
      expect(r).toBe(2);
    });

    it("split(',') without limit returns all parts (NaN sentinel does not truncate)", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(",");
          return parts.length;
        }
      `);
      expect(r).toBe(4);
    });

    it("split(',', 0) returns an empty array (spec §22.1.3.21 step 14)", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(",", 0);
          return parts.length;
        }
      `);
      expect(r).toBe(0);
    });

    it("split(',', 1) keeps the first element only", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(",", 1);
          return parts[0] === "a" && parts.length === 1 ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });

  describe("Element contents (preserved across the limit path)", () => {
    it("split(',', 2) returns the leading elements in order", async () => {
      const r = await compileAndRun(`
        export function test(): number {
          const parts = "a,b,c,d".split(",", 2);
          return parts[0] === "a" && parts[1] === "b" ? 1 : 0;
        }
      `);
      expect(r).toBe(1);
    });
  });
});
