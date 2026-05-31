import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1678 — Array.isArray(x) on a rest/array binding whose DEFAULT VALUE is
// statically `any` (externref) was folded to a compile-time constant `false`,
// even though the binding materialises a real array at runtime. The fold now
// becomes a runtime ref.test against vec struct types for externref args.

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#1678 externref-typed array/rest binding default + Array.isArray", () => {
  it("static method rest binding, any-typed default → Array.isArray true", async () => {
    const exports = await compileAndRun(`
      let values: any; values = [1, 2, 3];
      class C { static method([...x] = values) { return Array.isArray(x) ? 1 : 0; } }
      export function test(): number { return C.method(); }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("plain function rest binding, any-typed default → Array.isArray true", async () => {
    const exports = await compileAndRun(`
      let values: any; values = [1, 2, 3];
      function method([...x] = values) { return Array.isArray(x) ? 1 : 0; }
      export function test(): number { return method(); }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("rest binding value is usable (length + element access)", async () => {
    const exports = await compileAndRun(`
      let values: any; values = [1, 2, 3];
      function method([...x] = values) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s; }
      export function test(): number { return method(); }
    `);
    expect(exports.test()).toBe(6);
  }, 30000);

  it("number[]-typed default still true", async () => {
    const exports = await compileAndRun(`
      var values = [1, 2, 3];
      function method([...x] = values) { return Array.isArray(x) ? 1 : 0; }
      export function test(): number { return method(); }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("any-typed default passed directly (no default fires) still true", async () => {
    const exports = await compileAndRun(`
      let values: any; values = [1, 2, 3];
      class C { static method([...x] = []) { return Array.isArray(x) ? 1 : 0; } }
      export function test(): number { return C.method(values); }
    `);
    expect(exports.test()).toBe(1);
  }, 30000);

  it("Array.isArray false for any-typed non-array values", async () => {
    const obj = await compileAndRun(
      `let o: any; o = { a: 1 }; export function test(): number { return Array.isArray(o) ? 1 : 0; }`,
    );
    expect(obj.test()).toBe(0);
    const str = await compileAndRun(
      `let s: any; s = "hi"; export function test(): number { return Array.isArray(s) ? 1 : 0; }`,
    );
    expect(str.test()).toBe(0);
    const num = await compileAndRun(
      `let n: any; n = 5; export function test(): number { return Array.isArray(n) ? 1 : 0; }`,
    );
    expect(num.test()).toBe(0);
    const nul = await compileAndRun(
      `let z: any; z = null; export function test(): number { return Array.isArray(z) ? 1 : 0; }`,
    );
    expect(nul.test()).toBe(0);
  }, 30000);

  it("Array.isArray true for any-typed empty array", async () => {
    const exports = await compileAndRun(
      `let a: any; a = []; export function test(): number { return Array.isArray(a) ? 1 : 0; }`,
    );
    expect(exports.test()).toBe(1);
  }, 30000);

  it("statically-typed array literal still folds true", async () => {
    const exports = await compileAndRun(`export function test(): number { return Array.isArray(["a", "b"]) ? 1 : 0; }`);
    expect(exports.test()).toBe(1);
  }, 30000);
});
