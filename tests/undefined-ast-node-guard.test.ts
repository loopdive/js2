import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("undefined AST node guard (#611)", () => {
  it("compileExpression guard: compiler does not crash on new Math.sqrt()", async () => {
    // This pattern previously could trigger "Cannot read 'kind' of undefined"
    // when the compiler tried to resolve the callee of `new Math.sqrt()`.
    const result = await compile(`
      const x = new (Math.sqrt as any)(4);
    `);
    // We don't require success -- just that it doesn't throw
    expect(result).toBeDefined();
    expect(result.errors).toBeDefined();
  });

  it("compileExpression guard: compiler does not crash on import.meta", async () => {
    // import.meta can trigger undefined node access in certain contexts
    const result = await compile(`
      const m = import.meta;
    `);
    expect(result).toBeDefined();
    expect(result.errors).toBeDefined();
  });

  it("compiler handles valid code correctly after guard addition", async () => {
    // Ensure the guards don't break normal compilation
    const result = await compile(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("compileStatement guard: compiler does not crash on complex class patterns", async () => {
    // Nested classes with private members could trigger undefined nodes
    const result = await compile(`
      class Outer {
        #x = 10;
        method() {
          class Inner {
            get value() { return 42; }
          }
          return new Inner().value;
        }
      }
    `);
    expect(result).toBeDefined();
    expect(result.errors).toBeDefined();
  });
});
