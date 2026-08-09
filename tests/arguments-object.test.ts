import { describe, it, expect } from "vitest";
import {
  compileToWasm,
  evaluateAsJs,
  assertEquivalent,
  buildImports,
  compile,
  readFileSync,
  resolve,
} from "./equivalence/helpers.js";

describe("Arguments object", () => {
  it("arguments.length returns parameter count", async () => {
    const exports = await compileToWasm(`
      function countArgs(a: number, b: number, c: number): number {
        return arguments.length;
      }
      export function test(): number {
        return countArgs(10, 20, 30);
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("zero-formal arguments reuses the complete call-site argument list", async () => {
    const exports = await compileToWasm(`
      function collect(): number {
        arguments[0] = arguments[0] + 1;
        return arguments.length * 100 + arguments[0] + arguments[1];
      }
      export function test(): number {
        return collect(2, 3);
      }
    `);
    expect(exports.test()).toBe(206);
  });
});
