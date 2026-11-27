import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #325: Null pointer dereference in array rest destructuring", () => {
  it("lone rest element: const [...x] = [1, 2, 3]", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        const [...x] = values;
        return x[0] + x[1] + x[2];
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("rest element after one binding: const [a, ...rest] = arr", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const arr: number[] = [10, 20, 30, 40];
        const [a, ...rest] = arr;
        return a + rest[0] + rest[1] + rest[2];
      }
    `);
    expect(exports.test()).toBe(100);
  });

  it("rest after elisions: const [, , ...x] = values", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3, 4, 5];
        const [, , ...x] = values;
        return x[0] + x[1] + x[2];
      }
    `);
    // x should be [3, 4, 5]
    expect(exports.test()).toBe(12);
  });

  it("rest in for-loop initializer: for (const [...x] = [1]; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let result = 0;
        for (const [...x] = [1] as number[]; result < 1; ) {
          result = x[0];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("rest in for-loop with let: for (let [...x] = values; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (let [...x] = values; result < 1; ) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("rest in for-loop with var: for (var [...x] = values; ...)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const values: number[] = [1, 2, 3];
        let result = 0;
        for (var [...x] = values; result < 1; ) {
          result = x[0] + x[1] + x[2];
        }
        return result;
      }
    `);
    expect(exports.test()).toBe(6);
  });
});
