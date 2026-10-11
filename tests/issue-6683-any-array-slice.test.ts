// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6683 — standalone: `.slice(0)` on an untyped (`any`) Array receiver
// answered null, which was moment's standalone-dynamic blocker
// (`getParsingFlags(config).parsedDateParts = config._a.slice(0)`, then
// `some.call(null, …)` threw). `slice`/`at` are also String.prototype names,
// so the guarded native-string lowering claimed the call and its
// `$AnyString`-miss arm answered the string method's null sentinel;
// `reverse` fell to the dispatcher's open-`$Object` arm (undefined).
//
// Two companion defects sat in front of it on the moment lane and are pinned
// here too:
//   - `ensureAnyHelpers` re-entrancy — in its own file (memory-heavy):
//     tests/issue-6683-any-helpers-reentry.test.ts.
//   - `runtimeEvalProvider: false`: a bare `Function` read still routed
//     through the runtime-eval provider and imported `js2wasm:runtime-eval`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, opts: Record<string, unknown> = {}): Promise<unknown> {
  const r = await compile(src, { target: "standalone", ...opts } as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = new WebAssembly.Instance(mod, {});
  return (exports as { test: () => unknown }).test();
}

const ID = `function id(v: any): any { return v; }`;

describe("#6683 slice / at / reverse on an any Array receiver (standalone)", () => {
  it("slice(0) copies the array (the issue repro)", async () => {
    expect(
      await runStandalone(
        `${ID} export function test(){ var r = id([1,2,3]).slice(0); return r === null ? -1 : r.length; }`,
      ),
    ).toBe(3);
  });

  it("slice through a property of an any parameter (moment's config._a)", async () => {
    const src = `function run2(c: any){ c._a = [2020, 0, 2]; return c._a.slice(0); }
      export function test(){ var r = run2({}); return r === null ? -1 : r.length * 10000 + r[0]; }`;
    expect(await runStandalone(src)).toBe(32020);
  });

  it("slice honours start/end, negatives, and absent/undefined end", async () => {
    const src = `${ID} export function test(){
      var a = id([1,2,3,4]);
      var x = a.slice(1, 3), y = a.slice(-2), z = a.slice(), w = a.slice(1, undefined), v = a.slice(3, 1);
      return x.length*10000 + x[1]*1000 + y[0]*100 + z.length*10 + w.length + v.length; }`;
    expect(await runStandalone(src)).toBe(2 * 10000 + 3 * 1000 + 3 * 100 + 4 * 10 + 3 + 0);
  });

  it("the slice is a copy, and Array.prototype.some accepts it", async () => {
    const src = `${ID} export function test(){
      var a = id([1,2,3]); var r = a.slice(0); r[0] = 9;
      var hit = [].some.call(r, function(x: any){ return x === 3; });
      return a[0]*100 + r[0]*10 + (hit ? 1 : 0); }`;
    expect(await runStandalone(src)).toBe(191);
  });

  it("at and reverse answer on an any receiver", async () => {
    const src = `${ID} export function test(){
      var a = id([1,2,3]); var b = a.at(-1); var c = a.at(5);
      var r = id([1,2,3,4]).reverse();
      return b*1000 + (c === undefined ? 100 : 0) + r[0]*10 + r[3]; }`;
    expect(await runStandalone(src)).toBe(3000 + 100 + 40 + 1);
  });

  it("a string any receiver and a user slice method keep their answers", async () => {
    const src = `${ID} export function test(){
      var s = id("hello").slice(1, 3);
      var o = id({ slice: function(n: any){ return n + 40; } });
      return (s === "el" ? 100 : 0) + o.slice(2); }`;
    expect(await runStandalone(src)).toBe(142);
  });
});

describe("#6683 companions on the moment lane", () => {
  it("runtimeEvalProvider:false keeps a bare Function read import-free and identity-stable", async () => {
    const src = `var F: any = Function; function g(){}
      export function test(){ return (g.constructor === F ? 10 : 0) + (typeof F === "function" ? 1 : 0); }`;
    expect(await runStandalone(src, { runtimeEvalProvider: false })).toBe(11);
  });
});
