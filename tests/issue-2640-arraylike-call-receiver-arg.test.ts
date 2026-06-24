// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2640) `Array.prototype.X.call(arrayLike, cb)` over a DYNAMIC (non-vec)
// array-like receiver passes that receiver back as the callback's array
// argument. TypeScript infers that parameter as the array type (`T[]`) from the
// method's callback signature, so codegen lowered it to a typed WasmGC vec ref.
// The actual receiver is a dynamic externref (not a vec), so the dispatch loop
// pushed `ref.null` for the argument and the callback's `obj.length` / `obj[i]`
// lowered to `struct.get $__vec_base 0` on null → "dereferencing a null pointer".
//
// Fix (gated on `ctx.forceExternrefCallbackParams`, set ONLY for this non-vec
// array-like path — real `__vec_`/`__arr_` receivers bail out upstream so the
// typed `arr.forEach(cb)` hot path is untouched): widen vec/array callback
// params to externref so `obj.length`/`obj[i]` route through the tag-aware
// dynamic reader.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2640 array-like generic-method callback receiver argument", () => {
  it("forEach.call(arrayLike): cb reads obj.length (was: null deref)", async () => {
    expect(
      await run(
        `export function run() {
           let got = -1;
           Array.prototype.forEach.call({ 0: 5, 1: 6, length: 2 },
             function (v, i, obj) { got = obj.length; });
           return got;
         }`,
      ),
    ).toBe(2);
  });

  it("forEach.call(arrayLike): cb reads obj[i] (was: null deref)", async () => {
    expect(
      await run(
        `export function run() {
           let got = -1;
           Array.prototype.forEach.call({ 0: 5, 1: 6, length: 2 },
             function (v, i, obj) { got = obj[0]; });
           return got;
         }`,
      ),
    ).toBe(5);
  });

  it("forEach.call(arrayLike): value and index args still correct", async () => {
    expect(
      await run(
        `export function run() {
           let sum = 0;
           let lastIdx = -1;
           Array.prototype.forEach.call({ 0: 5, 1: 6, length: 2 },
             function (v, i, obj) { sum += v; lastIdx = i; });
           return sum * 10 + lastIdx;
         }`,
      ),
    ).toBe(111); // sum=11, lastIdx=1 → 110 + 1
  });

  it("map.call(arrayLike): cb reads obj.length", async () => {
    expect(
      await run(
        `export function run() {
           const r = Array.prototype.map.call({ 0: 1, 1: 2, 2: 3, length: 3 },
             function (v, i, obj) { return v + obj.length; });
           return r[0] + r[1] + r[2];
         }`,
      ),
    ).toBe(15); // (1+3)+(2+3)+(3+3) = 4+5+6
  });

  it("some.call(arrayLike): cb reads obj[i] against value", async () => {
    expect(
      await run(
        `export function run() {
           const ok = Array.prototype.some.call({ 0: 7, 1: 8, length: 2 },
             function (v, i, obj) { return obj[i] === 8; });
           return ok ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("every.call(arrayLike): cb reads obj.length each iteration", async () => {
    expect(
      await run(
        `export function run() {
           const ok = Array.prototype.every.call({ 0: 1, 1: 2, length: 2 },
             function (v, i, obj) { return obj.length === 2; });
           return ok ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("filter.call(arrayLike): cb reads obj[i]", async () => {
    expect(
      await run(
        `export function run() {
           const r = Array.prototype.filter.call({ 0: 10, 1: 20, 2: 30, length: 3 },
             function (v, i, obj) { return obj[i] >= 20; });
           return r.length * 100 + r[0];
         }`,
      ),
    ).toBe(220); // [20,30] → length 2, r[0] 20
  });

  it("typed array hot path is untouched: [1,2,3].map(x=>x*2)", async () => {
    expect(
      await run(
        `export function run() {
           const a = [1, 2, 3];
           const b = a.map(function (x) { return x * 2; });
           return b[0] + b[1] + b[2];
         }`,
      ),
    ).toBe(12);
  });

  it("typed array forEach callback can still read its array arg", async () => {
    // Regression guard: the typed `arr.forEach(cb)` path never enters
    // compileArrayLikePrototypeCall, so the param widening must not change it.
    expect(
      await run(
        `export function run() {
           const a = [4, 5, 6];
           let total = 0;
           a.forEach(function (v, i, arr) { total += v + arr.length; });
           return total;
         }`,
      ),
    ).toBe(24); // (4+5+6) + 3*3 = 15 + 9
  });
});
