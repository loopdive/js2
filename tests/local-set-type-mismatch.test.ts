import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm, instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports[fn]!(...args);
}

describe("local.set type mismatch (#625)", () => {
  it("array variable type updated when expression produces different vec type", async () => {
    // When resolveWasmType infers one vec struct type for the variable
    // but compileExpression produces a different vec struct type,
    // the local's declared type should be updated to match.
    const src = `
      export function test(): number {
        var a: any[] = [1, 2, 3];
        return 1;
      }
    `;
    expect(await run(src, "test")).toBe(1);
  }, 15000);

  it("object literal assigned to variable with inferred struct type", async () => {
    // When TS infers a specific struct type for a variable but the expression
    // produces a different struct, the local type should be updated.
    const src = `
      export function test(): number {
        var obj = { x: 1, y: 2 };
        return obj.x + obj.y;
      }
    `;
    expect(await run(src, "test")).toBe(3);
  }, 15000);

  it("coerceType no-op does not hide struct type mismatch", async () => {
    // Regression: when coerceType cannot convert between unrelated struct types,
    // the stackType must remain the actual result type so emitCoercedLocalSet
    // can detect and fix the mismatch by updating the local's declared type.
    const result = await compile(`
      export function test(): number {
        var a: any[] = [1, 2, 3];
        return 1;
      }
    `);
    // Should compile successfully without Wasm validation errors
    expect(result.success).toBe(true);
    // Instantiation should not fail with local.set type mismatch
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports as any).test()).toBe(1);
  }, 15000);
});
