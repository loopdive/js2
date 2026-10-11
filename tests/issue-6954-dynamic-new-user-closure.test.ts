// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6954 — standalone `new <callee>(…)` where the callee is a runtime user
 * closure the compiler cannot resolve statically: an `any`-typed alias of a
 * nested function declaration exported through a member (Octane box2d's
 * `var F = Box2D.Common.Math.b2Mat22; new F`), or a member slot holding the
 * RESULT of a factory call (`NS.C = create(); new NS.C(3)`). Expected values
 * are node's.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, octane: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6954.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    // Octane harness options: Script goal, no runtime-eval provider.
    ...(octane ? { inferModuleStrictArguments: false, runtimeEvalProvider: false } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "standalone Wasm imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { main: () => number }).main();
}

const CASES: { name: string; expected: number; source: string }[] = [
  {
    name: "nested fn decl exported via member, aliased, `new F` at module init (box2d)",
    expected: 7,
    source: `
      var NS = {};
      (function () { function g() { this.v = 7; } NS.g = g; })();
      var out = 0;
      (function () { var F = NS.g; var Q = new F; out = Q.v; })();
      export function main() { return out; }`,
  },
  {
    name: "aliased nested fn decl with prototype methods and arguments (box2d b2Mat22.FromVV)",
    expected: 3,
    source: `
      var Box2D = { Common: { Math: {} } };
      (function () {
        function g() { g.b2Mat22.apply(this, arguments); if (this.constructor === g) this.b2Mat22.apply(this, arguments); }
        function r() { r.b2Vec2.apply(this, arguments); if (this.constructor === r) this.b2Vec2.apply(this, arguments); }
        Box2D.Common.Math.b2Mat22 = g; Box2D.Common.Math.b2Vec2 = r;
      })();
      (function () {
        var F = Box2D.Common.Math.b2Mat22, A = Box2D.Common.Math.b2Vec2;
        A.b2Vec2 = function () {}; A.prototype.b2Vec2 = function () { this.x = 0; this.y = 0; };
        F.b2Mat22 = function () { this.col1 = new A; this.col2 = new A; };
        F.prototype.b2Mat22 = function () { this.SetIdentity(); };
        F.prototype.SetIdentity = function () { this.col1.x = 1; this.col2.y = 1; };
        F.prototype.SetVV = function (p, B) { this.col1.x = p; this.col2.y = B; };
        F.FromVV = function (p, B) { var Q = new F; Q.SetVV(p, B); return Q; };
      })();
      export function main() { return Box2D.Common.Math.b2Mat22.FromVV(2, 3).col2.y; }`,
  },
  {
    name: "class-bearing module: aliased user fn and aliased class both construct",
    expected: 71,
    source: `
      class K { constructor() { this.k = 1; } }
      var NS = {};
      (function () { function g(a, b) { this.v = a + b; } NS.g = g; NS.K = K; })();
      export function main() { var F = NS.g; var C = NS.K; var q = new F(3, 4); var k = new C(); return q.v * 10 + k.k; }`,
  },
  {
    name: "member slot holding a factory-returned function expression",
    expected: 3,
    source: `
      function create() { return function (x) { this.x = x; }; }
      var NS = {};
      NS.C = create();
      export function main() { return new NS.C(3).x * 1; }`,
  },
  {
    name: "control: identifier holding a factory-returned function expression",
    expected: 3,
    source: `
      function create() { return function (x) { this.x = x; }; }
      var P = create();
      export function main() { return new P(3).x * 1; }`,
  },
  {
    name: "negative: arrow / method / number via any-typed alias throw TypeError; Array and Map aliases still construct",
    expected: 13111,
    source: `
      var NS = {};
      (function () { NS.a = () => 1; NS.m = { m() { return 1; } }.m; NS.A = Array; NS.M = Map; NS.n = 5; })();
      function probe(F) { try { new F(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
      export function main() {
        var A = NS.A, M = NS.M;
        var r = probe(NS.a) + probe(NS.m) * 10 + probe(NS.n) * 100;
        var arr = new A(3); var mp = new M(); mp.set(1, 2);
        return r + arr.length * 1000 + mp.size * 10000;
      }`,
  },
  {
    name: "negative: generator and method member values stay non-constructors",
    expected: 11,
    source: `
      function mkGen() { return function* () { yield 1; }; }
      var NS = {};
      NS.G = mkGen();
      NS.o = { m() { return 1; } };
      export function main() {
        var r = 0;
        try { new NS.G(); } catch (e) { r += e instanceof TypeError ? 1 : 2; }
        try { new NS.o.m(); } catch (e) { r += e instanceof TypeError ? 10 : 20; }
        return r;
      }`,
  },
];

describe("#6954 standalone dynamic new on an unresolvable user closure", () => {
  for (const octane of [false, true]) {
    for (const c of CASES) {
      it(`${octane ? "[octane opts] " : ""}${c.name}`, async () => {
        expect(await runStandalone(c.source, octane)).toBe(c.expected);
      }, 60_000);
    }
  }
});
