import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports as buildHostImports } from "../src/runtime.js";
import ts from "typescript";

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

function evaluateAsJs(source: string): Record<string, Function> {
  const jsOutput = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const fn = new Function("exports", "module", "Math", jsOutput.outputText);
  fn(exports, module, Math);
  return exports as Record<string, Function>;
}

async function assertEquivalent(source: string, testCases: { fn: string; args: unknown[]; approx?: boolean }[]) {
  const wasmExports = await compileToWasm(source);
  const jsExports = evaluateAsJs(source);

  for (const { fn, args, approx } of testCases) {
    const wasmResult = wasmExports[fn]!(...args);
    const jsResult = jsExports[fn]!(...args);

    if (approx) {
      expect(wasmResult).toBeCloseTo(jsResult as number, 10);
    } else {
      expect(wasmResult).toBe(jsResult);
    }
  }
}

describe("Issue #272: type mismatch -- stale funcIdx after addUnionImports", () => {
  it("class constructor with any-typed parameter (new triggers boxing coercion)", async () => {
    await assertEquivalent(
      `
      class Obj {
        val: any;
        constructor(v: any) { this.val = v; }
        getVal(): any { return this.val; }
      }
      export function test(): number {
        const o = new Obj(42);
        return o.getVal() + 1;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class method call with any-typed arguments", async () => {
    await assertEquivalent(
      `
      class Calculator {
        add(a: any, b: any): any { return a + b; }
      }
      export function test(): number {
        const c = new Calculator();
        return c.add(3, 4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("static method call with any-typed parameter", async () => {
    await assertEquivalent(
      `
      class MathHelper {
        static double(x: any): any { return x * 2; }
      }
      export function test(): number {
        return MathHelper.double(5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("super method call with coercion in arguments", async () => {
    await assertEquivalent(
      `
      class Base {
        getValue(): number { return 42; }
      }
      class Derived extends Base {
        getValue(): number { return super.getValue() + 1; }
      }
      export function test(): number {
        const d = new Derived();
        return d.getValue();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("constructor with multiple any-typed args causing late import shift", async () => {
    await assertEquivalent(
      `
      class Container {
        a: any;
        b: any;
        constructor(a: any, b: any) { this.a = a; this.b = b; }
        sum(): any { return this.a + this.b; }
      }
      export function test(): number {
        const c = new Container(10, 20);
        return c.sum();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("chained method calls with any types", async () => {
    await assertEquivalent(
      `
      function toNum(x: any): number { return x; }
      function toAny(x: number): any { return x; }
      export function test(): number { return toNum(toAny(42)); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance used in numeric expression", async () => {
    await assertEquivalent(
      `
      class Counter {
        count: number = 0;
        increment(): number { this.count++; return this.count; }
      }
      export function test(): number {
        const c = new Counter();
        c.increment();
        c.increment();
        return c.increment();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
