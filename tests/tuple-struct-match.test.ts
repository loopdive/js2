import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports[fn]!(...args);
}

describe("issue 582: tuple struct type mismatch in class methods", () => {
  it("method with destructured array default", async () => {
    const result = await run(
      `
      class C {
        method([x, y, z]: [number, number, number] = [1, 2, 3]): number {
          return x + y + z;
        }
      }
      export function test(): number {
        return new C().method();
      }
    `,
      "test",
    );
    expect(result).toBe(6);
  });
});
