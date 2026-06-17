// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2118 — Self-recursive const/let arrow closures emitted an invalid module.
//
// Repro: `const f = (n) => n <= 1 ? 1 : n * f(n - 1)`.
//
// Root cause: `compileArrowAsClosure` (src/codegen/closures.ts) captured the
// closure's *own* binding (`f`) as an ordinary variable. The outer slot for `f`
// is typed `externref` (function types resolve to externref) and is still
// uninitialized at the moment the closure is constructed, so the self-capture
// was boxed into a `__ref_cell_externref` and the construction path emitted an
// invalid `ref.cast` between the ref-cell struct and the closure struct —
// `WebAssembly.Module(): struct.get expected (ref null N) found local.get of
// (ref null M)` at validation time. Named function expressions already routed
// self-references through the `__self` lifted param (index 0); arrow bindings
// did not.
//
// Fix: detect that an arrow is the initializer of a `const`/`let` variable
// declaration whose name the body references (the self-binding), skip capturing
// that name, and register it against `__self` in the lifted function's localMap
// + closureMap so recursive calls dispatch through the closure's own struct via
// call_ref — mirroring the named-funcexpr mechanism.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  exports: Record<string, Function>;
}

async function run(src: string): Promise<RunResult> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((e) => `  L${e.line}:${e.column} ${e.message}`).join("\n")}`);
  }
  // The bug surfaced at module-validation time (struct.get type mismatch).
  const importResult = buildImports(result.imports as never, undefined, result.stringPool);
  const inst = await WebAssembly.instantiate(result.binary, importResult as never);
  if (typeof (importResult as { setExports?: Function }).setExports === "function") {
    (importResult as { setExports: Function }).setExports(inst.instance.exports);
  }
  return { exports: inst.instance.exports as Record<string, Function> };
}

describe("#2118 self-recursive const/let arrow closures", () => {
  it("const arrow factorial validates and returns 120", async () => {
    const { exports } = await run(`
      export function test(): number {
        const f = (n: number): number => n <= 1 ? 1 : n * f(n - 1);
        return f(5);
      }
    `);
    expect(exports.test!()).toBe(120);
  });

  it("let arrow factorial validates and returns 120", async () => {
    const { exports } = await run(`
      export function test(): number {
        let f = (n: number): number => n <= 1 ? 1 : n * f(n - 1);
        return f(5);
      }
    `);
    expect(exports.test!()).toBe(120);
  });

  it("recursive arrow with two self-calls (fib) returns 55", async () => {
    const { exports } = await run(`
      export function test(): number {
        const fib = (n: number): number => n < 2 ? n : fib(n - 1) + fib(n - 2);
        return fib(10);
      }
    `);
    expect(exports.test!()).toBe(55);
  });

  it("self-recursive arrow that also captures an outer variable returns 48", async () => {
    // Exercises the wrapper-subtype path: captures.length > 0 so __self is the
    // wrapper base struct, distinct from the specific closure subtype.
    const { exports } = await run(`
      export function test(): number {
        const base = 2;
        const f = (n: number): number => n <= 1 ? base : n * f(n - 1);
        return f(4);
      }
    `);
    expect(exports.test!()).toBe(48);
  });

  it("self-recursion inside a nested function returns 10", async () => {
    const { exports } = await run(`
      export function outer(): number {
        const h = (n: number): number => n <= 0 ? 0 : n + h(n - 1);
        return h(4);
      }
      export function test(): number { return outer(); }
    `);
    expect(exports.test!()).toBe(10);
  });

  it("non-recursive const arrow is unaffected (regression guard)", async () => {
    const { exports } = await run(`
      export function test(): number {
        const g = (n: number): number => n * 2;
        return g(21);
      }
    `);
    expect(exports.test!()).toBe(42);
  });

  // Mutual recursion between two forward-referenced const arrows
  // (`const a = (n) => b(...); const b = (n) => a(...)`) is a deeper
  // forward-reference closure-typing problem tracked separately as a follow-up
  // to #2118 (the first arrow boxes the not-yet-declared peer as an externref
  // ref-cell while the peer's closure struct is stored directly, producing
  // conflicting box representations → runtime `illegal cast`). Self-recursion,
  // the dominant pattern, is fixed here.
});
