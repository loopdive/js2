// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7557 — built-ins called through values on the Prepared path: the dispatcher's built-in arm calls the realm's
// built-in caller (src/ir/realm-builtin-caller.ts, src/ir/program/dynamic-builtin-call.ts), whose identity ladder
// answers the realm's methods; `Function` is in scope and Function.prototype holds `call`, `apply` and `bind`. Each
// program computes `out` and is checked against node in a fresh realm (some write Function.prototype or
// Object.prototype) and with a wrong answer; the rest end at the run-time abort where node returns.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
/** A function value, so that closures are function objects and the dispatcher exists. */
const F = "var g = function () { return 1; }; g(); ";

const AGREES: readonly (readonly [string, string])[] = [
  ["Function in scope", `${F}var out = typeof Function + Function.length + Function.name;`],
  ["call is Function.prototype's", `${F}var out = String(g.call === Function.prototype.call) + typeof g.apply;`],
  ["a write to Function.prototype is seen", `${F}Function.prototype.zz = 5; var out = String(g.zz);`],
  [
    "an overridden call is the program's",
    `${F}Function.prototype.call = function () { return 'mine'; }; var out = g.call(null);`,
  ],
  [
    "Function.prototype on function chains",
    `${F}var out = String(g instanceof Function) + String(Function.prototype instanceof Function) + String(TypeError instanceof Function) + String({} instanceof Function);`,
  ],
  [
    "call with this and arguments",
    "var f = function (a, b) { return this.x + a + b; }; var o = {}; o.x = 1; var out = String(f.call(o, 2, 3));",
  ],
  [
    "call with fewer arguments",
    "var f = function (a, b) { return String(a) + String(b); }; var out = f.call(null, 1) + f.call();",
  ],
  [
    "call of call",
    "var f = function (a) { return this.x + a; }; var c = f.call; var t = {}; t.x = 10; var out = String(c.call(f, t, 5));",
  ],
  [
    "call of a held built-in",
    `${F}var o = { a: 1 }; var h = Object.prototype.hasOwnProperty; var out = String(h.call(o, 'a')) + String(h.call(o, 'b')) + String(Function.prototype.call.call(h, o, 'a'));`,
  ],
  [
    "call of a non-callable throws",
    `${F}var out; try { Function.prototype.call.call(5); out = 'no'; } catch (e) { out = e instanceof TypeError ? 'TE' : 'x'; }`,
  ],
  [
    "a throw through call is catchable",
    "var f = function () { throw 42; }; var out; try { f.call(null); out = 'no'; } catch (e) { out = String(e); }",
  ],
  [
    "a detached hasOwnProperty throws ToObject's TypeError",
    `${F}var h = Object.prototype.hasOwnProperty; var out; try { h.call(undefined, 'a'); out = 'no'; } catch (e) { out = e instanceof TypeError ? 'TE' : 'x'; }`,
  ],
  [
    "strict this through call",
    "var f = function () { 'use strict'; return typeof this; }; var out = f.call(undefined) + f.call(5);",
  ],
  [
    "a method stored on an object",
    `${F}var o = { a: 1, f: Object.prototype.propertyIsEnumerable }; var out = String(o.f('a')) + String(o.f('zz'));`,
  ],
  [
    "an overridden hasOwnProperty is the program's",
    `${F}Object.prototype.hasOwnProperty = function (k) { return 'mine' + k; }; var h = Object.prototype.hasOwnProperty; var out = h('a');`,
  ],
];

const ABORTS: readonly (readonly [string, string])[] = [
  ["call with more than three arguments", "var f = function () { return 1; }; f.call(null, 1, 2, 3, 4);"],
  ["Function as a constructor", `${F}new Function('return 1');`],
  ["bind", `${F}g.bind(null);`],
];

describe("#7557 — built-ins through values agree with node", () => {
  it.each(AGREES)("%s", async (_label, body) => agreesWithNode(body, true, runnerOptions(), freshRealmOut), SLOW);
  it.each(ABORTS)("%s aborts", async (_label, source) => abortsAtRunTime(source, runnerOptions()), SLOW);
});
