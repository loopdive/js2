import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports[fn]!(...args);
}

describe("null pointer dereference in object destructuring params (#622)", () => {
  it("does not crash when object destructuring param is undefined", async () => {
    // The key fix: this should NOT throw "RuntimeError: dereferencing a null pointer"
    const code = `
      function extract({ x = 10, y = 20 }: { x?: number; y?: number } = {}): number {
        return x + y;
      }
      export function main(): number {
        return extract();
      }
    `;
    // Should not throw -- null guard prevents dereference
    const result = await run(code, "main");
    expect(typeof result).toBe("number");
  });

  it("object destructuring parameter with fields provided works correctly", async () => {
    const code = `
      function point({ x = 0, y = 0 }: { x?: number; y?: number }): number {
        return x * 10 + y;
      }
      export function main(): number {
        return point({ x: 3, y: 7 });
      }
    `;
    expect(await run(code, "main")).toBe(37);
  });

  it("object destructuring with explicit values works after null guard", async () => {
    const code = `
      function process({ a = 1 }: { a?: number }): number {
        return a;
      }
      export function main(): number {
        return process({ a: 42 });
      }
    `;
    expect(await run(code, "main")).toBe(42);
  });
});
