// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1529 — object destructuring default that reads a module global emits a
 * stale `global.get` index → invalid wasm (`f64.add expected f64, found
 * global.get of type externref`).
 *
 * `destructureParamObject`'s struct fast path swapped `fctx.body` to a
 * detached `destructInstrs` buffer without registering it in
 * `fctx.savedBodies`, and only inserted the null-guard string constant when
 * closing the guard. `addStringConstantGlobal` prepends an import global and
 * shifts every existing `global.get`/`global.set` index, but by then the body
 * had been restored and `destructInstrs` lived only inside the not-yet-pushed
 * `if.else` — invisible to the fixup. A default like `{ c = ++n }` that reads
 * a module global kept the pre-insertion index, which now pointed at the
 * freshly-added string-constant import (externref) instead of the intended f64
 * global.
 *
 * Fix mirrors the vec/tuple paths (#1553d): pre-warm the null-guard string
 * before populating `destructInstrs`, and register the buffer in
 * `savedBodies` for the duration of the swap.
 */
async function run(src: string): Promise<{ exports: Record<string, any> }> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  return { exports: instance.exports as Record<string, any> };
}

describe("#1529 — object dstr default reading a module global validates", () => {
  it("function param: { c = ++n } reads + mutates outer var", async () => {
    const { exports } = await run(`
      var n = 0;
      function m({ a, c = ++n }: any) { return c; }
      export function test(): number { return m({}) === 1 ? 1 : 0; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("class static method: { c = ++n }", async () => {
    const { exports } = await run(`
      var n = 0;
      class C { static m({ a, c = ++n }: any) { return c; } }
      export function test(): number { return C.m({}) === 1 ? 1 : 0; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("plain read of outer var as default: { c = n }", async () => {
    const { exports } = await run(`
      var n = 5;
      function m({ a, c = n }: any) { return c; }
      export function test(): number { return m({}) === 5 ? 1 : 0; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("default uses the supplied value when present", async () => {
    const { exports } = await run(`
      var n = 0;
      function m({ a, c = ++n }: any) { return c; }
      export function test(): number { return m({ c: 42 }) === 42 ? 1 : 0; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("throwing default short-circuits later default (test262 obj-ptrn-list-err)", async () => {
    // { a, b = thrower(), c = ++n } called with {}: b's initializer throws
    // before c = ++n is evaluated, so n must stay 0 (spec left-to-right).
    const { exports } = await run(`
      var n = 0;
      function thrower(): number { throw new Error("boom"); }
      function m({ a, b = thrower(), c = ++n }: any) { return c; }
      export function test(): number {
        var threw = 0;
        try { m({}); } catch (e) { threw = 1; }
        return (threw === 1 && n === 0) ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("two dstr-default functions in one module keep independent global indices", async () => {
    // Each function's default reads/writes the same module global `n`. The
    // #1529 bug corrupted global indices when more than one such function was
    // emitted; with the fix both fire correctly and accumulate on `n`.
    const { exports } = await run(`
      var n = 0;
      function f1({ a = ++n }: any): number { return a; }
      function f2({ b = ++n }: any): number { return b; }
      export function test(): number {
        const r1 = f1({});
        const r2 = f2({});
        return (r1 === 1 && r2 === 2 && n === 2) ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
