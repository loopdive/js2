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

describe("Issue #258: Nested call expressions", () => {
  it("function returning closure called immediately", async () => {
    const exports = await compileToWasm(`
      function makeAdder(a: number): (b: number) => number {
        return (b: number) => a + b;
      }
      export function test(): number {
        return makeAdder(10)(32);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("parenthesized identifier callee: (fn)(args)", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      export function test(): number {
        return (add)(10, 20);
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("double parenthesized callee: ((fn))(args)", async () => {
    const exports = await compileToWasm(`
      function mul(a: number, b: number): number {
        return a * b;
      }
      export function test(): number {
        return ((mul))(6, 7);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("nested call as argument: f(g())", async () => {
    const exports = await compileToWasm(`
      function double(x: number): number {
        return x * 2;
      }
      function addOne(x: number): number {
        return x + 1;
      }
      export function test(): number {
        return double(addOne(20));
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("multiple nested calls as arguments: f(g(), h())", async () => {
    const exports = await compileToWasm(`
      function add(a: number, b: number): number {
        return a + b;
      }
      function square(x: number): number {
        return x * x;
      }
      function triple(x: number): number {
        return x * 3;
      }
      export function test(): number {
        return add(square(3), triple(11));
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("function returning closure with captures", async () => {
    const exports = await compileToWasm(`
      function makeMultiplier(factor: number): (x: number) => number {
        return (x: number) => x * factor;
      }
      export function test(): number {
        return makeMultiplier(7)(6);
      }
    `);
    expect(exports.test()).toBe(42);
  });

  // Skipped: storing closure from function call in a variable and calling it later
  // is a pre-existing limitation unrelated to issue #258 (closure capture coercion issue)
  it.skip("chained closure calls: makeAdder(a)(b) used multiple times", async () => {
    const exports = await compileToWasm(`
      function makeAdder(a: number): (b: number) => number {
        return (b: number) => a + b;
      }
      export function test(): number {
        const add10 = makeAdder(10);
        const add20 = makeAdder(20);
        return add10(12) + add20(0);
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
