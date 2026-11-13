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

describe("Issue #284: for-of destructuring", () => {
  it("object binding destructuring in for-of", async () => {
    await assertEquivalent(
      `
      interface Item { a: number; b: number; }
      export function test(): number {
        const items: Item[] = [{a: 1, b: 2}, {a: 3, b: 4}];
        let sum = 0;
        for (const {a, b} of items) {
          sum = sum + a + b;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array binding destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const items: number[][] = [[1, 2], [3, 4]];
        let sum = 0;
        for (const [x, y] of items) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object assignment destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        const items: {a: number, b: number}[] = [{a: 5, b: 6}];
        for ({a, b} of items) {}
        return a + b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array assignment destructuring in for-of", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        for ([x, y] of [[3, 4], [5, 6]]) {}
        return x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array-object destructuring in for-of", async () => {
    await assertEquivalent(
      `
      interface Inner { x: number; y: number; }
      export function test(): number {
        const items: Inner[][] = [[{x: 10, y: 20}]];
        let sum = 0;
        for (const [{x, y}] of items) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("var destructuring with multiple iterations", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let total = 0;
        for (var {a, b} of [{a: 1, b: 2}, {a: 3, b: 4}, {a: 5, b: 6}] as {a: number, b: number}[]) {
          total = total + a * b;
        }
        return total;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of with property rename in object destructuring", async () => {
    await assertEquivalent(
      `
      interface Pair { a: number; b: number; }
      export function test(): number {
        const items: Pair[] = [{a: 5, b: 10}, {a: 15, b: 20}];
        let sum = 0;
        for (const {a: x, b: y} of items) {
          sum = sum + x + y;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of array destructuring accumulates across iterations", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const coords: number[][] = [[1, 0], [0, 1], [1, 1]];
        let xSum = 0;
        let ySum = 0;
        for (const [x, y] of coords) {
          xSum = xSum + x;
          ySum = ySum + y;
        }
        return xSum * 10 + ySum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("simple for-of regression check", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        for (const x of [1, 2, 3, 4]) {
          sum = sum + x;
        }
        return sum;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
