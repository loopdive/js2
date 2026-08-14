import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = await compile(source);
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

  it("identifier.apply forwards the live arguments object", async () => {
    const e = await compileAndRun(`
      function target(a: number, b: number): number {
        return a + b;
      }
      function forward(a: number, b: number): number {
        return target.apply(null, arguments as any);
      }
      export function test(): number {
        return forward(3, 4);
      }
    `);
    expect(e.test()).toBe(7);
  });

  it("mutable module closure.apply preserves the live argument count and overflow values", async () => {
    const e = await compileAndRun(`
      var callback: any;
      function setCallback(value: any): void {
        callback = value;
      }
      function forward(a: any, b: any, c: any): number {
        return callback.apply(null, arguments);
      }
      function target(first: any): number {
        return arguments.length * 100 + first + arguments[2];
      }
      setCallback(target);
      export function test(): number {
        return forward(5, 6, 7);
      }
    `);
    expect(e.test()).toBe(312);
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

  // Module-level outer-paren CallExpression shape — `(function(){...}.apply(...))`.
  // The outer parens wrap the whole call expression (not the function literal).
  // This is the exact AST shape test262 emits in the spread-sngl-literal.js /
  // spread-mult-literal.js family. Before the fix the module-init collector
  // only matched ExpressionStatements whose direct child was
  // `isCallExpression`/`isNewExpression` — never a `ParenthesizedExpression`
  // around them — so the entire `.apply(...)` call was silently dropped from
  // `__module_init`.
  it("module-level outer-paren CallExpression — was silently dropped from __module_init", async () => {
    const e = await compileAndRun(`
      var callCount = 0;
      function bump(): void { callCount += 1; }
      (bump());
      export function test(): number { return callCount; }
    `);
    expect(e.test()).toBe(1);
  });

  it("module-level outer-paren MemberCall — was silently dropped from __module_init", async () => {
    // (obj.method()) — parens around a property-access call. Same dropped-statement
    // bug as above for the test262 (function(){}.apply(...)) shape.
    const e = await compileAndRun(`
      var callCount = 0;
      const obj = { bump(): void { callCount += 1; } };
      (obj.bump());
      export function test(): number { return callCount; }
    `);
    expect(e.test()).toBe(1);
  });
});
