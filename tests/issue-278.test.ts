import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #278: Destructuring non-struct types", () => {
  it("destructure function return value", async () => {
    const exports = await compileToWasm(`
      function getPair(): { a: number; b: number } {
        return { a: 10, b: 20 };
      }
      export function test(): number {
        const { a, b } = getPair();
        return a + b;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("destructure inline object with __type symbol", async () => {
    const exports = await compileToWasm(`
      function makeObj() {
        return { x: 3, y: 4 };
      }
      export function test(): number {
        const { x, y } = makeObj();
        return x + y;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("destructure with renaming", async () => {
    const exports = await compileToWasm(`
      function getCoords(): { x: number; y: number } {
        return { x: 5, y: 10 };
      }
      export function test(): number {
        const { x: a, y: b } = getCoords();
        return a * b;
      }
    `);
    expect(exports.test()).toBe(50);
  });

  it("nested function returning object for destructuring", async () => {
    const exports = await compileToWasm(`
      function compute(n: number): { sum: number; product: number } {
        return { sum: n + 1, product: n * 2 };
      }
      export function test(): number {
        const { sum, product } = compute(5);
        return sum + product;
      }
    `);
    expect(exports.test()).toBe(16);
  });

  it("destructure parameter-returned object", async () => {
    const exports = await compileToWasm(`
      function wrap(a: number, b: number): { first: number; second: number } {
        return { first: a, second: b };
      }
      export function test(): number {
        const { first, second } = wrap(100, 200);
        return first + second;
      }
    `);
    expect(exports.test()).toBe(300);
  });
});
