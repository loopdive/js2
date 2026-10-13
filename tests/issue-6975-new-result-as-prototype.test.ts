// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6975 — standalone: `y.prototype = new K` (Octane box2d's `Box2D.inherit`,
// deltablue's `Derived.prototype = new Inheriter()`) kept the `new K` result as
// a `$__fnctor_K` struct. A [[Prototype]] link must be an `$Object`:
// `__object_create` and the `$proto` walk drop any other node, so every
// instance of the subclass lost the inherited methods (`SetAsEdge` / `hello`
// "called value is not a function"). The reconstruct gate now treats the
// right-hand side of a `.prototype` store as an externref consumer, so an
// approved empty-body `new K` is built as the `$Object` it becomes.
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

/** Sum of 2^i over the true entries, so one number reports every row. */
const MASK = `function mask(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i]) m += 1 << i; return m; }`;

describe("#6975 a `new F` stored as a prototype is an $Object (standalone)", () => {
  it("Box2D.inherit shape: a subclass constructed through a value reaches both prototypes", async () => {
    const src = `${MASK}
      var NS = {};
      (function () { function q() { this.q = 2; } NS.Poly = q; })();
      function K() {}
      function Base() {}
      Base.prototype.hello = function () { return 7; };
      function inherit(y, w) { K.prototype = w.prototype; y.prototype = new K; y.prototype.constructor = y; }
      inherit(NS.Poly, Base);
      NS.Poly.prototype.edge = function () { return 4; };
      function make(C) { return new C(); }
      export function main() {
        var s = make(NS.Poly);
        return mask([s.edge() === 4, s.hello() === 7, s.q === 2, s instanceof Base, s instanceof NS.Poly,
          s.constructor === NS.Poly]);
      }`;
    expect(await runStandalone(src)).toBe(63);
  });

  it("direct `new Sub()` after `Sub.prototype = new K()`", async () => {
    const src = `${MASK}
      function Base() {}
      Base.prototype.hello = function () { return 7; };
      function K() {}
      K.prototype = Base.prototype;
      function Sub() { this.s = 1; }
      Sub.prototype = new K();
      Sub.prototype.constructor = Sub;
      Sub.prototype.edge = function () { return 4; };
      export function main() {
        var s = new Sub();
        return mask([s.edge() === 4, s.hello() === 7, s.s === 1, s.constructor === Sub,
          Object.getPrototypeOf(Sub.prototype) === Base.prototype]);
      }`;
    expect(await runStandalone(src)).toBe(31);
  });

  it("instanceof across a two-level chain built from `new` results", async () => {
    const src = `${MASK}
      function Base() {}
      Base.prototype.hello = function () { return 7; };
      function K1() {}
      K1.prototype = Base.prototype;
      function Mid() {}
      Mid.prototype = new K1();
      Mid.prototype.mid = function () { return 5; };
      function K2() {}
      K2.prototype = Mid.prototype;
      function Leaf() {}
      Leaf.prototype = new K2();
      export function main() {
        var l = new Leaf();
        return mask([l instanceof Leaf, l instanceof Mid, l instanceof Base, l instanceof Object,
          l.hello() === 7, l.mid() === 5, Base.prototype.isPrototypeOf(l)]);
      }`;
    expect(await runStandalone(src)).toBe(127);
  });

  it("control: a `new K` stored into an ordinary member keeps working", async () => {
    const src = `${MASK}
      function K() {}
      K.prototype.tag = 3;
      var o = {};
      o.k = new K();
      export function main() { return mask([o.k.tag === 3, o.k instanceof K]); }`;
    expect(await runStandalone(src)).toBe(3);
  });
});
