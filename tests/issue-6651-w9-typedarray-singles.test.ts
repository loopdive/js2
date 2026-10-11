/**
 * #6651 slice W9 — TypedArray singles. Every case compiles `--target
 * standalone` and asserts the binary imports NOTHING.
 *
 * 1. (#5185) A heterogeneous literal row read inside a callback:
 *    `items.forEach(function (item) { var expected = item[1]; … })` over
 *    `[[-0, 0, "-0"], ["", 0, "…"], [true, 1, "…"], [null, 0, "…"]]`
 *    (`TypedArrayConstructors/ctors/length-arg/toindex-length.js`). `expected`
 *    is a `string | number | boolean | null` `$AnyValue` slot fed by a dynamic
 *    element read (externref). The generic boxing default keeps the #1888
 *    tag-5 lie, so the boxed NUMBER was stored as a "string": `typeof` said
 *    not-number and `expected === 0` was false. A primitive-only union slot is
 *    now boxed honestly.
 *
 * 2. (#6484) `new TA(array)` with a patched `%ArrayIteratorPrototype%.next`
 *    (`ctors/object-arg/iterated-array-with-modified-array-iterator.js`). The
 *    dynamic TA constructor copied the vec directly; it now consults the patch,
 *    calling it with a genuine array iterator as `this` (so a patch that
 *    delegates to the original still steps the real cursor).
 *
 * Cases are RED on the base commit except the one marked GUARD, which pins the
 * unpatched fast path (green on base too).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 W9 · 1 (#5185) · heterogeneous literal row read through a dynamic receiver", () => {
  it("a forEach callback reads number/string elements of a 4-kind row with their real types", async () => {
    const src = `
      var items = [
        [-0, 0, "-0"],
        ["", 0, "the Empty string"],
        [true, 1, "true"],
        [null, 0, "null"],
      ];
      var calls = 0, num = 0, str = 0, same = 0;
      items.forEach(function (item) {
        var expected = item[1];
        var name = item[2];
        calls++;
        if (typeof expected === "number") num++;
        if (typeof name === "string") str++;
        if (expected === 0 || expected === 1) same++;
      });
      export function test() { return calls * 1000 + num * 100 + str * 10 + same; }`;
    expect(await run(src)).toBe(4444);
  });

  it("an indexed loop over the same rows (the externref receiver path)", async () => {
    const src = `
      var items = [[-0, 0, "a"], ["", 0, "b"], [true, 1, "c"], [null, 0, "d"]];
      var n = 0, sum = 0;
      for (var i = 0; i < items.length; i++) {
        var x = items[i][1];
        if (typeof x === "number") n++;
        sum += x;
      }
      export function test() { return n * 10 + sum; }`;
    expect(await run(src)).toBe(41);
  });

  it("nullish and string members of the union keep their identity", async () => {
    const src = `
      var items = [[null, "s", 1], [undefined, "t", true]];
      var r = 0;
      items.forEach(function (item) {
        var a = item[0];
        var b = item[1];
        if (a === null) r += 1;
        if (a === undefined) r += 10;
        if (typeof b === "string" && b.length === 1) r += 100;
      });
      export function test() { return r; }`;
    expect(await run(src)).toBe(211);
  });
});

describe("#6651 W9 · 2 (#6484) · patched %ArrayIteratorPrototype%.next and new TA(array)", () => {
  it("the patch is consulted by a dynamic TypedArray constructor", async () => {
    const src = `
      let AIP = Object.getPrototypeOf([].values());
      let values;
      AIP.next = function () {
        let done = values.length === 0;
        let value = values.pop();
        return { value, done };
      };
      var r = 0;
      function make(TA) {
        values = [1, 2, 3, 4];
        var ta = new TA([0]);
        if (ta.length === 4 && ta[0] === 4 && ta[1] === 3 && ta[2] === 2 && ta[3] === 1) r++;
      }
      make(Float64Array);
      make(Int8Array);
      make(Uint16Array);
      export function test() { return r; }`;
    expect(await run(src)).toBe(3);
  });

  it("a patch that delegates to the original steps the genuine iterator", async () => {
    const src = `
      let AIP = Object.getPrototypeOf([].values());
      let orig = AIP.next;
      var calls = 0;
      AIP.next = function () { calls++; return orig.call(this); };
      var r = 0;
      function make(TA) {
        var ta = new TA([7, 8, 9]);
        if (ta.length === 3 && ta[0] === 7 && ta[1] === 8 && ta[2] === 9) r += 1;
      }
      make(Uint8Array);
      export function test() { return r * 10 + calls; }`;
    expect(await run(src)).toBe(14);
  });

  it("GUARD: an unpatched (but materialised) prototype keeps the direct copy", async () => {
    const src = `
      let AIP = Object.getPrototypeOf([].values());
      var r = typeof AIP.next === "function" ? 1 : 0;
      function make(TA) {
        var ta = new TA([5, 6]);
        if (ta.length === 2 && ta[0] === 5 && ta[1] === 6) r += 10;
      }
      make(Float64Array);
      make(Int32Array);
      export function test() { return r; }`;
    expect(await run(src)).toBe(21);
  });
});
