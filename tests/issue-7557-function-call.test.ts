// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7557 — `Function` as a realm value, `Function.prototype.call`, and built-ins called through values on the Prepared
// path. A built-in reached through a value (held in a variable, stored under another name, reached by `call`) is the
// dispatcher's built-in arm, which calls the realm's built-in caller: one identity ladder over the built-ins the realm
// may hold. `bind`, `apply` and `Function(…)` stay out (#7560, the eval lane).
//
// Each program computes `out` and is checked against node in a fresh realm, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression, as the test262 harness does.
import { runInNewContext } from "node:vm";
import { describe, it } from "vitest";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
const CALLS = "\nvar k = function () { return 1; }; k();";
const TE =
  "function te(f) { try { f(); return 'none'; } catch (e) { return e instanceof TypeError ? 'TE' : 'other'; } }\n";
const agrees = (body: string) => agreesWithNode(TE + body + CALLS, true, runnerOptions(), freshRealmOut);
const aborts = (body: string) =>
  abortsAtRunTime(body + CALLS, runnerOptions(), (source) => runInNewContext(source, {}));

describe("#7557 — Function as a realm value agrees with node", () => {
  it.each([
    [
      "typeof, identity, prototype, constructor, length, name",
      `var f = function () {}; var P = Function.prototype;
var out = typeof Function + typeof P + (P === Function.prototype) + (P.constructor === Function)
  + (f.constructor === Function) + Function.name + (P() === undefined) + Function.length;`,
    ],
    [
      "instanceof Function: source functions, closures, held built-ins, Function.prototype itself",
      `var f = function () {}; var mk = function () { return function () {}; }; var c = Function.prototype.call;
var d = Object.defineProperty;
var out = String(f instanceof Function) + String(mk() instanceof Function) + String(c instanceof Function)
  + String(d instanceof Function) + String(Function.prototype instanceof Function) + String(new f() instanceof Function)
  + String(({}) instanceof Function);`,
    ],
    [
      "writes to Function.prototype and the root are visible through functions",
      `var f = function () {}; Function.prototype.x = 1; Object.prototype.y = 2;
var out = String(f.x) + String(f.y) + String(f.hasOwnProperty("x"));`,
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

describe("#7557 — Function.prototype.call agrees with node", () => {
  it.each([
    [
      "a source function: this, arguments, none, more than its parameters",
      `var f = function (a, b) { return this.v + ":" + a + ":" + b; }; var o = { v: 7 };
var out = f.call(o, 1, 2) + "|" + f.call(o) + "|" + f.call(o, 1, 2, 3);`,
    ],
    [
      "a strict callee sees thisArg as passed",
      `var s = function () { "use strict"; return typeof this + (this === undefined); };
var out = s.call() + s.call(undefined) + s.call(5) + s.call(null);`,
    ],
    [
      "call held as a value, call of call, a non-callable receiver",
      `var f = function (a) { return this.v + a; }; var c = Function.prototype.call;
var out = String(c.call(f, { v: 1 }, 2)) + String(Function.prototype.call.call(f, { v: 3 }, 4))
  + te(function () { Function.prototype.call.call(1); }) + te(function () { c.call(7); });`,
    ],
    [
      "Object.prototype methods through call, with any this",
      `var o = { x: 1 }; var h = Object.prototype.hasOwnProperty;
var out = String(h.call(o, "x")) + String(h.call(o, "y")) + String(Object.prototype.propertyIsEnumerable.call(o, "x"))
  + te(function () { h.call(undefined, "x"); }) + te(function () { h("x"); });`,
    ],
    [
      "an own call property, a replaced Function.prototype.call",
      `var f = function () { return 3; }; f.call = function () { return 9; };
var h = function () { return 4; }; var g = function () { return "g" + (this === h); };
var before = String(f.call()) + String(h.call());
Function.prototype.call = g;
var out = before + h.call(1);`,
    ],
    [
      "a closure, a held static and a static passed on, through call",
      `var mk = function (n) { return function (a) { return this.v + n + a; }; };
var d = Object.defineProperty, o = {}; d.call(7, o, "x", { value: 5 });
var ap = function (fn, t) { return fn.call(null, t, "x"); };
var out = String(mk(1).call({ v: 2 }, 3)) + String(o.x) + String(ap(Object.getOwnPropertyDescriptor, o).value);`,
    ],
    [
      "the conversion methods, the object tag and Array.isArray through call",
      `var v = Number.prototype.valueOf, t = Object.prototype.toString;
var out = String(v.call(5)) + te(function () { v.call("s"); }) + String.prototype.toString.call("q")
  + Error.prototype.toString.call(new TypeError("m")) + te(function () { Error.prototype.toString.call(1); })
  + t.call(1) + t.call(undefined) + String(Array.isArray.call(null, Array(1))) + String(Array.isArray.call(1, 1));`,
    ],
    [
      "thisArg and the arguments are evaluated in order, before a non-callable throws",
      `var s = ""; var f = function (a, b) { return a + b; };
var r = f.call((s += "t", {}), (s += "a", 1), (s += "b", 2));
try { Function.prototype.call.call(1, (s += "c", 2)); } catch (e) { s += "T"; }
var o = {}; o.m = 7; try { o.m(s += "d"); } catch (e) { s += "U"; }
var out = r + s;`,
    ],
    [
      "call's own call, a function's call called, an object's own call method",
      `var c = Function.prototype.call; c.call = function () { return "own"; };
var f = function () { return "f"; }, g = function () { return "g"; };
var o = { call: function (a) { return this === o ? a : 0; } };
var out = String(c.call(f)) + f.call() + f.call.call(g) + String(o.call(4)) + typeof ({}).call;`,
    ],
    [
      "a primitive's call is undefined; calling a non-callable throws",
      `var id = function (x) { return x; }; var n = id(5), s = id("s"); var o = {}; o.valueOf = 7;
var out = String(n.call) + String(s.call) + te(function () { s.call(); }) + te(function () { o.valueOf(); });`,
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

// A program-written `call` is the program's: by identity, never the folded answer.
describe("#7557 — a replaced Function.prototype.call agrees with node", () => {
  it.each([
    [
      "through an alias",
      'var f = function () { return 1; }; var P = Function.prototype; P.call = function () { return "r"; };\nvar out = String(f.call());',
    ],
    [
      "through a parameter",
      `var w = function (x) { x.call = function () { return "r"; }; }; var f = function () { return 1; };
w(Function.prototype);
var out = String(f.call());`,
    ],
    [
      "through defineProperty, then a spelled built-in's call",
      `Object.defineProperty(Function.prototype, "call", { value: function () { return "r"; } });
var out = String(Object.prototype.hasOwnProperty.call({ x: 1 }, "x"));`,
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

describe("#7557 — a built-in under another name or as a constructor agrees with node", () => {
  it.each([
    [
      "a static called as a method of another name",
      `var p = { f: Object.defineProperty }, o = {}; p.f(o, "x", { value: 1 });
var out = String(o.x) + String(Object.prototype.hasOwnProperty.call(o, "x"));`,
    ],
    [
      "a wrapper method under another name: wrong receiver and right receiver",
      `var o = {}; o.myValueOf = Number.prototype.valueOf; var n = new Number(5); n.myValueOf = Number.prototype.valueOf;
var out = te(function () { o.myValueOf(); }) + String(n.myValueOf());`,
    ],
    [
      "an Object.prototype method under another name",
      'var o = { x: 1 }; o.h = Object.prototype.hasOwnProperty;\nvar out = String(o.h("x")) + String(o.h("h")) + String(o.h("y"));',
    ],
    [
      "Array.isArray under another name",
      "var n = new Number(1); n.isA = Array.isArray; var out = String(n.isA(5)) + String(n.isA(Array(1, 2)));",
    ],
    [
      "new of a held built-in that has no [[Construct]]",
      `var c = Function.prototype.call, P = Function.prototype, d = Object.defineProperty, h = ({}).hasOwnProperty;
var out = te(function () { new c(); }) + te(function () { new P(); }) + te(function () { new d(); })
  + te(function () { new h(); });`,
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

// Without a source function no dispatcher exists: a call site tests the held built-ins itself, then aborts.
describe("#7557 — in a program without a source function", () => {
  it.each([
    [
      "Function, Function.prototype and call as values",
      `var c = Function.prototype.call;
var out = typeof c + typeof Function + (Function.prototype.constructor === Function) + (c instanceof Function)
  + (Function.prototype instanceof Function) + (({}) instanceof Function);`,
    ],
    [
      "a static and a wrapper method under another name",
      `var o = {}; o.f = Object.defineProperty; o.f(o, "x", { value: 1 }); o.myValueOf = Number.prototype.valueOf;
var out = String(o.x); try { o.myValueOf(); } catch (e) { out += e instanceof TypeError; }`,
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions(), freshRealmOut), SLOW);

  it.each([
    ["a spelled built-in's call", 'Object.prototype.hasOwnProperty.call({ x: 1 }, "x");'],
    [
      "a call of a value that is not callable",
      "var n = {}, r; n.valueOf = 7; try { n.valueOf(); } catch (e) { r = e instanceof TypeError; }",
    ],
  ])(
    "aborts %s",
    async (_label, body) => abortsAtRunTime(body, runnerOptions(), (source) => runInNewContext(source, {})),
    SLOW,
  );
});

describe("#7557 — what ends at the run-time abort", () => {
  it.each([
    ["more than three arguments after thisArg", "var f = function () { return 1; }; f.call(null, 1, 2, 3, 4);"],
    ["a sloppy callee given undefined as this", "var f = function () { return this; }; f.call(undefined);"],
    ["a sloppy callee given a primitive as this", "var f = function () { return typeof this; }; f.call(5);"],
    ["a read of Function.prototype.toString", "var t = Function.prototype.toString;"],
    ["an Array.prototype method's missing body, reached by call", "var a = Array(1, 2); Array.prototype.join.call(a);"],
    ["propertyHelper.js's line 31 at bind", "var j = Function.prototype.call.bind(Array.prototype.join);"],
    [
      "an own-property query of Function.prototype through call (its key unknown to the site)",
      'var f = function () {}; Object.prototype.hasOwnProperty.call(Function.prototype, "call");',
    ],
    [
      "the object tag where Function.prototype.call may be replaced",
      'var g = function () { return "g"; }; Function.prototype.call = g;\nvar v = g(); Object.prototype.toString.call(v);',
    ],
    [
      "an object made from a constructor whose prototype is a function",
      "var g = function () {}; var F = function () {}; F.prototype = g; var o = new F(); var x = o.bind;",
    ],
  ])("%s", async (_label, body) => aborts(body), SLOW);
});

describe("#7557 — what refuses", () => {
  it.each([
    ["Function(…)", 'var k = function () {}; k(); var f = Function("return 1");'],
    ["new Function(…)", 'var k = function () {}; k(); var f = new Function("return 1");'],
    ["a read of apply off a function", "var k = function () {}; k(); var a = k.apply;"],
    ["a read of bind off a function", "var k = function () {}; k(); var b = k.bind;"],
    ["a call of Function.prototype by name", "var k = function () {}; k(); Function.prototype(1);"],
  ])("%s", async (_label, source) => {
    await refusal(source, runnerOptions());
  });
});
