// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7352 (array PR A) — `Array` as a realm value on the Prepared path: `Array` and `Array.prototype` as values,
// `Array(…)` / `new Array(…)`, `Array.isArray` called and held, `length`, constant index keys, the "Array" tag,
// `instanceof Array`, `constructor`. What PR A leaves out (literals, computed keys, iteration, every Array.prototype
// method body, ToPrimitive of an array) refuses by name or aborts.
//
// Each program computes `out` and is checked against node in a fresh realm, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression, as the test262 harness does.
import { describe, expect, it } from "vitest";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";

/** `body` as a function's statements whose result is `out`. */
const inFunction = (body: string) => `function run() {\n${body}\nreturn out;\n}\nvar out = run();`;
const agrees = (body: string) => agreesWithNode(body + CALLS, true, runnerOptions(), freshRealmOut);
const aborts = (body: string) => abortsAtRunTime(body + CALLS, runnerOptions(), (source) => freshRealmOut(source));

/** Programs checked at module level and inside a function. */
const VALUES: readonly (readonly [string, string])[] = [
  [
    "Array as a value: typeof, identity, length, name",
    "var A = Array;\nvar out = typeof Array + typeof A + String(A === Array) + Array.name + Array.length;",
  ],
  [
    "Array.isArray called and held as a value",
    `var __isArray = Array.isArray, a = new Array(3), b = Array(1, 2);
var out = String(Array.isArray(a)) + String(__isArray(b)) + String(__isArray({})) + String(Array.isArray(5))
  + String(Array.isArray()) + typeof __isArray + __isArray.length + __isArray.name;`,
  ],
  [
    "Array(…) and new Array(…): length, constant index keys, holes",
    `var a = new Array(3), b = Array(1, 2), c = new Array("x"), d = Array();
var out = a.length + "|" + b.length + "|" + b[0] + b[1] + "|" + String(a[0]) + "|" + c[0] + c.length + "|" + d.length
  + "|" + b["1"];`,
  ],
  [
    "writes: an index past length grows it, a length write truncates",
    `var a = new Array(2); a[0] = "p"; a[5] = "q";
var out = a.length + a[0] + a[5] + String(a[3]); a.length = 1; out += a.length + String(a[5]);`,
  ],
  [
    "tags, instanceof, constructor",
    `var t = function (v) { return Object.prototype.toString.call(v); }, a = Array(1, 2);
var out = t(a) + t(new Array(0)) + String(a instanceof Array) + String(a.constructor === Array)
  + String({} instanceof Array) + t({}) + t(Array.prototype) + t(Array);`,
  ],
  [
    "Array.prototype: an array, its join and push held as values, a write read through an array",
    `var P = Array.prototype;
var out = typeof P + P.length + String(P.constructor === Array) + String(Array.isArray(P)) + typeof P.join
  + typeof P.push + P.join.name + P.push.length + String(P.join === Array.prototype.join);
P.foo = 3; out += Array.prototype.foo + new Array(1).foo;`,
  ],
  [
    "an invalid length is the realm's RangeError",
    `var out = "";
try { new Array(-1); } catch (e) { out += String(e instanceof RangeError) + e.name; }
try { Array(1.5); } catch (e) { out += e.name; }
try { var a = Array(); a.length = 4294967296; } catch (e) { out += e.name; }`,
  ],
  [
    "a program-written static is the program's own, never the built-in",
    'var A = Array; A.isArray = function () { return "f"; };\nvar out = String(Array.isArray(1));',
  ],
  [
    "a binding that shadows Array is the program's",
    'var f = function (Array) { return Array.isArray(1); };\nvar out = f({ isArray: function () { return "p"; } });',
  ],
];

describe("#7352 — Array as a realm value agrees with node", () => {
  it.each(VALUES)("%s (at module level)", async (_label, body) => agrees(body), SLOW);
  it.each(VALUES.slice(0, 4))("%s (inside a function)", async (_label, body) => agrees(inFunction(body)), SLOW);
});

describe("#7352 — what PR A leaves out refuses or aborts", () => {
  // An array's `toString` is Array.prototype's (`join`), which the realm does not hold yet: ToPrimitive tests the
  // brand first and aborts before any read, whatever the array's chain holds.
  it.each([
    ["concatenation", 'var a = Array(1, 2); var out = "" + a;'],
    ["unary plus", "var out = String(+Array(1, 2));"],
    ["a comparison", "var f = function (x) { return x < 3; }; var out = String(f(Array(1)));"],
    ["Number()", "var out = String(Number(new Array(2)));"],
    ["an own toString", 'var a = Array(1); a.toString = function () { return "own"; }; var out = String(a);'],
    ["a call of a held method", 'var out = Array(1, 2).join("-");'],
    [
      "Array.isArray moved under another name",
      "var n = new Number(1); n.isA = Array.isArray; var out = String(n.isA(5));",
    ],
    ["a held method called through call", "var out = Array.prototype.join.call(Array(1, 2));"],
    ["a string length value", 'var a = Array(1, 2); a.length = "1"; var out = String(a.length);'],
    [
      "for-of over an array",
      "var f = function (a) { var s = 0; for (var v of a) s += v; return s; }; var out = String(f(Array(1, 2)));",
    ],
    [
      "for-in over an array",
      'var f = function (a) { var s = ""; for (var p in a) s += p; return s; }; var out = f(Array(1, 2));',
    ],
    [
      "an array literal in a function",
      "var f = function () { var a = [1, 2]; return a.length; }; var out = String(f());",
    ],
  ])("aborts %s", async (_label, body) => aborts(body), SLOW);

  it.each([
    [
      "an array literal",
      "var a = [1, 2]; var out = String(a.length);",
      "resolver cannot register vec for array literal",
    ],
    [
      "a computed index key",
      "var a = Array(1, 2), i = 1; var out = String(a[i]);",
      "dyn.member_get with a computed key",
    ],
    ["Array.from", "var out = String(Array.from);", "Array.from is not reachable on this path yet"],
    [
      "Array.isArray written on the global",
      'Array.isArray = function () { return "f"; }; var out = 1;',
      'identifier "Array" is not in scope',
    ],
  ])(
    "refuses %s",
    async (_label, body, reason) => {
      expect(await refusal(body + CALLS, runnerOptions())).toContain(reason);
    },
    SLOW,
  );
});
