// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7579 (array PR B) — array literals and computed member keys on the Prepared path. A literal is the realm's array
// (ArrayCreate, then CreateDataProperty per present element, left to right); a computed key is converted at run time
// (ToString of a primitive; an object key aborts) and a string key the receiver's chain lacks aborts unless it is a
// canonical numeric string. What stays out (iteration, spread, destructuring, method bodies, ToPrimitive of an array)
// refuses or aborts.
//
// Each program computes the string `out` and is checked against node in a fresh realm, with a wrong answer that must
// throw (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression, as the harness does.
import { describe, it } from "vitest";
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
const BOTH: readonly (readonly [string, string])[] = [
  [
    "empty, mixed and nested literals",
    `var a = [], b = [1, "a", true, null], c = [[1, 2], []];
var out = a.length + "|" + b.length + b[1] + b[2] + String(b[3]) + "|" + c.length + c[0][1] + c[1].length;`,
  ],
  [
    "holes, a trailing comma, a trailing elision",
    `var a = [1, , 3], b = [1, ], c = [, ], d = [, , ];
var out = a.length + String(a[1]) + "|" + b.length + c.length + d.length + String(c[0]);`,
  ],
  [
    "computed integer keys: read, write, grow",
    `var a = [10, 20, 30], i = 1; a[i] = a[i] + 1; a[i + 2] = 7;
var out = a[i] + "|" + a.length + "|" + a[3] + String(a[5]);`,
  ],
  [
    "computed compound assignment and update",
    `var a = [1, 2], i = 0; a[i] += 5; a[i]++; ++a[1]; a.length += 1; var out = a[0] + "|" + a[1] + "|" + a.length;`,
  ],
  [
    "negative, fractional, NaN and 2**32-1 keys are plain properties",
    `var a = [1, 2]; a[-1] = "m"; a[1.5] = "f"; a[NaN] = "n"; a[4294967295] = "h"; a[4294967294] = "g";
var out = a.length + a["-1"] + a["1.5"] + a["NaN"] + a["4294967295"] + a[-1] + a[1.5] + a[0 / 0];`,
  ],
];

const MODULE: readonly (readonly [string, string])[] = [
  [
    "element order, and a throwing element leaves the binding",
    `var log = { s: "" }; var f = function (x) { log.s = log.s + x; return x; };
var a = [f("a"), f("b"), , f("c")], b = 1;
try { b = [1, (function () { throw new TypeError("t"); })(), 3]; } catch (e) { log.s = log.s + e.name; }
var out = log.s + a.length + a[3] + String(b);`,
  ],
  [
    "each evaluation is a new array",
    "var xs = []; for (var i = 0; i < 3; i++) xs[i] = [i];\nvar out = String(xs[0] === xs[1]) + xs[2][0] + xs.length;",
  ],
  [
    "a literal is an array: isArray, tag, instanceof, constructor",
    `var a = [1];
var out = String(Array.isArray(a)) + Object.prototype.toString.call([]) + String([] instanceof Array)
  + String(a.constructor === Array) + String([] === []);`,
  ],
  [
    "a literal never calls a user-written Array",
    'var calls = 0; var Array = function () { calls++; return {}; };\nvar a = [1, 2]; var out = calls + "|" + a.length + typeof a;',
  ],
  [
    "a literal defines its elements: no setter of Array.prototype runs",
    `Object.defineProperty(Array.prototype, "0", { set: function (v) { throw 1; }, configurable: true });
var a = [5]; var out = String(a[0]) + String(Object.getOwnPropertyDescriptor(a, "0").value);`,
  ],
  ["a hole reads through Array.prototype", 'Array.prototype[0] = "p"; var out = String([ , ][0]) + String([ , 2][0]);'],
  [
    'string keys: canonical numeric, "length", a held name',
    `var a = [1, 2], k1 = "1", k3 = "length", c = "constructor"; a.foo = "f"; var f = "foo";
var out = a[k1] + a[k3] + a[f] + a.length + String(a["0"]) + String(a[c] === Array);`,
  ],
  [
    "boolean, null and undefined keys are their strings",
    `var o = {}, t = true, n = null, u;
o[t] = 1; o[n] = 2; o[u] = 3; var out = o["true"] + o["null"] + o["undefined"] + o[t] + o[n] + o[u] + "";`,
  ],
  [
    "computed keys on objects and functions",
    `var o = { a: 1, b: 0 }, k = "a", j = "b", n = 1; o[j] = 2; o[n] = "one";
var f = function () {}; f.x = 0; var x = "x"; f[x] = 3; o[k] += 2;
var out = o[k] + o[j] + o["1"] + o[n] + String(o[2]) + f[x] + typeof f["na" + "me"];`,
  ],
  [
    "a missing canonical numeric key reads as undefined",
    'var a = [1]; var i = 7, s = "7"; var out = String(a[i]) + String(a[s]) + String(a[i + 1]);',
  ],
  [
    "a computed number key is the constant key's canonical string",
    `var a = []; var i = 0.1 + 0.2, j = 1e21, m = -0;
a[i] = "p"; a[j] = "q"; a[m] = "z"; var out = a["0.30000000000000004"] + a["1e+21"] + a[0] + a.length + a[0.30000000000000004];`,
  ],
  [
    "a key through a parameter is the dynamic value, not a number",
    `function f(o, k) { return o[k]; } function g(o, k) { o[k] = 1; return o; }
var out = String(f({ a: 1 }, "a")) + String(f([5, 6], 1)) + String(g({ a: 0 }, "a").a) + String(g([0, 0], 1)[1]);`,
  ],
  [
    "names[i] and failures[failures.length] (propertyHelper.js)",
    `var names = ["a", "b"], o = { a: 1, b: 2 }, s = 0;
for (var i = 0; i < names.length; i++) s += o[names[i]];
var failures = []; failures[failures.length] = "x"; var out = s + "|" + failures.length;`,
  ],
  [
    "a nullish receiver with a computed key throws a TypeError",
    `var out = "", n = null, k = "x", u;
try { n[k]; } catch (e) { out += e.name; } try { u[k] = 1; } catch (e) { out += e.name; }`,
  ],
  [
    "a strict write to a read-only index throws; a sloppy one past a frozen length is ignored",
    `var a = [1]; Object.defineProperty(a, "0", { writable: false }); var i = 0, out = "";
var s = function () { "use strict"; try { a[i] = 2; } catch (e) { return e.name; } };
var b = [1]; Object.defineProperty(b, "length", { writable: false }); var j = 3; b[j] = 2;
out = s() + a[0] + b.length + String(b[3]);`,
  ],
];

describe("#7579 — array literals and computed keys agree with node", () => {
  it.each(BOTH)("%s (at module level)", async (_label, body) => agrees(body), SLOW);
  it.each(BOTH)("%s (inside a function)", async (_label, body) => agrees(inFunction(body)), SLOW);
  it.each(MODULE)("%s", async (_label, body) => agrees(body), SLOW);
});

describe("#7579 — what this slice leaves out aborts or refuses", () => {
  it.each([
    // ToPrimitive of an array tests the brand first and aborts before any read.
    ["an array as a computed key", "var o = { 1: 2 }; var out = String(o[[1]]);"],
    [
      "an object key (its ToPrimitive)",
      'var o = { x: 1 }, key = { toString: function () { return "x"; } }; var out = String(o[key]);',
    ],
    ["a method call on a literal", 'var out = [1, 2].join("-");'],
    ["a computed read of a member the realm did not materialise", 'var k = "join"; var out = typeof [][k];'],
    ["a computed read of an absent name", 'var o = { a: 1 }, k = "b"; var out = String(o[k]);'],
    ["a computed write of a new name", 'var o = {}, k = "x"; o[k] = 1; var out = String(o.x);'],
    ["a computed __proto__ write", 'var o = {}, k = "__proto__"; o[k] = { z: 1 }; var out = String(o.z);'],
    ["a computed key on a primitive", 'var s = "ab", i = 1; var out = s[i];'],
    [
      "a computed key where a String object may be",
      'var s = new String("ab"), o = {}, i = 1; o[i] = 2; var out = String(s[i]);',
    ],
    ["arguments", "var f = function () { return arguments[0]; }; var out = String(f(3));"],
    [
      "for-of over a literal in a function",
      "var f = function () { var s = 0; for (var v of [1, 2]) s += v; return s; }; var out = String(f());",
    ],
    [
      "for-in over a literal in a function",
      'var f = function () { var s = ""; for (var p in [1, 2]) s += p; return s; }; var out = f();',
    ],
  ])("aborts %s", async (_label, body) => aborts(body), SLOW);

  it.each([
    ["concatenation of a literal", 'var out = [1] + "";'],
    ["loose equality with a literal", "var out = String([] == 0);"],
    ["a spread element", "var a = [1, 2]; var b = [0, ...a]; var out = String(b.length);"],
    ["destructuring", "var [p, q] = [1, 2]; var out = String(p + q);"],
    ["Array.of", "var out = String(Array.of(1).length);"],
    ["Object.getOwnPropertyNames of an array", "var out = Object.getOwnPropertyNames([1]).join();"],
    ["JSON", "var out = JSON.stringify([1]);"],
    ["bind", "var f = function () { return 1; }.bind(null); var out = String(f());"],
  ])("refuses %s", async (_label, body) => refusal(body + CALLS, runnerOptions()), SLOW);
});
