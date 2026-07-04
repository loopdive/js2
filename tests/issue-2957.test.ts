// #2957 phase 2 — async ARROWS and FUNCTION EXPRESSIONS now activate the async
// state machine (host CPS lane).
//
// Before this slice both async activation hooks lived inside
// `compileFunctionBody` and were only reachable from `ts.isFunctionDeclaration`.
// Async arrows / function expressions compile via `closures.ts`
// (`compileArrowAsClosure`) and never called the hooks, so an
// `async () => await g()` silently fell back to the legacy synchronous
// pass-through and returned a sync value instead of a real Promise. Phase 2
// wires the activation decision into the closure path (bakes the `externref`
// Promise result into the lifted func/struct type, then emits the CPS machine),
// and widens the CPS-import prepass so the host imports are pre-registered for
// arrow-only modules.
//
// Authoritative signal: the awaited operand is an INTERNAL async fn (`inner`),
// which returns a real Promise via CPS; a non-activated outer would return that
// inner Promise unwrapped-and-resynced to a sync value, whereas the activated
// outer returns its OWN result Promise that resolves to the value. The harness
// mirrors tests/issue-1042.test.ts (buildImports + setExports wire the
// __make_callback continuations). Method shapes are phase 3 (not covered here).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ASYNC_CPS_ENABLED } from "../src/codegen/async-cps.js";

async function compileRun(src: string, fn: string, ...args: number[]): Promise<unknown> {
  const result = await compile(src);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: number[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return await exports[fn]!(...args);
}

describe.skipIf(!ASYNC_CPS_ENABLED)("#2957 phase 2 — async arrow / function-expression activation (host CPS)", () => {
  it("concise arrow `async (x) => await P` activates and resolves to the awaited value", async () => {
    const v = await compileRun(
      `async function inner(x: number): Promise<number> { return x + 1; }
       const f = async (x: number) => await inner(x);
       export function run(): any { return f(6); }`,
      "run",
    );
    expect(v).toBe(7);
  });

  it("block-body arrow `async (x) => { return await P; }` activates", async () => {
    const v = await compileRun(
      `async function inner(x: number): Promise<number> { return x * 2; }
       const f = async (x: number) => { return await inner(x); };
       export function run(): any { return f(20); }`,
      "run",
    );
    expect(v).toBe(40);
  });

  it("arrow binds the awaited value: `const y = await P; return y + 1`", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 41; }
       const f = async () => { const y = await inner(); return y + 1; };
       export function run(): any { return f(); }`,
      "run",
    );
    expect(v).toBe(42);
  });

  it("arrow runs the post-await suffix: `await P; return N`", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 0; }
       const f = async () => { await inner(); return 9; };
       export function run(): any { return f(); }`,
      "run",
    );
    expect(v).toBe(9);
  });

  it("named function expression `async function ff(){ return await P; }` activates", async () => {
    const v = await compileRun(
      `async function inner(x: number): Promise<number> { return x + 3; }
       const f = async function ff(x: number): Promise<number> { return await inner(x); };
       export function run(): any { return f(5); }`,
      "run",
    );
    expect(v).toBe(8);
  });

  it("anonymous function expression `async function(){ ... }` activates", async () => {
    const v = await compileRun(
      `async function inner(): Promise<number> { return 100; }
       const f = async function (): Promise<number> { const x = await inner(); return x + 1; };
       export function run(): any { return f(); }`,
      "run",
    );
    expect(v).toBe(101);
  });

  it("await-less async arrow stays on the legacy path (predicate excludes it) but still runs", async () => {
    // No genuine suspension → asyncFnNeedsCps returns false → legacy sync fn
    // returning a resolved Promise. Value must still be correct.
    const v = await compileRun(
      `const f = async (x: number) => x + 1;
       export function run(): any { return f(41); }`,
      "run",
    );
    expect(v).toBe(42);
  });
});
