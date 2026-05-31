/**
 * Regression tests for issue #646: "Cannot read properties of undefined
 * (reading 'kind')" when compilePropertyAccess returns undefined because
 * the accessWasm fallback code was incorrectly nested inside an
 * `if (typeName)` block — skipped entirely when typeName is falsy.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileWithoutKindCrash(source: string): Promise<void> {
  const result = await compile(source, { allowJs: false });
  const kindErrors = result.errors.filter((e) =>
    e.message.includes("Cannot read properties of undefined (reading 'kind')"),
  );
  expect(kindErrors).toEqual([]);
}

describe("Issue #646: residual undefined .kind crashes", { timeout: 30000 }, () => {
  it("should not crash on arguments.length in function expression", async () => {
    await compileWithoutKindCrash(`
      export function test(): number {
        const fn = function() {
          return arguments.length;
        };
        return 0;
      }
    `);
  });

  it("should not crash on arguments[n] in function expression", async () => {
    await compileWithoutKindCrash(`
      export function test(): number {
        const fn = function() {
          return arguments[0];
        };
        return 0;
      }
    `);
  });

  it("should not crash on property access of IArguments type", async () => {
    // IArguments has no struct type name, so typeName is undefined.
    // The accessWasm fallback must still produce a valid result.
    await compileWithoutKindCrash(`
      export function test(): number {
        const fn = function() {
          const args = arguments;
          return args.length;
        };
        return 0;
      }
    `);
  });

  it("should not crash on property access of unknown typed objects", async () => {
    // When the object type is not resolved to a known struct,
    // the accessWasm fallback should handle it gracefully.
    await compileWithoutKindCrash(`
      declare const unknownObj: any;
      export function test(): number {
        return unknownObj.someProp;
      }
    `);
  });

  it("should compile arguments.length in IIFE without kind crash", async () => {
    await compileWithoutKindCrash(`
      export function test(): number {
        return (function() {
          return arguments.length;
        })(1, 2, 3);
      }
    `);
  });

  it("compileExpressionInner result guard catches undefined returns", async () => {
    // This test verifies the safety guard in compileExpression that
    // catches non-null results without a .kind property (e.g., undefined).
    // The brace fix should prevent this from being needed for property access,
    // but the guard protects against any other sub-compiler returning undefined.
    await compileWithoutKindCrash(`
      export function test(): number {
        const fn = function() {
          const len = arguments.length;
          const first = arguments[0];
          return len;
        };
        return fn(42);
      }
    `);
  });
});
