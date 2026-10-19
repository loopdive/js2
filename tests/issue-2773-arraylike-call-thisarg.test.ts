// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2773 S8 — array-like `Array.prototype.X.call(obj, cb, thisArg)` fidelity.
//
// Two coupled defects broke the test262 HOF "-c-ii-20..23" family (13 files):
//
//   1. The generic array-like loop (`compileArrayLikePrototypeCall`) never
//      installed the spec `thisArg` into the `__current_this` global around the
//      callback `call_ref` — the #2152 mechanism existed only on the
//      direct-array HOF path. `Array.prototype.map.call({0:11,length:2}, cb,
//      thisArg)` ran `cb` with the wrong `this`.
//   2. A boolean-returning callback's i32 result was boxed into the reduce
//      accumulator / map result array via `__box_number` (1/0), failing
//      `assert.sameValue(result, true)` in any `any`-typed consumer. Now boxed
//      via `__box_boolean` when the callback's TS signature returns boolean.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "run"): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2773 S8 — array-like .call(obj, cb, thisArg) fidelity", () => {
  it("map.call binds thisArg as the callback's this (the -c-ii-20 shape)", async () => {
    const r = await run(`
      function callbackfn(val, idx, obj) { return this.threshold === 10; }
      var thisArg = { threshold: 10 };
      var obj = { 0: 11, 1: 9, length: 2 };
      export function run(): string {
        var t = Array.prototype.map.call(obj, callbackfn, thisArg);
        return "" + t[0] + "," + t[1];
      }
    `);
    expect(r).toBe("true,true");
  });

  it("every/some/forEach/filter .call bind thisArg", async () => {
    const r = await run(`
      function cb(val, idx, obj) { return this.t === 1; }
      var seen = "";
      function fcb(val, idx, obj) { seen += "" + (this.t === 1); }
      var ta = { t: 1 };
      var obj = { 0: 5, length: 1 };
      export function run(): string {
        var e = Array.prototype.every.call(obj, cb, ta);
        var s = Array.prototype.some.call(obj, cb, ta);
        Array.prototype.forEach.call(obj, fcb, ta);
        var f = Array.prototype.filter.call(obj, cb, ta);
        return "" + e + s + seen + f.length;
      }
    `);
    // every → true, some → true, forEach saw this.t===1, filter kept the element
    expect(r).toBe("truetruetrue1");
  });

  it("arrow callback ignores thisArg (lexical this)", async () => {
    const r = await run(`
      var obj = { 0: 5, length: 1 };
      export function run(): number {
        var t = Array.prototype.map.call(obj, (v) => v * 3, { x: 1 });
        return t[0];
      }
    `);
    expect(r).toBe(15);
  });

  it(".call without thisArg unchanged", async () => {
    const r = await run(`
      function cb(val, idx, obj) { return val * 2; }
      var obj = { 0: 11, 1: 9, length: 2 };
      export function run(): string {
        var t = Array.prototype.map.call(obj, cb);
        return "" + t.length + "|" + t[0] + "," + t[1];
      }
    `);
    expect(r).toBe("2|22,18");
  });

  it("reduce.call boolean callback result keeps the boolean brand (-c-ii-21)", async () => {
    const r = await run(`
      function cb(prev, cur, idx, obj) { return prev === null; }
      var obj = { 0: 11, length: 1 };
      export function run(): string {
        var res = Array.prototype.reduce.call(obj, cb, null);
        return typeof res + "|" + res;
      }
    `);
    expect(r).toBe("boolean|true");
  });

  it("reduceRight.call boolean callback result keeps the brand", async () => {
    const r = await run(`
      function cb(prev, cur, idx, obj) { return prev === null; }
      var obj = { 0: 11, length: 1 };
      export function run(): string {
        var res = Array.prototype.reduceRight.call(obj, cb, null);
        return typeof res + "|" + res;
      }
    `);
    expect(r).toBe("boolean|true");
  });

  it("reduce.call numeric accumulation unchanged", async () => {
    const r = await run(`
      function cb(prev, cur, idx, obj) { return prev + cur; }
      var obj = { 0: 11, 1: 4, length: 2 };
      export function run(): number {
        return Array.prototype.reduce.call(obj, cb, 100);
      }
    `);
    expect(r).toBe(115);
  });

  it("map.call boolean results surface as true/false in the result array", async () => {
    const r = await run(`
      function cb(val, idx, obj) { return val > 10; }
      var obj = { 0: 11, 1: 9, length: 2 };
      export function run(): string {
        var t = Array.prototype.map.call(obj, cb);
        return typeof t[0] + "," + t[0] + "|" + typeof t[1] + "," + t[1];
      }
    `);
    expect(r).toBe("boolean,true|boolean,false");
  });

  it("nested this restored after the loop (install/restore discipline)", async () => {
    const r = await run(`
      function cb(val, idx, obj) { return this.m; }
      var obj = { 0: 1, length: 1 };
      export function run(): string {
        var t1 = Array.prototype.map.call(obj, cb, { m: "a" });
        var t2 = Array.prototype.map.call(obj, cb, { m: "b" });
        return "" + t1[0] + t2[0];
      }
    `);
    expect(r).toBe("ab");
  });
});
