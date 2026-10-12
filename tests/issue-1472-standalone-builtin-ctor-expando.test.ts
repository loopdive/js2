// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1472 (Octane raytrace slice) — an EXPANDO method on a builtin carrier,
 * Prototype.js's `Object.extend = function (d, s) { … }` and `Math.foo()`.
 *
 * Two standalone gaps, both fixed here:
 *  1. the call `Object.extend(a, b)` resolved its receiver through the
 *     `__get_builtin("Object")` host import, which standalone refuses — the
 *     whole file failed to compile. A name with no modelled static is now an
 *     ordinary dynamic method call on the carrier VALUE.
 *  2. the TOP-LEVEL write was dropped by module-init collection (#4199 kept
 *     only Math/JSON/Reflect); it now also keeps expandos on builtin
 *     constructor carriers, except their own static surface.
 */
import { describe, expect, it } from "vitest";
import { isBuiltinNamespaceExpandoWriteTarget } from "../src/codegen/builtin-write-keeps.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(result.imports ?? [], "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

const EXTEND = `
Object.extend = function (destination, source) {
  for (var property in source) destination[property] = source[property];
  return destination;
};`;

describe("#1472 standalone expando methods on builtin carriers", () => {
  it("top-level Object.extend write + call (raytrace shape)", async () => {
    // node: 11
    expect(
      await runStandalone(`${EXTEND}
        export function main() {
          return Object.extend({}, { a: 1 }).a * 10 + (typeof Object.extend === "function" ? 1 : 0);
        }`),
    ).toBe(11);
  });

  it("Object.extend used from a method, as raytrace's Engine does", async () => {
    // node: 42
    expect(
      await runStandalone(`${EXTEND}
        function Engine(options) {
          this.options = Object.extend({ w: 1, h: 2 }, options || {});
        }
        export function main() {
          var e = new Engine({ h: 40 });
          return e.options.w + e.options.h + 1;
        }`),
    ).toBe(42);
  });

  it("write and call both inside a function body", async () => {
    // node: 1
    expect(
      await runStandalone(`
        export function main() {
          Object.extend = function (d, s) { for (var k in s) d[k] = s[k]; return d; };
          return Object.extend({}, { a: 1 }).a;
        }`),
    ).toBe(1);
  });

  it("Math.foo() on a non-modelled Math member", async () => {
    // node: 71
    expect(
      await runStandalone(`
        Math.foo = function () { return 7; };
        export function main() { return Math.foo() * 10 + (typeof Math.foo === "function" ? 1 : 0); }`),
    ).toBe(71);
  });

  it("other constructor carriers (Array, String, Error) keep a top-level expando", async () => {
    // node: 111
    expect(
      await runStandalone(`
        Array.zz = function (a) { return a + 1; };
        String.zz = function (a) { return a + 10; };
        Error.zz = function (a) { return a + 100; };
        export function main() { return Array.zz(0) + String.zz(0) + Error.zz(0); }`),
    ).toBe(111);
  });

  it("a missing expando throws TypeError at runtime after the arguments are evaluated", async () => {
    // node: 15 (§13.3.6.1 EvaluateCall — not a compile error)
    expect(
      await runStandalone(`
        export function main() {
          var log = 0;
          try { Object.nope(log = 5); } catch (e) { return (e instanceof TypeError ? 10 : 20) + log; }
          return -1;
        }`),
    ).toBe(15);
  });

  // Review P1: the method is captured BEFORE the arguments are evaluated
  // (§13.3.6.1). The old head resolved it after them (22 / unexpected throw).
  it("an argument that replaces the method does not change the callee", async () => {
    // node: 11
    expect(
      await runStandalone(`
        Object.zzq = function (x) { return 11; };
        function flip() { Object.zzq = function (x) { return 22; }; return 0; }
        export function main() { return Object.zzq(flip()); }`),
    ).toBe(11);
  });

  it("an argument that nulls the method still calls the captured original", async () => {
    // node: 11
    expect(
      await runStandalone(`
        Object.zzq = function (x) { return 11; };
        function flip() { Object.zzq = null; return 0; }
        export function main() {
          try { return Object.zzq(flip()); } catch (e) { return e instanceof TypeError ? 1 : 2; }
        }`),
    ).toBe(11);
  });

  it("control: an unchanged method receives the argument value", async () => {
    // node: 12
    expect(
      await runStandalone(`
        Object.zzq = function (x) { return 11 + x; };
        function flip() { return 1; }
        export function main() { return Object.zzq(flip()); }`),
    ).toBe(12);
  });

  it("the captured method is called with this = the carrier", async () => {
    // node: 5
    expect(
      await runStandalone(`
        Object.zzq = function () { return this === Object ? 5 : 6; };
        export function main() { return Object.zzq(); }`),
    ).toBe(5);
  });

  it("negative control: a modelled static keeps its native lowering", async () => {
    // node: 2
    expect(
      await runStandalone(`
        export function main() { return Object.keys({ a: 1, b: 2 }).length; }`),
    ).toBe(2);
  });

  it("negative control: Buffer stays a ReferenceError in a host-free module", async () => {
    // node (no Buffer global in a host-free realm): ReferenceError
    expect(
      await runStandalone(`
        export function main() {
          try { Buffer.isBuffer(1); } catch (e) { return e instanceof ReferenceError ? 1 : 0; }
          return -1;
        }`),
    ).toBe(1);
  });
});

describe("#1472 keep predicate scope for constructor carriers", () => {
  const EMPTY: ReadonlySet<string> = new Set<string>();
  const ctx = { moduleGlobals: EMPTY, topLevelFunctionNames: EMPTY, classSet: EMPTY };

  function lhsOf(code: string): ts.Expression {
    const sf = ts.createSourceFile("t.ts", code, ts.ScriptTarget.ESNext, true);
    const stmt = sf.statements[0] as ts.ExpressionStatement;
    return (stmt.expression as ts.BinaryExpression).left;
  }

  it.each([
    ["Object.extend = f;", true],
    ['Object["extend"] = f;', true],
    ["Array.zz = f;", true],
    ["Function.zz = f;", true],
    ["TypeError.thrower = f;", true],
    // own static surface — stays dropped
    ["Object.keys = f;", false],
    ["Array.isArray = f;", false],
    ["Number.MAX_VALUE = 1;", false],
    ["Symbol.iterator = 1;", false],
    ["Object.length = 1;", false],
    ["Function.name = 1;", false],
    // whole-prototype replacement belongs to other arms
    ["Object.prototype = {};", false],
    // typed arrays are not in the carrier set
    ["Uint8Array.zz = f;", false],
    ["Object[k] = f;", false],
  ])("%s → %s", (code, want) => {
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf(code), ctx)).toBe(want);
  });

  it("declines when a user binding shadows the constructor", () => {
    const shadowed = { moduleGlobals: new Set(["Object"]), topLevelFunctionNames: EMPTY, classSet: EMPTY };
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf("Object.extend = f;"), shadowed)).toBe(false);
  });
});
