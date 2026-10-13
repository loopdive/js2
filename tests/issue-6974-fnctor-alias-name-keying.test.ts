// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6974 — standalone: the fnctor constructor cache (`funcConstructorMap`) is
// keyed by bare identifier text, so `new K` where `K` is an ALIAS of another
// constructor (`var K = NS.T`, a parameter named `K`) ran the synthesized ctor
// of an unrelated `function K` declared in another IIFE. Octane box2d's
// minifier reuses `K` for `Box2D.inherit`'s empty helper and for
// `var K = Box2D.Common.Math.b2Transform`, so `this.m_xf = new K` built the
// empty helper and `this.m_xf.position.SetV(…)` threw.
//
// Second half: inlined IIFEs share one Wasm frame, and the frame's
// hoisted-function-value set leaked `K` from the IIFE that declared
// `function K` into a later IIFE's `var K = …`, so a closure capturing that
// `var K` materialized the OTHER function into the slot.
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

// An IIFE declaring `function K` that is constructed directly, so the cache
// holds a `K` entry before the aliases below are compiled.
const DECLARES_K = `
  var NS = {};
  (function () { function K() { this.wrong = 1; } NS.k = new K(); NS.K1 = K; })();
  (function () { function m() { this.right = 1; } NS.T = m; })();`;

describe("#6974 a same-named alias does not take a fnctor's cached ctor (standalone)", () => {
  it("a parameter named like another IIFE's fnctor constructs its argument", async () => {
    const src = `${DECLARES_K}
      (function () { NS.make = function (K) { return new K(); }; })();
      export function main() {
        var x = NS.make(NS.T);
        return (x.right === 1 ? 1 : 0) + (x.wrong === undefined ? 10 : 0);
      }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("a `var K = m` alias constructs `m`, not the other IIFE's `function K`", async () => {
    const src = `${DECLARES_K}
      (function () { function n() { this.right = 1; } var K = n; NS.make = function () { return new K(); }; })();
      export function main() {
        var y = NS.make();
        return (y.right === 1 ? 1 : 0) + (y.wrong === undefined ? 10 : 0);
      }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("a later IIFE's `var K = …` captured by a closure keeps its own value", async () => {
    const src = `${DECLARES_K}
      (function () { var K = NS.T; NS.get = function () { return K; }; })();
      export function main() {
        return (NS.get() === NS.T ? 1 : 0) + (NS.get() !== NS.K1 ? 10 : 0);
      }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("control: an alias of a uniquely named fnctor constructs it", async () => {
    const src = `
      var NS = {};
      (function () { function m() { this.right = 1; } var Q = m; NS.make = function () { return new Q(); }; })();
      export function main() { return NS.make().right; }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("control: a direct `new K()` of the declaring IIFE's own fnctor keeps the static ctor", async () => {
    const src = `
      var NS = {};
      (function () {
        function K(v) { this.v = v; }
        NS.a = new K(1);
        NS.b = new K(2);
        NS.K = K;
      })();
      export function main() {
        return NS.a.v + NS.b.v * 10;
      }`;
    expect(await runStandalone(src)).toBe(21);
  });
});
