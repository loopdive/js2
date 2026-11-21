// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F2 — calls through a dynamic value (`js.closure.call:N(receiver, callee, …args)`), method calls on a dynamic
// receiver with the receiver as `this`, and OrdinaryToPrimitive calling an own conversion method. Each accepted
// program runs twice: with node's answer (returns) and with a wrong one (throws); a refusal is asserted by its text.
import { describe, expect, it } from "vitest";
import { refusal, runPrepared } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

describe("#7354 F2 — calls through a value", () => {
  // Arity: a missing argument is `undefined`, an extra one is evaluated and dropped; through a declaration's value
  // (its trampoline), a function expression, a parameter, and from inside a function.
  const VALUES =
    "var bumps = 0; function bump() { bumps = bumps + 1; return 0; }\n" +
    "function d(a, b) { return b; } var g = d; var e = function (a) { return a; };\n" +
    "function viaParam(f) { return f(4); } function inner() { return e(5); } function none() {} var v = none;\n";
  it(
    "pads and drops arguments through a declaration's value, an expression, a parameter and a function's call",
    () =>
      agrees(
        `${VALUES}if (g(1) !== undefined || g(1, 2) !== 2 || g(1, 2, bump()) !== 2 || e(3, bump()) !== 3 || viaParam(e) !== 4 || inner() !== 5 || v() !== undefined || bumps !== 2) throw 1;`,
        `${VALUES}if (g(1, 2) !== 1) throw 1;`,
      ),
    SLOW,
  );

  // A value whose kind is known only at run time and is not callable: a catchable TypeError after the arguments.
  const NOT_CALLABLE =
    "var n = 0; function arg() { n = n + 1; return 0; }\n" +
    "function tryCall(f) { try { f(arg()); return 0; } catch (e) { return 1; } }\n";
  it(
    "throws a catchable TypeError for a value that is not callable, after evaluating the arguments",
    () =>
      agrees(
        `${NOT_CALLABLE}if (tryCall(1) !== 1 || tryCall(undefined) !== 1 || tryCall(null) !== 1 || tryCall({}) !== 1 || tryCall("s") !== 1 || tryCall(function () {}) !== 0 || n !== 6) throw 1;`,
        `${NOT_CALLABLE}if (tryCall(function () {}) !== 1) throw 1;`,
      ),
    SLOW,
  );

  // A script var called before its initializer holds `undefined`: the TypeError, caught.
  const EARLY = "var r = 0; try { f(1); } catch (e) { r = 1; } var f = function (a) { return a; };\n";
  it(
    "throws the TypeError for a script var called before its initializer",
    () => agrees(`${EARLY}if (r !== 1 || f(2) !== 2) throw 1;`, `${EARLY}if (r !== 0) throw 1;`),
    SLOW,
  );

  it("refuses a call through a value in a program without a function value by name", async () => {
    expect(await refusal("function h(v) { try { return v(); } catch (e) { return 1; } } h(1);")).toContain(
      "js.closure.call:0 in a program that creates no function value",
    );
  });
});

describe("#7354 F2 — method calls on a dynamic receiver", () => {
  const METHODS =
    "function a() {} a.m = function (v) { return v + 1; };\n" +
    "var o = {}; o.m = function (x, y) { return y; }; o.k = 1;\n" +
    "var log = ''; function r() { log = log + 'r'; return o; } function x() { log = log + 'x'; return 7; }\n" +
    "function tm() { try { o.k(x()); return 0; } catch (e) { return 1; } }\n";
  it(
    "gets the method, then calls it with the arguments in order; a constant element key; a non-callable member",
    () =>
      agrees(
        `${METHODS}if (a.m(1) !== 2 || o.m(1, 2) !== 2 || o.m(1) !== undefined || o["m"](3, 4) !== 4 || r().m(0, x()) !== 7 || log !== "rx" || tm() !== 1 || log !== "rxx") throw 1;`,
        `${METHODS}if (a.m(1) !== 1) throw 1;`,
      ),
    SLOW,
  );

  // The harness shape: `assert._isSameValue` through a method of a declaration's value, with its SameValue answers.
  const HARNESS =
    "function assert() {}\n" +
    "assert._isSameValue = function (a, b) { if (a === b) { return a !== 0 || 1 / a === 1 / b; } return a !== a && b !== b; };\n" +
    "assert.sameValue = function (actual, expected, message) { if (!assert._isSameValue(actual, expected)) { throw 'Expected SameValue'; } };\n" +
    "var threw = 0; try { assert.sameValue(1, 2); } catch (e) { threw = 1; }\n";
  it(
    "runs assert.sameValue's two method calls with the message omitted",
    () =>
      agrees(
        `${HARNESS}assert.sameValue(1, 1); assert.sameValue(NaN, NaN); if (threw !== 1 || assert._isSameValue(0, -0)) throw 1;`,
        `${HARNESS}assert.sameValue(0, -0);`,
      ),
    SLOW,
  );

  it.each([
    ["a spread argument through a value", "function f(v) { return v(...[1]); } f(function (x) { return x; });"],
    ["a spread argument in a method call", "var o = {}; o.m = function (x) { return x; }; o.m(...[1]);"],
  ])("refuses %s by name", async (_label, source) => {
    expect(await refusal(source)).toContain("call through a value with a spread argument");
  });
});

describe("#7354 F2 — OrdinaryToPrimitive calls an own conversion method", () => {
  const CONVERSIONS =
    'var s = { toString: function () { return "x"; } }; var v = { valueOf: function () { return 2; } };\n' +
    'var both = { valueOf: function () { return {}; }, toString: function () { return "t"; } };\n' +
    "function f() {} f.valueOf = function () { return 5; }; var g = function () {}; g.toString = function () { return 'G'; };\n" +
    "var bad = { toString: function () { return {}; } }; var threw = 0; try { var u = '' + bad; } catch (e) { threw = 1; }\n";
  it(
    "answers ToString, ToNumber and + by the called method's primitive, in hint order",
    () =>
      agrees(
        `${CONVERSIONS}if ("" + s !== "x" || v + 1 !== 3 || String(v) !== "[object Object]" || "" + both !== "t" || +f !== 5 || "" + g !== "G" || String(g) !== "G" || threw !== 1) throw 1;`,
        `${CONVERSIONS}if (v + 1 !== "21") throw 1;`,
      ),
    SLOW,
  );

  // A result of an object kind does not answer (§7.1.1.1 step 2.b.ii): a function or a caught error goes on.
  const OBJECT_RESULTS =
    "var fn = { valueOf: function () { return function () {}; }, toString: function () { return 'u'; } };\n" +
    "function err(z) { try { return z.x; } catch (e) { return e; } }\n" +
    "var er = { valueOf: function () { return err(null); }, toString: function () { return 'w'; } };\n";
  it(
    "skips a method whose result is a function or an error",
    () =>
      agrees(
        `${OBJECT_RESULTS}if (fn + "" !== "u" || er + "" !== "w") throw 1;`,
        `${OBJECT_RESULTS}if (er + "" !== "u") throw 1;`,
      ),
    SLOW,
  );
});
