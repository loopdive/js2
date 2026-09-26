// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 IT3) `%TypedArray%.prototype.{values,keys,entries}` on a DYNAMICALLY
// typed view in `--target standalone`.
//
// The receiver shape under test is the one test262's
// `testWithTypedArrayConstructors(function (TA) { new TA([…]).values() })`
// actually produces: the constructor arrives as a parameter, so the view's
// static type is `any` and its runtime brand is `$__ta_dyn_view`. Before this
// slice `ta.values()` answered `null` on that shape (measured on cb2e265852),
// which is why `built-ins/TypedArray/prototype/{values,keys,entries}/
// {return-itor,iter-prototype}.js` all failed on standalone while three of them
// passed on host.
//
// The assertions below are deliberately about the ITERATOR OBJECT, not just the
// first value: the defect that made the naive fix a no-op was that the static
// `arr.values()` lowering returns a bare canonical `$Vec` rather than an
// `$__IterRec`, and a bare vec answers `.length`/`Array.isArray` and a `null`
// `.next()`. So each shape is checked for (a) a real step, (b) exhaustion, and
// (c) `%ArrayIteratorPrototype%` identity against `[][Symbol.iterator]()`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-it3.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports, "standalone output leaked host imports").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 IT3 — dyn-view %TypedArray%.prototype iterator factories (standalone)", () => {
  it("values() yields each element in order and then exhausts", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([5, 6, 7]);
          var it = ta.values();
          if (it === null || it === undefined) return -1;
          var a = it.next();
          var b = it.next();
          var c = it.next();
          var d = it.next();
          if (a.done || b.done || c.done || !d.done) return -2;
          if (d.value !== undefined) return -3;
          return a.value * 100 + b.value * 10 + c.value;
        }
        return probe(Int8Array);
      }`),
    ).toBe(567);
  });

  it("keys() yields indices, not elements", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([5, 6, 7]);
          var it = ta.keys();
          var a = it.next().value;
          var b = it.next().value;
          var c = it.next().value;
          if (it.next().done !== true) return -1;
          return a * 100 + b * 10 + c;
        }
        return probe(Uint16Array);
      }`),
    ).toBe(12);
  });

  it("entries() yields two-slot [index, value] pairs", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([5, 6, 7]);
          var it = ta.entries();
          var p0 = it.next().value;
          var p1 = it.next().value;
          if (p0.length !== 2 || p1.length !== 2) return -1;
          return p0[0] * 1000 + p0[1] * 100 + p1[0] * 10 + p1[1];
        }
        return probe(Float64Array);
      }`),
    ).toBe(516);
  });

  it("the returned iterator's [[Prototype]] IS %ArrayIteratorPrototype%", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([1, 2]);
          var expected = Object.getPrototypeOf([][Symbol.iterator]());
          var got = 0;
          if (Object.getPrototypeOf(ta.values()) === expected) got += 1;
          if (Object.getPrototypeOf(ta.keys()) === expected) got += 2;
          if (Object.getPrototypeOf(ta.entries()) === expected) got += 4;
          return got;
        }
        return probe(Int32Array);
      }`),
    ).toBe(7);
  });

  it("for-of drains a dyn-view values() iterator", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([5, 6, 7]);
          var sum = 0;
          for (var v of ta.values()) sum += v;
          return sum;
        }
        return probe(Int8Array);
      }`),
    ).toBe(18);
  });

  it("an own expando member still shadows the inherited factory (§7.3.2)", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([1, 2, 3]);
          ta.values = function () { return 42; };
          return ta.values();
        }
        return probe(Int8Array);
      }`),
    ).toBe(42);
  });

  it("each call returns a FRESH iterator", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var ta = new TA([9, 8]);
          var a = ta.values();
          var b = ta.values();
          a.next();
          // b must still be at slot 0 — a shared cursor would answer 8 here.
          return b.next().value;
        }
        return probe(Int8Array);
      }`),
    ).toBe(9);
  });
});
