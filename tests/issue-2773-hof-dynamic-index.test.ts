// (#2773) HOF element-rep: dynamic-index native-vec read.
//
// The "callbackfn called with correct parameters" test262 family
// (`Array.prototype.{map,forEach,filter,reduce,some,every}` `-c-ii-1`) passes a
// NAMED function declaration as the callback:
//
//   function callbackfn(val, idx, obj) { if (obj[idx] !== val) bPar = false; }
//   [0, 1, true, null, {}, "five"].map(callbackfn);
//
// TS does NOT contextually type the params of a named function passed by
// reference, so `idx`/`obj` are implicit `any`. The array is heterogeneous, so
// it lowers to a native WasmGC vec (externref element) and reaches the callback
// (3rd arg) coerced to `externref`. `obj[idx]` with a DYNAMIC `any` index used
// to route to the host `__extern_get`, which cannot read the opaque WasmGC vec
// → `undefined`, so `obj[idx] !== val` was wrongly true and the whole family
// failed. The fix routes a dynamic-index externref read through the native
// `__vec_len` (bounds + vec-vs-host discriminator) + `__vec_get` (per-kind
// element read → boxed carrier). See property-access.ts `isAnyTypedIndexExpression`.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2773 HOF dynamic-index native-vec read", () => {
  it("map callback reads obj[idx] correctly over a heterogeneous array", async () => {
    const r = await run(`
      var bPar = true;
      var bCalled = false;
      function callbackfn(val, idx, obj) {
        bCalled = true;
        if (obj[idx] !== val) bPar = false;
      }
      export function run(): number {
        var srcArr = [0, 1, true, null, new Object(), "five"];
        srcArr.map(callbackfn);
        return (bCalled ? 1 : 0) + (bPar ? 2 : 0);
      }
    `);
    expect(r).toBe(3); // bCalled && bPar
  });

  it("map callback: obj[idx] === val at every index of a heterogeneous array", async () => {
    const r = await run(`
      var log = "";
      function cb(val, idx, obj) {
        if (idx < 2) log += idx + ":" + String(obj[idx] === val) + ";";
      }
      export function run(): string {
        [0, 1, true, null, {}, "five"].map(cb);
        return log;
      }
    `);
    expect(r).toBe("0:true;1:true;");
  });

  it("forEach callback obj[idx] === val (no divergence)", async () => {
    const r = await run(`
      var bad = -2;
      function cb(val, idx, obj) { if (bad === -2 && obj[idx] !== val) bad = idx; }
      export function run(): number {
        [0, 1, true, null, {}, "five"].forEach(cb);
        return bad;
      }
    `);
    expect(r).toBe(-2); // no bad index
  });

  it("every over a numeric array: obj[Idx] === val", async () => {
    // Raw export returns the boolean as i32 (no wrapExports re-brand), so assert 1.
    const r = await run(`
      function callbackfn(val, Idx, obj) { if (obj[Idx] === val) return true; }
      export function run(): number {
        return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every(callbackfn) ? 1 : 0;
      }
    `);
    expect(r).toBe(1);
  });

  it("reduce callback: obj[idx] === curVal and obj[idx-1] === prevVal", async () => {
    const r = await run(`
      function callbackfn(prevVal, curVal, idx, obj) {
        if (idx === 0 && obj[idx] === curVal && prevVal === 5.5) return curVal;
        else if (idx > 0 && obj[idx] === curVal && obj[idx - 1] === prevVal) return curVal;
        else return false;
      }
      export function run(): number {
        var arr = [0, 1, true, null, new Object(), "five"];
        return arr.reduce(callbackfn, 5.5) === "five" ? 1 : 0;
      }
    `);
    expect(r).toBe(1);
  });

  it("direct any-param element read via named function over a native vec", async () => {
    const r = await run(`
      function probe(obj, i) { return obj[i]; }
      export function run(): number {
        var a = [10, 20, 30, 40];
        // i is any (untyped param); probe reads a native vec through externref
        return probe(a, 2) + probe(a, 0);
      }
    `);
    expect(r).toBe(40); // 30 + 10
  });

  it("dynamic-index read of a genuine host object is unaffected (non-vec fallback)", async () => {
    const r = await run(`
      function probe(o, k) { return o[k]; }
      export function run(): number {
        var obj: any = { a: 7 };
        return probe(obj, "a");
      }
    `);
    expect(r).toBe(7);
  });

  it("out-of-bounds dynamic index on a native vec reads undefined, not a trap", async () => {
    const r = await run(`
      function probe(obj, i) { return obj[i] === undefined ? 1 : 0; }
      export function run(): number {
        var a = [1, 2, 3];
        return probe(a, 99);
      }
    `);
    expect(r).toBe(1);
  });
});
