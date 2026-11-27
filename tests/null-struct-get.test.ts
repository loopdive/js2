import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports[fn]!(...args);
}

describe("struct.get on null ref (#533)", () => {
  it("object destructuring in method params (object literal)", async () => {
    expect(
      await run(
        `
        const obj = {
          method({a, b}: {a: number, b: number}): number {
            return a + b;
          }
        };
        export function main(): number {
          return obj.method({a: 3, b: 4});
        }
        `,
        "main",
      ),
    ).toBe(7);
  });

  it("validates that method param binding patterns emit struct.get correctly", async () => {
    // Compile a method with rest destructuring and verify it validates
    const result = await compile(`
      const obj = {
        method([...x]: number[]): number {
          return x.length;
        }
      };
      export function main(): number {
        return obj.method([1, 2, 3]);
      }
    `);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary!)).toBe(true);
  });

  it("nullable struct local - conditional field access", async () => {
    expect(
      await run(
        `
        export function test(flag: number): number {
          let x: { a: number } | null = null;
          if (flag > 0) {
            x = { a: 10 };
          }
          if (x !== null) {
            return x.a;
          }
          return -1;
        }
        `,
        "test",
        [1],
      ),
    ).toBe(10);
  });
});
