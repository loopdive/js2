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

describe("Issue #257: Method calls on returned values", () => {
  it("method call on function return value (class)", async () => {
    const exports = await compileToWasm(`
      class Obj {
        val: number;
        constructor(v: number) { this.val = v; }
        getVal(): number { return this.val; }
      }
      function makeObj(): Obj { return new Obj(42); }
      export function test(): number {
        return makeObj().getVal();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("chained method calls", async () => {
    const exports = await compileToWasm(`
      class Builder {
        value: number;
        constructor() { this.value = 0; }
        add(n: number): Builder {
          this.value = this.value + n;
          return this;
        }
        result(): number { return this.value; }
      }
      function makeBuilder(): Builder { return new Builder(); }
      export function test(): number {
        return makeBuilder().add(10).add(5).result();
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("method call on constructor return", async () => {
    const exports = await compileToWasm(`
      class Counter {
        count: number;
        constructor(start: number) { this.count = start; }
        getCount(): number { return this.count; }
      }
      export function test(): number {
        return new Counter(7).getCount();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("property access on function return value", async () => {
    const exports = await compileToWasm(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) { this.x = x; this.y = y; }
      }
      function makePoint(): Point { return new Point(3, 4); }
      export function test(): number {
        return makePoint().x + makePoint().y;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("element access method call on class instance: obj['method']()", async () => {
    const exports = await compileToWasm(`
      class Calc {
        value: number;
        constructor(v: number) { this.value = v; }
        double(): number { return this.value * 2; }
      }
      export function test(): number {
        const c = new Calc(21);
        return c['double']();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("element access method call on object literal with methods", async () => {
    const exports = await compileToWasm(`
      function makeObj() {
        return { x: 10, getX(): number { return this.x; } };
      }
      export function test(): number {
        const obj = makeObj();
        return obj['getX']();
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("element access method call with arguments", async () => {
    const exports = await compileToWasm(`
      class Adder {
        base: number;
        constructor(b: number) { this.base = b; }
        add(n: number): number { return this.base + n; }
      }
      export function test(): number {
        const a = new Adder(10);
        return a['add'](32);
      }
    `);
    expect(exports.test()).toBe(42);
  });
});
