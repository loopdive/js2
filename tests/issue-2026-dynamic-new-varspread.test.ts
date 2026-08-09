/**
 * Tests for issue #2026 / #53: variable (non-array-literal) spread in the
 * dynamic-`new` fallback — `new K(...someVar)` where the spread source is a
 * runtime array value, not an array literal.
 *
 * PR-3a (#1699) flattened array-literal spread via `flattenCallArgs` and LOUDLY
 * compile-time-deferred variable spread. #53 makes it WORK: when args contain a
 * non-flattenable spread, `emitDynamicNewFallback` builds a runtime `$ObjVecArr`
 * argv (+ argc), copying each spread source's elements (boxed) into it, and each
 * class tag-arm reads `argv[i]` with a runtime `i < argc ? array.get :
 * default-pad`.
 *
 * The `$ObjVecArr` type is RESERVED up-front (`reserveObjVecArrType`, gated on
 * `sourceContainsClass`) so the body references a stable type index — minting it
 * lazily mid-expression baked an unresolved `-1` heap-type ref (#2043).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runTest(src: string, exportName = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, () => unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return exp[exportName]!();
}

async function runStandalone(src: string, exportName = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message}`);
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod).filter((entry) => entry.module === "env");
  expect(envImports).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  const exp = instance.exports as Record<string, () => unknown>;
  return exp[exportName]!();
}

describe("issue #2026 / #53: variable-spread dynamic new", () => {
  it("threads a variable (non-literal) spread into the dynamic ctor", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any, a: number[]): any { return new K(...a); }
export function test(): number { const p = make(P, [4, 5]); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(9);
  });

  it("works through a method call on the constructed instance", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } sum(): number { return this.x + this.y; } }
function make(K: any, a: number[]): any { return new K(...a); }
export function test(): number { return make(P, [10, 20]).sum(); }
`;
    expect(await runTest(src)).toBe(30);
  });

  it("threads a mixed positional + variable spread", async () => {
    const src = `
class P { x: number; y: number; z: number; constructor(a: number, b: number, c: number) { this.x = a; this.y = b; this.z = c; } }
function make(K: any, rest: number[]): any { return new K(1, ...rest); }
export function test(): number { const p = make(P, [2, 3]); return p.x + p.y + p.z; }
`;
    expect(await runTest(src)).toBe(6);
  });

  it("normalizes an any-typed array carrier in host and standalone", async () => {
    // test262 harness helpers are JavaScript, so an untyped `constructArgs`
    // parameter reaches codegen as externref even though the runtime value is a
    // boxed Wasm vec. The dynamic-new argv builder must recover and flatten it.
    const src = `
class P {
  x: number; y: number; z: number;
  constructor(a: number, b: number, c: number) { this.x = a; this.y = b; this.z = c; }
}
function make(K: any, constructArgs: any): any { return new K(...constructArgs); }
export function test(): number {
  const p = make(P, [4, 5, 6, 99]); // surplus arg is not threaded past ctor arity
  return p.x * 100 + p.y * 10 + p.z;
}
`;
    expect(await runTest(src)).toBe(456);
    expect(await runStandalone(src)).toBe(456);
  });

  it("evaluates mixed positional and any-spread arguments once in source order", async () => {
    const src = `
let order = 0;
function mark(value: number): number { order = order * 10 + value; return value; }
function markSpread(): any { order = order * 10 + 2; return [2]; }
class P {
  code: number;
  constructor(a: number, b: number, c: number) { this.code = a * 100 + b * 10 + c; }
}
function make(K: any): any { return new K(mark(1), ...markSpread(), mark(3)); }
export function test(): number {
  const p = make(P);
  return order * 1000 + p.code;
}
`;
    expect(await runTest(src)).toBe(123_123);
    expect(await runStandalone(src)).toBe(123_123);
  });

  it("keeps runtime-spread non-constructors as catchable TypeErrors", async () => {
    const src = `
class P { constructor(value: number) {} }
function make(K: any, args: any): any { return new K(...args); }
export function test(): number {
  const args: any = [1];
  try {
    make(42, args);
    return 0;
  } catch (error) {
    return error instanceof TypeError ? 1 : 2;
  }
}
`;
    expect(await runTest(src)).toBe(1);
    expect(await runStandalone(src)).toBe(1);
  });

  it("dispatches a variable spread to the right shape-colliding class by tag", async () => {
    const src = `
class A { x: number; constructor(a: number) { this.x = a; } getX(): number { return this.x; } }
class B { y: number; constructor(b: number) { this.y = b * 10; } getY(): number { return this.y; } }
function make(K: any, a: number[]): any { return new K(...a); }
export function test(): number {
  return make(A, [3]).getX() + make(B, [4]).getY(); // 3 + 40 = 43
}
`;
    expect(await runTest(src)).toBe(43);
  });

  it("regression guard: array-literal spread still works (PR-3a path)", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(...[4, 5]); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(9);
  });

  it("regression guard: plain-arg dynamic new is unchanged", async () => {
    const src = `
class P { x: number; y: number; constructor(a: number, b: number) { this.x = a; this.y = b; } }
function make(K: any): any { return new K(7, 9); }
export function test(): number { const p = make(P); return p.x + p.y; }
`;
    expect(await runTest(src)).toBe(16);
  });
});
