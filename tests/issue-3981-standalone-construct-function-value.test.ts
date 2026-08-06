// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3981 — standalone `new <first-class function value>()` returned NULL.
//
// `new C()` worked when `C` was a statically-resolvable function DECLARATION or
// a class. When the constructor arrived as a VALUE — an alias, an IIFE result, a
// factory return — every `ref.test` in the dynamic-`new` dispatch chain declined
// and the arm fell through to `ref.null.extern`. So the construct evaluated to
// null with no trap and no diagnostic, and the first property access on the
// result threw "Cannot access property on null or undefined".
//
// That was the `cookie` package's `standalone · runtime dynamic` perf-lane
// failure: `parseCookie` returns `new NullObject()` where `NullObject` is an
// IIFE-returned function expression.
//
// Every case here is asserted against the SAME source evaluated by Node, so the
// expectation is JavaScript's answer rather than a hand-written constant.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<unknown> {
  const source = `export function probe() {\n${body}\n}`;
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.probe!();
}

function runNative(body: string): unknown {
  return new Function(body)();
}

async function expectMatchesNative(body: string): Promise<void> {
  expect(await runStandalone(body)).toBe(runNative(body));
}

describe("#3981 standalone [[Construct]] on a function value", () => {
  // The three shapes from the issue's measured table that returned null.
  it("constructs through a const alias of a function expression", async () => {
    await expectMatchesNative(`
      const F = function () {};
      const C = F;
      return new C() === null ? -1 : 1;
    `);
  });

  it("constructs through a function's return value", async () => {
    await expectMatchesNative(`
      function mk() { return function () {}; }
      const C = mk();
      return new C() === null ? -1 : 1;
    `);
  });

  it("constructs through an IIFE result", async () => {
    await expectMatchesNative(`
      const C = (() => function () {})();
      return new C() === null ? -1 : 1;
    `);
  });

  // The second defect recorded in #3981: even in the shape that did NOT return
  // null, the instance dropped own-property writes.
  it("supports own-property write/read on the instance", async () => {
    await expectMatchesNative(`
      const C = (() => { const F = function () {}; F.prototype = Object.create(null); return F; })();
      const o = new C();
      o["a"] = 1;
      o["b"] = 2;
      return o["a"] + o["b"];
    `);
  });

  // The constructor BODY must run with `this` bound to the fresh instance.
  it("runs the constructor body with `this` bound to the new instance", async () => {
    await expectMatchesNative(`
      const C = (() => function () { this.x = 7; })();
      return new C().x;
    `);
  });

  it("threads constructor arguments, in order, evaluated once", async () => {
    // `seen` encodes the evaluation ORDER positionally (10 * first + second) and
    // `calls` the COUNT, so a re-evaluated or reordered argument fails here even
    // though the constructed value would look right.
    await expectMatchesNative(`
      let seen = 0;
      let calls = 0;
      const C = (() => function (a, b) { this.x = a + b; })();
      const mark = (v) => { seen = seen * 10 + v; calls = calls + 1; return v; };
      const o = new C(mark(1), mark(2));
      return seen * 1000 + calls * 100 + o.x;
    `);
  });

  // ECMA-262 §10.2.2 step 13: an object return replaces the fresh instance;
  // any other completion value is discarded.
  it("returns the body's object when it returns one", async () => {
    await expectMatchesNative(`
      const C = (() => function () { this.x = 1; return { x: 99 }; })();
      return new C().x;
    `);
  });

  it("ignores a primitive return", async () => {
    await expectMatchesNative(`
      const C = (() => function () { this.x = 5; return 123; })();
      return new C().x;
    `);
  });

  it("ignores a null return", async () => {
    await expectMatchesNative(`
      const C = (() => function () { this.x = 5; return null; })();
      return new C().x;
    `);
  });

  it("links the instance to the constructor's prototype", async () => {
    await expectMatchesNative(`
      const C = (() => {
        const F = function () {};
        const proto = Object.create(null);
        proto.greet = 11;
        F.prototype = proto;
        return F;
      })();
      return new C().greet;
    `);
  });

  // The cookie shape end to end: a null-prototype instance filled by dynamic
  // key writes, which is what the failing perf lane exercised.
  it("constructs the cookie NullObject shape and accumulates dynamic keys", async () => {
    await expectMatchesNative(`
      const NullObject = (() => {
        const C = function () {};
        C.prototype = Object.create(null);
        return C;
      })();
      function parse(pairs) {
        const obj = new NullObject();
        for (let i = 0; i < pairs.length; i++) obj[pairs[i][0]] = pairs[i][1];
        return obj;
      }
      const parsed = parse([["a", 1], ["h", 8]]);
      return parsed.a * 10 + parsed.h;
    `);
  });

  // A construct driver is only reserved for a value-bound callee, so a class or
  // a plain function declaration must keep its existing typed lowering. These
  // assert the behaviour, not the lowering, but a mis-scoped gate that stole
  // them would change observable results.
  it("leaves a function declaration's construct path alone", async () => {
    await expectMatchesNative(`
      function F(v) { this.x = v + 3; }
      const o = new F(4);
      return o.x;
    `);
  });

  it("leaves a class construct path alone", async () => {
    await expectMatchesNative(`
      class K { constructor(v) { this.v = v; } double() { return this.v * 2; } }
      return new K(21).double();
    `);
  });

  it("emits no host imports for the native construct", async () => {
    const result = await compile(
      `export function probe() {
         const C = (() => function () { this.x = 1; })();
         return new C().x;
       }`,
      {
        fileName: "probe.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
        deferTopLevelInit: true,
      },
    );
    expect(result.success).toBe(true);
    expect(result.imports).toEqual([]);
  });
});
