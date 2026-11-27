import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports[fn]!(...args);
}

describe("finally block execution count", () => {
  it("try + catch + finally: finally runs once on normal path", { timeout: 30000 }, async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
        } catch (e) {
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(11);
  });

  it("try + finally (no catch): finally runs once on normal path", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(11);
  });

  it("try + catch + finally: finally runs once on catch path", async () => {
    const src = `
      export function thrower(): number {
        throw 42;
      }
      export function test(): number {
        let count: number = 0;
        try {
          count += 1;
          thrower();
        } catch (e) {
          count += 100;
        } finally {
          count += 10;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(111);
  });

  it("try + catch + finally: catch throws, finally still runs once", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          try {
            throw 1;
          } catch (e) {
            count += 100;
            throw 2;
          } finally {
            count += 10;
          }
        } catch (e) {
        }
        return count;
      }
    `;
    // catch runs (+100), catch throws, inner finally runs (+10) = 110
    expect(await run(src, "test")).toBe(110);
  });

  it("nested try/catch/finally", async () => {
    const src = `
      export function test(): number {
        let count: number = 0;
        try {
          try {
            count += 1;
          } catch (e) {
          } finally {
            count += 10;
          }
        } catch (e) {
        } finally {
          count += 100;
        }
        return count;
      }
    `;
    expect(await run(src, "test")).toBe(111);
  });
});
