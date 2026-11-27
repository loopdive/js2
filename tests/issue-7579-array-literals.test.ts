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

/** Programs checked at module level and inside a function (several checks per program: each compile costs seconds). */
const BOTH: readonly (readonly [string, string])[] = [
  [
    "empty, mixed and nested literals; holes, a trailing comma, a trailing elision",
    `var a = [], b = [1, "a", true, null], c = [[1, 2], []];
var p = [1, , 3], q = [1, ], r = [, ], s = [, , ];
var out = a.length + "|" + b.length + b[1] + b[2] + String(b[3]) + "|" + c.length + c[0][1] + c[1].length
  + "|" + p.length + String(p[1]) + "|" + q.length + r.length + s.length + String(r[0]);`,
  ],
  [
    "computed keys: read, write, grow, compound, update, odd numbers, === undefined",
    `var a = [10, 20, 30], i = 1; a[i] = a[i] + 1; a[i + 2] = 7;
var b = [1, 2], j = 0; b[j] += 5; b[j]++; ++b[1]; b.length += 1;
var c = [1, 2]; c[-1] = "m"; c[1.5] = "f"; c[NaN] = "n"; c[4294967295] = "h"; c[4294967294] = "g";
var d = [null, undefined, , 4], h = 2, o = 9;
var out = a[i] + "|" + a.length + "|" + a[3] + String(a[5]) + "|" + b[0] + b[1] + b.length
  + "|" + c.length + c["-1"] + c["1.5"] + c["NaN"] + c["4294967295"] + c[-1] + c[1.5] + c[0 / 0]
  + "|" + (d[j] === undefined ? "T" : "F") + (d[i] === undefined ? "T" : "F") + (d[h] !== undefined ? "T" : "F")
  + (d[o] === undefined ? "T" : "F") + (d[3] === undefined ? "T" : "F") + (d[j] === null ? "T" : "F");`,
  ],
];

const MODULE: readonly (readonly [string, string])[] = [
  [
    "element order, a throwing element, a new array per evaluation, an array by isArray, tag, instanceof",
    `var log = { s: "" }; var f = function (x) { log.s = log.s + x; return x; };
var a = [f("a"), f("b"), , f("c")], b = 1;
try { b = [1, (function () { throw new TypeError("t"); })(), 3]; } catch (e) { log.s = log.s + e.name; }
var xs = []; for (var i = 0; i < 3; i++) xs[i] = [i];
var z = [1];
var out = log.s + a.length + a[3] + String(b) + "|" + String(xs[0] === xs[1]) + xs[2][0] + xs.length + "|"
  + String(Array.isArray(z)) + Object.prototype.toString.call([]) + String([] instanceof Array)
  + String(z.constructor === Array) + String([] === []);`,
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
  [
    "a hole reads through Array.prototype, constant and computed, and is not undefined",
    `Array.prototype[2] = "p"; var a = [null, undefined, , 4], h = 2;
var out = String([ , , ][2]) + a[h] + (a[h] === undefined ? "T" : "F") + (a[2] !== undefined ? "T" : "F");`,
  ],
  [
    "a method read through an array is Array.prototype's (identity), and holes compare as undefined",
    `var a = [1, 2], d = [ , 1], i = 0;
var out = String([1].toString === Array.prototype.toString) + String(a.join === Array.prototype.join)
  + String(a.toString !== Array.prototype.toString) + typeof a.join + String(a.push === Array.prototype.push)
  + (d[i] === undefined ? "T" : "F") + (d[0] !== undefined ? "T" : "F");`,
  ],
  [
    "string, boolean, null and undefined keys; objects, functions; missing and canonical numeric keys",
    `var a = [1, 2], k1 = "1", k3 = "length", c = "constructor"; a.foo = "f"; var fo = "foo";
var o = {}, t = true, n = null, u; o[t] = 1; o[n] = 2; o[u] = 3;
var p = { a: 1, b: 0 }, k = "a", j = "b", m = 1; p[j] = 2; p[m] = "one"; p[k] += 2;
var f = function () {}; f.x = 0; var x = "x"; f[x] = 3;
var q = [1], i = 7, s = "7";
var r = [], v = 0.1 + 0.2, w = 1e21, nz = -0; r[v] = "p"; r[w] = "q"; r[nz] = "z";
var names = ["a", "b"], sum = 0; for (var l = 0; l < names.length; l++) sum += p[names[l]];
var failures = []; failures[failures.length] = "x";
var out = a[k1] + a[k3] + a[fo] + a.length + String(a["0"]) + String(a[c] === Array) + "|"
  + o["true"] + o["null"] + o["undefined"] + o[t] + o[n] + o[u] + "|"
  + p[k] + p[j] + p["1"] + p[m] + String(p[2]) + f[x] + typeof f["na" + "me"] + "|"
  + String(q[i]) + String(q[s]) + String(q[i + 1]) + "|"
  + r["0.30000000000000004"] + r["1e+21"] + r[0] + r.length + r[0.30000000000000004] + "|" + sum + failures.length;`,
  ],
  [
    "keys through parameters; a nullish receiver's TypeError; strict and sloppy writes to read-only indices",
    `function f(o, k) { return o[k]; } function g(o, k) { o[k] = 1; return o; }
var out = String(f({ a: 1 }, "a")) + String(f([5, 6], 1)) + String(g({ a: 0 }, "a").a) + String(g([0, 0], 1)[1]);
var n = null, k = "x", u;
try { n[k]; } catch (e) { out += e.name; } try { u[k] = 1; } catch (e) { out += e.name; }
var a = [1]; Object.defineProperty(a, "0", { writable: false }); var i = 0;
var s = function () { "use strict"; try { a[i] = 2; } catch (e) { return e.name; } };
var b = [1]; Object.defineProperty(b, "length", { writable: false }); var j = 3; b[j] = 2;
out += s() + a[0] + b.length + String(b[3]);`,
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
