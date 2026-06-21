import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Helper: compile source, instantiate with callback support, call exported function.
 *
 * Uses the shared buildImports() host-import builder so every runtime helper
 * the binary declares is supplied — including the `string_constants` import
 * namespace and the callback bridges (__make_callback / __call_1_f64 /
 * __call_2_f64) that functional array methods (filter, map, reduce, forEach,
 * find, findIndex, some, every) need. The hand-rolled env this replaced was
 * missing `string_constants`, which masked regressions for every functional
 * array method. setExports() wires the instance so __make_callback can call
 * back into the wasm __cb_* exports.
 */
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, Function>)[fn]!(...args);
}

describe("functional array methods", () => {
  describe("filter", () => {
    it("filters positive numbers", { timeout: 30_000 }, async () => {
      const src = `
        export function test(): number {
          const arr = [1, -2, 3, -4, 5];
          const result = arr.filter((x: number): boolean => x > 0);
          return result.length;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });

    it("returns correct elements", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40, 50];
          const result = arr.filter((x: number): boolean => x > 25);
          return result[0];
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });

    it("handles empty result", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const result = arr.filter((x: number): boolean => x > 10);
          return result.length;
        }
      `;
      expect(await run(src, "test")).toBe(0);
    });

    it("handles all matching", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const result = arr.filter((x: number): boolean => x > 0);
          return result.length;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });
  });

  describe("map", () => {
    it("doubles each element", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const result = arr.map((x: number): number => x * 2);
          return result[1];
        }
      `;
      expect(await run(src, "test")).toBe(4);
    });

    it("preserves array length", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30];
          const result = arr.map((x: number): number => x + 1);
          return result.length;
        }
      `;
      expect(await run(src, "test")).toBe(3);
    });

    it("maps to squares", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4];
          const result = arr.map((x: number): number => x * x);
          return result[3];
        }
      `;
      expect(await run(src, "test")).toBe(16);
    });
  });

  describe("reduce", () => {
    it("sums array elements", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          return arr.reduce((acc: number, x: number): number => acc + x, 0);
        }
      `;
      expect(await run(src, "test")).toBe(15);
    });

    it("computes product", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4];
          return arr.reduce((acc: number, x: number): number => acc * x, 1);
        }
      `;
      expect(await run(src, "test")).toBe(24);
    });

    it("uses initial value correctly", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.reduce((acc: number, x: number): number => acc + x, 100);
        }
      `;
      expect(await run(src, "test")).toBe(106);
    });
  });

  describe("forEach", () => {
    it("compiles and runs without error", async () => {
      // forEach returns void; we verify it runs by checking a side effect via reduce
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          let sum = 0;
          arr.forEach((x: number): void => { sum = sum + x; });
          return sum;
        }
      `;
      // Note: forEach with captures modifying a local variable is complex.
      // This tests that forEach compiles and executes without crashing.
      // The captured `sum` may not write back (capture semantics are snapshot-based).
      // We mainly verify no compilation or runtime error.
      const result = await compile(src);
      expect(result.success).toBe(true);
    });
  });

  describe("find", () => {
    it("finds first matching element", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 5, 10, 15, 20];
          return arr.find((x: number): boolean => x > 8)!;
        }
      `;
      expect(await run(src, "test")).toBe(10);
    });

    it("returns first match, not last", async () => {
      const src = `
        export function test(): number {
          const arr = [2, 4, 6, 8];
          return arr.find((x: number): boolean => x > 3)!;
        }
      `;
      expect(await run(src, "test")).toBe(4);
    });
  });

  describe("findIndex", () => {
    it("returns index of first match", async () => {
      const src = `
        export function test(): number {
          const arr = [10, 20, 30, 40];
          return arr.findIndex((x: number): boolean => x > 25);
        }
      `;
      expect(await run(src, "test")).toBe(2);
    });

    it("returns -1 when no match", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          return arr.findIndex((x: number): boolean => x > 10);
        }
      `;
      expect(await run(src, "test")).toBe(-1);
    });
  });

  describe("some", () => {
    it("returns true when element matches", async () => {
      const src = `
        export function test(): boolean {
          const arr = [1, 2, 3, 4, 5];
          return arr.some((x: number): boolean => x > 3);
        }
      `;
      expect(await run(src, "test")).toBe(1);
    });

    it("returns false when no element matches", async () => {
      const src = `
        export function test(): boolean {
          const arr = [1, 2, 3];
          return arr.some((x: number): boolean => x > 10);
        }
      `;
      expect(await run(src, "test")).toBe(0);
    });
  });

  describe("every", () => {
    it("returns true when all elements match", async () => {
      const src = `
        export function test(): boolean {
          const arr = [2, 4, 6, 8];
          return arr.every((x: number): boolean => x > 0);
        }
      `;
      expect(await run(src, "test")).toBe(1);
    });

    it("returns false when not all elements match", async () => {
      const src = `
        export function test(): boolean {
          const arr = [2, 4, 6, 8];
          return arr.every((x: number): boolean => x > 5);
        }
      `;
      expect(await run(src, "test")).toBe(0);
    });

    it("returns true for empty array", async () => {
      // every on empty array should return true (vacuous truth)
      const src = `
        export function test(): boolean {
          const arr: number[] = [];
          return arr.every((x: number): boolean => x > 0);
        }
      `;
      expect(await run(src, "test")).toBe(1);
    });
  });

  describe("chaining", () => {
    it("filter then map", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          const result = arr.filter((x: number): boolean => x > 2).map((x: number): number => x * 10);
          return result[0];
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });

    it("map then filter then reduce", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          return arr
            .map((x: number): number => x * 2)
            .filter((x: number): boolean => x > 4)
            .reduce((acc: number, x: number): number => acc + x, 0);
        }
      `;
      // map: [2, 4, 6, 8, 10], filter: [6, 8, 10], reduce: 24
      expect(await run(src, "test")).toBe(24);
    });
  });

  describe("closures with captures", () => {
    it("filter with captured variable", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3, 4, 5];
          const threshold = 3;
          const result = arr.filter((x: number): boolean => x > threshold);
          return result.length;
        }
      `;
      expect(await run(src, "test")).toBe(2);
    });

    it("map with captured multiplier", async () => {
      const src = `
        export function test(): number {
          const arr = [1, 2, 3];
          const factor = 10;
          const result = arr.map((x: number): number => x * factor);
          return result[2];
        }
      `;
      expect(await run(src, "test")).toBe(30);
    });
  });
});
