// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6701 — the three `any`-receiver residuals #6683 left, under
// `--target standalone` (zero imports):
//   - `id([1, 2, 3]).splice(0, 2)` answered null: `splice` had no
//     `$__vec_base` producer arm in the closed-method dispatcher.
//   - `[].slice.call(arguments, 1)` answered an empty array: the reflective
//     call padded the omitted `end` with null (⇒ 0), and a non-vec `this`
//     answered null.
//   - `Math.max.apply(null, [3, 9, 1])` answered -Infinity: the variadic
//     builtin value closure takes ONE packed-args vec, and neither
//     `__apply_closure` nor `__call_fn_method_<n>` packed one.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, js = false): Promise<unknown> {
  const opts: Record<string, unknown> = { target: "standalone" };
  if (js) Object.assign(opts, { fileName: "input.js", allowJs: true });
  const r = await compile(src, opts as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = new WebAssembly.Instance(mod, {});
  return (exports as { test: () => unknown }).test();
}

const ID = `function id(v: any): any { return v; }`;

describe("#6701 splice on an any Array receiver (standalone)", () => {
  it("answers the deleted elements (the issue repro)", async () => {
    const src = `${ID} export function test(){ var r = id([1,2,3]).splice(0, 2); return r === null ? -1 : r.length * 10 + r[1]; }`;
    expect(await runStandalone(src)).toBe(22);
  });

  it("grows the receiver when inserting more than it deletes", async () => {
    const src = `${ID} export function test(){ var a = id([1,2,3,4,5]); var r = a.splice(1, 2, 9, 8, 7);
      return a.length * 10000 + a[1] * 1000 + a[3] * 100 + r.length * 10 + r[0]; }`;
    expect(await runStandalone(src)).toBe(69722);
  });

  it("shrinks the receiver, and splice(start) deletes to the end", async () => {
    const src = `${ID} export function test(){
      var a = id([1,2,3,4,5]); var r = a.splice(1, 3);
      var b = id([1,2,3,4,5]); var s = b.splice(-2);
      var c = id([1,2,3]); var t = c.splice();
      return a.length * 100000 + a[1] * 10000 + r.length * 1000 + b.length * 100 + s[0] * 10 + c.length + t.length; }`;
    expect(await runStandalone(src)).toBe(2 * 100000 + 5 * 10000 + 3 * 1000 + 3 * 100 + 4 * 10 + 3);
  });
});

describe("#6701 Array.prototype.splice / slice as values on array-likes (standalone)", () => {
  it("a transferred splice mutates an array-like, inserting every item", async () => {
    const src = `export function test(){
      var o = {}; o.length = 3; o[0] = "a"; o[1] = "b"; o[2] = "c"; o.splice = Array.prototype.splice;
      var r = o.splice(1, 1, "x", "y");
      return o.length * 1000 + r.length * 100 + (o[1] === "x" && o[2] === "y" && o[3] === "c" ? 1 : 0); }`;
    expect(await runStandalone(src, true)).toBe(4101);
  });

  it("a count past 2^32 - 1 is a RangeError, not a trap", async () => {
    const src = `export function test(){
      var o = { length: 4294967296, slice: Array.prototype.slice };
      try { o.slice(0); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }`;
    expect(await runStandalone(src, true)).toBe(1);
  });
});

describe("#6701 [].slice.call(arguments, k) (standalone)", () => {
  it("slices the arguments object from k (the issue repro)", async () => {
    const src = `function f() { return [].slice.call(arguments, 1); }
      export function test(){ var r = f(1, 2, 3); return r.length * 10 + r[0]; }`;
    expect(await runStandalone(src, true)).toBe(22);
  });

  it("Array.prototype.slice.call / .apply / a value-erased slice agree", async () => {
    const src = `var slice = Array.prototype.slice;
      function a() { return Array.prototype.slice.call(arguments, 1); }
      function b() { return Array.prototype.slice.apply(arguments, [2]); }
      function c() { return slice.call(arguments); }
      export function test(){ return a(1,2,3).length * 100 + b(1,2,3).length * 10 + c(1,2,3).length; }`;
    expect(await runStandalone(src, true)).toBe(213);
  });

  it("an explicit undefined end, an array-like object, and a null this", async () => {
    const src = `function f() { return [].slice.call(arguments, 1, undefined); }
      export function test(){
        var r = Array.prototype.slice.call({ length: 3, 0: 5, 1: 6, 2: 7 }, 0, 2);
        var thrown = 0; try { Array.prototype.slice.call(null, 1); } catch (e) { thrown = e instanceof TypeError ? 1 : 2; }
        return f(1, 2, 3).length * 1000 + r.length * 100 + r[1] * 10 + thrown; }`;
    expect(await runStandalone(src, true)).toBe(2000 + 200 + 60 + 1);
  });
});

describe("#6701 Math.max/min .apply/.call (standalone)", () => {
  it("Math.max.apply(null, [3, 9, 1]) folds the array (the issue repro)", async () => {
    expect(await runStandalone(`export function test(){ return Math.max.apply(null, [3, 9, 1]); }`)).toBe(9);
  });

  it("min, call, an any array, arguments, Reflect.apply and the empty list", async () => {
    const src = `${ID}
      function g(a?: any, b?: any, c?: any) { return Math.max.apply(null, arguments as any); }
      export function test(){
        var sum = Math.min.apply(Math, [3, 9, 1]) * 100000
          + Math.max.call(null, 3, 9, 1) * 10000
          + Math.max.call(null, 5) * 1000
          + Math.max.apply(null, id([4, 2])) * 100
          + g(4, 12, 7)
          + Reflect.apply(Math.min, null, [8, 6]) * 1000000;
        return Math.max.apply(null, []) === -Infinity ? sum : -1; }`;
    expect(await runStandalone(src)).toBe(6000000 + 100000 + 90000 + 5000 + 400 + 12);
  });

  it("a user function's apply and String.fromCharCode.call keep their answers", async () => {
    const src = `${ID} function mx(a: number, b: number) { return a > b ? a : b; }
      export function test(){ var m: any = id(mx);
        return m.apply(null, [3, 9]) * 10 + (String.fromCharCode.call(null, 104, 105) === "hi" ? 1 : 0); }`;
    expect(await runStandalone(src)).toBe(91);
  });
});
