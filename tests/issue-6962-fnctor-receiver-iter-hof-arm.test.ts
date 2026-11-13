// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6962 — standalone: a dynamic `.find()/.map()/…` call on a receiver the call
// site cannot type (a module var assigned in another function) whose runtime
// value is a raw function-constructor instance (`__fnctor_F` struct) was routed
// to the #2903 Iterator-helper arms (`__iter_hof_<name>` / `__iter_lazy_<name>`)
// instead of the user's `F.prototype.<name>`. `find` answered undefined, `map`
// a `$LazyIterHelper` wrapper. Octane splay's `splayTree.find(key)` never ran,
// so a duplicate key got inserted and TearDown threw "Splay tree has wrong
// size" from rep 110 on.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
  } as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = new WebAssembly.Instance(mod, {});
  return (exports as { main: () => unknown }).main();
}

describe("#6962 fnctor-instance receiver vs Iterator-helper arms (standalone)", () => {
  it("splay repro: find() reaches F.prototype.find on an untyped module var", async () => {
    const src = `
      function Tree() {}
      Tree.prototype.root_ = null;
      Tree.prototype.find = function (key) { return this.root_ == key ? this : null; };
      Tree.prototype.findMax = function (key) { return this.root_ == key ? this : null; };
      Tree.prototype.insert = function (key) { this.root_ = key; };
      var tree = null;
      function Setup() { tree = new Tree(); tree.insert(0.5); }
      function Probe() {
        return (tree.find(0.5) != null ? 1 : 0) + (tree.findMax(0.5) != null ? 10 : 0)
          + (tree.find(0.25) == null ? 100 : 0);
      }
      export function main() { Setup(); return Probe(); }`;
    expect(await runStandalone(src)).toBe(111);
  });

  it("every eager and lazy Iterator-helper name dispatches to the user method", async () => {
    const src = `
      function Bag() { this.n = 3; }
      Bag.prototype.find = function (k) { return 1; };
      Bag.prototype.every = function (f) { return 2; };
      Bag.prototype.some = function (f) { return 3; };
      Bag.prototype.forEach = function (f) { return 4; };
      Bag.prototype.reduce = function (f, init) { return 5 + init; };
      Bag.prototype.toArray = function () { return 6; };
      Bag.prototype.map = function (f) { return 7; };
      Bag.prototype.filter = function (f) { return 8; };
      Bag.prototype.take = function (n) { return 9; };
      Bag.prototype.drop = function (n) { return 10; };
      Bag.prototype.flatMap = function (f) { return 11; };
      var bag = null;
      function setup() { bag = new Bag(); }
      export function main() {
        setup();
        var cb = function (x) { return x; };
        var got = [bag.find(1), bag.every(cb), bag.some(cb), bag.forEach(cb), bag.reduce(cb, 0),
          bag.toArray(), bag.map(cb), bag.filter(cb), bag.take(2), bag.drop(1), bag.flatMap(cb)];
        var ok = 0;
        for (var i = 0; i < got.length; i++) if (got[i] === i + 1) ok++;
        return ok;
      }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("negative control: a generator receiver still takes the Iterator-helper arms", async () => {
    const src = `
      function Bag() {}
      Bag.prototype.map = function (f) { return -1; };
      function* gen() { yield 1; yield 2; yield 3; }
      var it = null, it2 = null, bag = null;
      function setup() { it = gen(); it2 = gen(); bag = new Bag(); }
      export function main() {
        setup();
        var a = it.map(function (x) { return x * 2; }).toArray();
        var found = it2.find(function (x) { return x > 1; });
        return a.length * 1000 + a[2] * 100 + found * 10 + (bag.map(null) === -1 ? 1 : 0);
      }`;
    expect(await runStandalone(src)).toBe(3000 + 600 + 20 + 1);
  });

  it("negative control: a plain object literal receiver keeps its own method", async () => {
    const src = `
      var o = null;
      function setup() { o = { find: function (k) { return k + 1; } }; }
      export function main() { setup(); return o.find(41); }`;
    expect(await runStandalone(src)).toBe(42);
  });
});
