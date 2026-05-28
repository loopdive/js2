import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("#1596 Function.prototype.apply/.call on function expressions", () => {
  it("(function(){}).apply(null, [literal]) forwards arguments", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number, c: number): number {
          return a + b + c;
        }).apply(null, [3, 4, 5]);
      }
    `);
    expect(e.test()).toBe(12);
  });

  it("(function(){}).apply binds arguments.length", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number, c: number): number {
          return arguments.length;
        }).apply(null, [3, 4, 5]);
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("(function(){}).call(null, a, b) forwards positional args", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(a: number, b: number): number {
          return a * b;
        }).call(null, 6, 7);
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("(() => {}).apply(null, [literal]) works on arrow functions", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return ((a: number, b: number): number => a - b).apply(null, [10, 3]);
      }
    `);
    expect(e.test()).toBe(7);
  });

  it(".apply with empty args array invokes with zero args", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return (function(): number { return 99; }).apply(null, []);
      }
    `);
    expect(e.test()).toBe(99);
  });

  it("nested .call inside expression", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const x = (function(a: number): number { return a + 1; }).call(null, 41);
        return x;
      }
    `);
    expect(e.test()).toBe(42);
  });

  it("Function.prototype.apply.call(fn, thisArg, argsArr) forwards arguments", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        function g(a: number, b: number): number { return a + b; }
        return Function.prototype.apply.call(g, null, [1, 2]);
      }
    `);
    expect(e.test()).toBe(3);
  });

  it("Function.prototype.call.call(fn, thisArg, ...args) forwards positional args", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        function g(a: number, b: number, c: number): number { return a + b + c; }
        return Function.prototype.call.call(g, null, 1, 2, 4);
      }
    `);
    expect(e.test()).toBe(7);
  });

  it("Function.prototype.apply.call on a function literal", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        return Function.prototype.apply.call(
          function(a: number, b: number): number { return a * b; },
          null,
          [3, 7],
        );
      }
    `);
    expect(e.test()).toBe(21);
  });
});
