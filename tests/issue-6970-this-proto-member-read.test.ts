// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6970 — standalone: a `this.<m>` VALUE read inside a constructor function
 * (`this.init.apply(this, arguments)`) must reach `F.prototype.m`. The field
 * auto-register arm of `finalizeStructAndDynamicMemberGet` used to mint an own
 * `$__fnctor_F` struct field for `m` (the TS instance type of a constructor
 * function lists its prototype members), so the read became a `struct.get` of a
 * never-written slot shadowing the prototype — box2dweb's
 * `K.b2X.apply(this, arguments); this.constructor === K && this.b2X.apply(…)`
 * idiom. Expected values are node's.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, octane: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6970.js",
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
    name: "this.init.apply(this, arguments) in a declared ctor (bx18)",
    expected: 5,
    source: `
      function K() { this.init.apply(this, arguments); }
      K.prototype.init = function (v) { this.r = v; };
      export function main() { return new K(5).r; }`,
  },
  {
    name: "same idiom, ctor as a var-bound function expression (bx17)",
    expected: 5,
    source: `
      var K = function () { this.init.apply(this, arguments); };
      K.prototype.init = function (v) { this.r = v; };
      export function main() { return new K(5).r; }`,
  },
  {
    name: "member read into a local, then .call (bx23)",
    expected: 5,
    source: `
      function K(v) { var f = this.init; f.call(this, v); }
      K.prototype.init = function (v) { this.r = v; };
      export function main() { return new K(5).r; }`,
  },
  {
    name: "box2dweb wrapper: static + prototype initialiser, constructor guard (bx10)",
    expected: 11,
    source: `
      var K = function () { K.b2Transform.apply(this, arguments); if (this.constructor === K) this.b2Transform.apply(this, arguments); };
      K.b2Transform = function () {};
      K.prototype.b2Transform = function () { this.position = 1; };
      export function main() { var k = new K(); return (k.constructor === K ? 10 : 0) + (typeof k.position === "number" ? 1 : 0); }`,
  },
  {
    name: "box2dweb wrapper with a function declaration (bx27)",
    expected: 11,
    source: `
      var Box2D = {};
      function w() { w.b2T.apply(this, arguments); if (this.constructor === w) this.b2T.apply(this, arguments); }
      Box2D.b2Transform = w;
      w.b2T = function () { this.position = 1; };
      w.prototype.b2T = function (pos) { this.extra = 3; };
      (function () { var K = Box2D.b2Transform; function Body() { this.m_xf = new K(); } Box2D.Body = Body; })();
      export function main() { var b = new Box2D.Body(); return (typeof b.m_xf.position === "number" ? 10 : 0) + (typeof b.m_xf.extra === "number" ? 1 : 0); }`,
  },
  {
    name: "control: method CALL form this.init(v) (bx25)",
    expected: 5,
    source: `
      function K(v) { this.init(v); }
      K.prototype.init = function (v) { this.r = v; };
      export function main() { return new K(5).r; }`,
  },
  {
    name: "control: prototype assigned through an alias (bx22)",
    expected: 5,
    source: `
      function K() { this.init.apply(this, arguments); }
      var p = K.prototype; p.init = function (v) { this.r = v; };
      export function main() { return new K(5).r; }`,
  },
  {
    name: "control: a this.x = … member read in the ctor stays an own field",
    expected: 2,
    source: `
      function F() { this.x = 1; var a = this.x; this.y = a + 1; }
      export function main() { var f = new F(); return f.y; }`,
  },
];

describe("#6970 this.<m> read of a prototype member inside a fnctor ctor", () => {
  for (const octane of [false, true]) {
    for (const testCase of CASES) {
      it(`${octane ? "octane options" : "module"}: ${testCase.name}`, async () => {
        expect(await runStandalone(testCase.source, octane)).toBe(testCase.expected);
      });
    }
  }
});
