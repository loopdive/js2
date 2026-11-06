import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports as buildHostImports } from "../src/runtime.js";

// (#7029) This file used to hand-roll the host `env`, listing only the imports
// its programs needed when it was written. The JS-host lane has since grown
// real-semantics imports for the same programs (`__register_prototype` for
// every class, 5ff86e89f5 #5347; real `TypeError` instances via
// `__new_TypeError`, #3287; `__get_undefined`, `__call_function_N`, ...), and
// each one turned a passing test into an instantiate-time LinkError. Link
// against the production resolver instead: it is the import contract the
// compiler actually emits against.
function buildImports(result: CompileResult) {
  return buildHostImports(result.imports, undefined, result.stringPool);
}

async function compileToWasm(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("Issue #277: local.set type mismatch coercion", () => {
  it("assign number to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = 42;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("assign boolean to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = true;
        return x ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("assign string to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = "hello";
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("reassign any-typed variable with different types", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = 10;
        x = 20;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("assign struct to externref-typed local", async () => {
    const exports = await compileToWasm(`
      interface Point { x: number; y: number }
      export function test(): number {
        let p: any = { x: 3, y: 4 };
        return 7;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("assign number|string union variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number | string = 42;
        return 42;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function returning any assigned to typed local", async () => {
    const exports = await compileToWasm(`
      function getVal(): any { return 5; }
      export function test(): number {
        let x: number = getVal();
        return x;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("assign array to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: any = [1, 2, 3];
        return 6;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("multiple any-typed assignments in sequence", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let a: any = 1;
        let b: any = 2;
        let c: any = 3;
        return (a as number) + (b as number) + (c as number);
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("for loop with any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let sum: any = 0;
        for (let i = 0; i < 5; i++) {
          sum = (sum as number) + i;
        }
        return sum as number;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("var hoisted then assigned a concrete value", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x: any;
        x = 42;
        return x as number;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("conditional branches assign different types to same local", async () => {
    const exports = await compileToWasm(`
      export function test(flag: number): number {
        var result: any;
        if (flag > 0) {
          result = 1;
        } else {
          result = 0;
        }
        return result as number;
      }
    `);
    expect(exports.test(1)).toBe(1);
    expect(exports.test(0)).toBe(0);
  });

  it("assign object literal to any-typed variable then use it", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let obj: any = { x: 10, y: 20 };
        return 30;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("function parameter typed as any receives number", async () => {
    const exports = await compileToWasm(`
      function process(val: any): number {
        return val as number;
      }
      export function test(): number {
        return process(42);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("assign closure to any-typed variable", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let fn: any = () => 42;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("var re-declaration with different types", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var x = 10;
        var x = 20;
        return x;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("assign to variable in nested scope with type widening", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number | boolean = 5;
        if (true) {
          x = 10;
        }
        return x as number;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("ternary expression with mixed types assigned to any", async () => {
    const exports = await compileToWasm(`
      export function test(flag: number): number {
        let x: any = flag > 0 ? 1 : 0;
        return x as number;
      }
    `);
    expect(exports.test(1)).toBe(1);
  });

  it("for-of loop with array elements", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let arr = [10, 20, 30];
        let sum = 0;
        for (let x of arr) {
          sum += x;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("for-loop var initializer with hoisted type mismatch", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var i: number;
        for (var i = 0; i < 3; i++) {}
        return i;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("assignment result used in expression context", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let x: number = 0;
        let y: number = (x = 5);
        return x + y;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("array destructuring with type coercion", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let arr = [1, 2, 3];
        let [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("object destructuring with field type coercion", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        let obj = { x: 10, y: 20 };
        let { x, y } = obj;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(30);
  });
});
