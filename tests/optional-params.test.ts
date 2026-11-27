import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("optional parameters", () => {
  it("missing optional param is undefined, so 10 + b is NaN", async () => {
    const result = await compile(`
      function helper(a: number, b?: number): number {
        return a + b;
      }
      export function test(): number {
        return helper(10);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const exports = (await instantiateWithRuntime(result)).exports as any;
    // An omitted argument binds the parameter to undefined (ECMA-262 §10.2.11 FunctionDeclarationInstantiation),
    // and 10 + undefined is NaN (§13.15.3 ApplyStringOrNumericBinaryOperator, ToNumeric(undefined) = NaN). The old
    // expectation (10) asserted the pre-fix miscompile that treated a missing number parameter as 0.
    expect(exports.test()).toBeNaN();
  });

  it("provided optional param is used", async () => {
    const result = await compile(`
      function helper(a: number, b?: number): number {
        return a + b;
      }
      export function test(): number {
        return helper(10, 5);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.test()).toBe(15); // 10 + 5
  });

  it("optional param truthiness check", async () => {
    const result = await compile(`
      function helper(a: number, scale?: number): number {
        if (scale) {
          return a * scale;
        }
        return a;
      }
      export function withScale(): number {
        return helper(10, 3);
      }
      export function withoutScale(): number {
        return helper(10);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.withScale()).toBe(30); // 10 * 3
    expect(exports.withoutScale()).toBe(10); // fallback, scale is 0 (falsy)
  });
});
