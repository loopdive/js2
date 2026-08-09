import { describe, it, expect } from "vitest";
import { compileAndRunVecSetExports as compileAndRun } from "./helpers/compile.js";

describe("#1057 — String.prototype.split constructor === Array", () => {
  it("split result .constructor should be Array", async () => {
    const result = await compileAndRun(`
      export function test(): boolean {
        const parts = "a,b,c".split(",");
        return parts.constructor === Array;
      }
    `);
    expect(result).toBe(1);
  });

  it("split with no match returns array with constructor === Array", async () => {
    const result = await compileAndRun(`
      export function test(): boolean {
        const parts = "hello".split("xyz");
        return parts.constructor === Array;
      }
    `);
    expect(result).toBe(1);
  });
});
