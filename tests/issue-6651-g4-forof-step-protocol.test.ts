// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 cluster G, slice G4 — the for-of step-loop protocol and two
 * non-iterable array-assignment sources, standalone.
 *
 * 1. §7.4.1 / §7.4.4: a plain-object iterator's `next` is read ONCE, at
 *    GetIterator, and every step calls that cached method
 *    (`for-of/iterator-next-reference.js`).
 * 2. §7.4.4 step 3: a `next()` result that is not an Object is a TypeError
 *    (`for-of/iterator-next-result-type.js`).
 * 3. §23.1.5.1: the array iterator's `Get(array, index)` observes an index
 *    accessor, so a throwing getter propagates out of the loop
 *    (`for-of/array-key-get-error.js`).
 * 4. §13.15.5.2 → GetIterator: `[a] = { x: 1 }` and `for ([,] of [Symbol()])`
 *    throw TypeError instead of binding `undefined`
 *    (`for-of/dstr/array-elision-val-symbol.js`).
 *
 * Cases 1–4 are RED on the branch base (file-copy A/B); the guards at the end
 * are green on both and pin that ordinary iteration is unchanged.
 *
 * Each program runs at MODULE scope and builds a number `r`; `test()` returns
 * it. The host lane is not exercised: every G4 hook is standalone-only.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(program: string): Promise<number> {
  const result = await compile(`${program}\nexport function test() { return r; }`, {
    allowJs: true,
    fileName: "issue-6651-g4.js",
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module).map((e) => `${e.module}::${e.name}`)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  return exports.test!();
}

describe("#6651 G4 — for-of IteratorStep protocol (standalone)", () => {
  it("reads an object iterator's `next` once, before the first step", async () => {
    const program = `
      var iterable = {};
      var iterator = {};
      var iterationCount = 0;
      var loadNextCount = 0;
      iterable[Symbol.iterator] = function () { return iterator; };
      function next() {
        if (iterationCount) return { done: true };
        return { value: 45, done: false };
      }
      Object.defineProperty(iterator, "next", { get() { loadNextCount++; return next; }, configurable: true });
      var r = 0;
      try {
        for (var x of iterable) {
          if (x !== 45) r = 100;
          Object.defineProperty(iterator, "next", { get: function () { throw new Error("re-read"); } });
          iterationCount++;
        }
      } catch (e) { r = 200; }
      r = r + iterationCount * 10 + loadNextCount;`;
    expect(await run(program)).toBe(11);
  });

  it("throws TypeError for every non-Object `next()` result", async () => {
    const program = `
      var iterable = {};
      var firstIterResult;
      iterable[Symbol.iterator] = function () {
        var finalIterResult = { value: null, done: true };
        var nextIterResult = firstIterResult;
        return { next: function () { var res = nextIterResult; nextIterResult = finalIterResult; return res; } };
      };
      var r = 0;
      function t(v, bit) {
        firstIterResult = v;
        try { for (var x of iterable) {} } catch (e) { if (e instanceof TypeError) r |= bit; }
      }
      t(true, 1); t(false, 2); t("string", 4); t(undefined, 8); t(null, 16); t(4, 32); t(NaN, 64); t(Symbol("s"), 128);`;
    expect(await run(program)).toBe(255);
  });

  it("propagates a throwing index getter out of an array for-of", async () => {
    const program = `
      var array = [];
      var iterationCount = 0;
      Object.defineProperty(array, "0", { get: function () { throw new RangeError(); } });
      var r = 0;
      try { for (var value of array) { iterationCount += 1; } } catch (e) { r = e instanceof RangeError ? 1 : 2; }
      r = r + iterationCount * 10;`;
    expect(await run(program)).toBe(1);
  });
});

describe("#6651 G4 — a non-iterable array-assignment source throws (standalone)", () => {
  it("`[a] = { x: 1 }` throws TypeError", async () => {
    const program = `
      var r = 0;
      var a;
      try { [a] = { x: 1 }; r = 1; } catch (e) { r = e instanceof TypeError ? 2 : 3; }`;
    expect(await run(program)).toBe(2);
  });

  it("`for ([,] of [Symbol()])` throws TypeError before the body", async () => {
    const program = `
      var s = Symbol();
      var r = 0;
      var a;
      try { for ([,] of [s]) { r |= 4; } r |= 1; } catch (e) { r |= e instanceof TypeError ? 2 : 8; }
      try { for ([a] of [s]) { r |= 64; } r |= 16; } catch (e) { r |= e instanceof TypeError ? 32 : 128; }`;
    expect(await run(program)).toBe(2 | 32);
  });
});

describe("#6651 G4 — guards: ordinary iteration is unchanged (standalone)", () => {
  it("steps object and closed-struct iterators and their results", async () => {
    const program = `
      var r = 0;
      var o = {};
      o[Symbol.iterator] = function () {
        var i = 0;
        return { next: function () { i++; return i > 3 ? { value: 0, done: true } : { value: i, done: false }; } };
      };
      for (var x of o) r += x;
      var p = {};
      p[Symbol.iterator] = function () {
        var j = 0;
        var it = {};
        it.next = function () { j++; var res = {}; res.done = j > 2; res.value = j * 100; return res; };
        return it;
      };
      for (var y of p) r += y;
      for (var z of [1000, 2000]) r += z;
      var a, b;
      [a, b] = [5, 6];
      r += a * b;`;
    expect(await run(program)).toBe(1 + 2 + 3 + 100 + 200 + 1000 + 2000 + 30);
  });

  it("iterates a Map and a self-iterating object literal", async () => {
    const program = `
      var r = 0;
      var m = new Map([[1, 2], [3, 4]]);
      for (var [k, v] of m) r += k * v;
      function gen() {
        var i = 0;
        return { [Symbol.iterator]() { return this; }, next() { i++; return { value: i, done: i > 3 }; } };
      }
      var s = 0;
      for (var w of gen()) s += w;
      r += s * 100;`;
    expect(await run(program)).toBe(14 + 600);
  });
});
