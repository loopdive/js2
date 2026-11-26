// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 P1 — `hasOwnProperty` and `propertyIsEnumerable` through the strict Prepared entry with the test262 runner's
// options. The realm's Object.prototype holds both as built-in function objects; `o.m(k)` is the [[Get]] of `m`, then
// the method's algorithm when the value read is the realm's own (src/ir/program/dynamic-prototype-methods.ts), else the
// dispatcher's call. Each program runs twice against node: its answer returns, a wrong one throws.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { CATCHES } from "./helpers/object-static-probes.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
/** A function value, so the program admits the function kind a method read answers. */
const FUNCTION_VALUE = "var fv = function(){ return 1; }; fv();";
const agrees = (body: string) => agreesWithNode(`${FUNCTION_VALUE} ${CATCHES} ${body}`, true, runnerOptions());

describe("#7354 P1 — own properties", () => {
  it.each([
    [
      "own, inherited, absent; defined data, accessor and non-enumerable properties",
      "var p = {a: 1}; var o = Object.create(p); o.b = 2; Object.defineProperty(o, 'c', {value: 3});" +
        " Object.defineProperty(o, 'd', {get: function(){ return 4; }, enumerable: true});" +
        " var out = String(o.hasOwnProperty('a')) + String(o.hasOwnProperty('b')) + String(o.hasOwnProperty('c'))" +
        " + String(o.hasOwnProperty('d')) + String(o.hasOwnProperty('x')) + '|' + String(o.propertyIsEnumerable('a'))" +
        " + String(o.propertyIsEnumerable('b')) + String(o.propertyIsEnumerable('c')) + String(o.propertyIsEnumerable('d'));",
    ],
    [
      "a parameter's own properties; Object.prototype's own keys are not the object's",
      "function f(o, k){ return o.hasOwnProperty(k); } var out = String(f({a: 1}, 'a')) + String(f({a: 1}, 'b'))" +
        " + String(f({}, 'toString')) + String(f({}, 'hasOwnProperty'));",
    ],
    [
      "properties a constructor makes on `this` are own, its prototype's are inherited",
      "function C(){ this.a = 1; } C.prototype.b = 2; function k(c){ return String(c.hasOwnProperty('a')) +" +
        " String(c.hasOwnProperty('b')) + String(c.propertyIsEnumerable('a')); } var out = k(new C());",
    ],
    [
      "ToPropertyKey: a number, a Boolean, `undefined`, no argument, an object whose toString runs once",
      "var n = 0; var o = {1: 'x', undefined: 2, true: 3, b: 4}; var k = {toString: function(){ n = n + 1; return 'b'; }};" +
        " var out = String(o.hasOwnProperty(1)) + String(o.hasOwnProperty(undefined)) + String(o.hasOwnProperty())" +
        " + String(o.hasOwnProperty(true)) + String(o.hasOwnProperty(k)) + String(n) + String(o.hasOwnProperty(2));",
    ],
    [
      "a key whose toString throws: the throw is catchable, on an object and on a number receiver",
      "function id(v){ return v; } var one = id(1), obj = {a: 1}; var k = {toString: function(){ throw 7; }}; var out = '';" +
        " try { obj.hasOwnProperty(k); } catch (e) { out = String(e); }" +
        " try { one.propertyIsEnumerable(k); } catch (e) { out = out + String(e); }",
    ],
    [
      "a function's own length, name and prototype; a written property",
      "function F(){} F.x = 1; var g = function(a, b){};" +
        " var out = String(F.hasOwnProperty('prototype')) + String(F.hasOwnProperty('length')) + String(F.hasOwnProperty('name'))" +
        " + String(F.hasOwnProperty('x')) + String(F.hasOwnProperty('y')) + String(F.propertyIsEnumerable('length'))" +
        " + String(F.propertyIsEnumerable('x')) + String(g.hasOwnProperty('length')) + String(g.propertyIsEnumerable('prototype'));",
    ],
    [
      "number and Boolean receivers own nothing",
      "function f(v){ return String(v.hasOwnProperty('x')) + String(v.propertyIsEnumerable('toString')); }" +
        " var out = f(1) + f(false) + f({x: 0});",
    ],
    [
      "observed across loop iterations, unused with a side-effecting key, in try/finally",
      "var o = {}; var out = ''; for (var i = 0; i < 3; i++) { out = out + String(o.hasOwnProperty('p')); o.p = i; }" +
        " var n = 0; function key(){ n = n + 1; return 'x'; } o.hasOwnProperty(key()); o.propertyIsEnumerable(key());" +
        " try { out = out + String(o.hasOwnProperty('p')); } finally { out = out + String(n); }",
    ],
    ["an element access with a constant key", "var o = {a: 1}; var out = String(o['hasOwnProperty']('a'));"],
  ])("%s", (_label, body) => agrees(body), SLOW);

  it(
    "strict code",
    () =>
      agreesWithNode(
        `'use strict'; ${FUNCTION_VALUE} var o = {a: 1}; function f(x){ return x.hasOwnProperty('a'); }` +
          " var out = String(f(o)) + String(o.propertyIsEnumerable('a')) + String(o.propertyIsEnumerable('b'));",
        true,
        runnerOptions(),
      ),
    SLOW,
  );
});

describe("#7354 P1 — the value the [[Get]] reads decides", () => {
  it.each([
    [
      "an own method wins",
      "var o = {a: 1, hasOwnProperty: function(k){ return 'mine' + k; }}; var out = String(o.hasOwnProperty('a'));",
    ],
    [
      "a user prototype's method wins",
      "var p = {hasOwnProperty: function(k){ return 'proto' + k; }}; var o = Object.create(p); var out = String(o.hasOwnProperty('z'));",
    ],
    [
      "a constructor prototype's method wins",
      "function C(){} C.prototype.hasOwnProperty = function(k){ return 'C' + k; }; var out = String(new C().hasOwnProperty('z'));",
    ],
    [
      "a defined own data property wins",
      "var o = {}; Object.defineProperty(o, 'hasOwnProperty', {value: function(){ return 'd'; }}); var out = o.hasOwnProperty('x');",
    ],
    [
      "a number written over it is not callable: the catchable TypeError",
      "var o = {}; o.hasOwnProperty = 5; var out = t(function(){ o.hasOwnProperty('x'); }) + String(o.hasOwnProperty);",
    ],
    [
      "the identity test reads the value the [[Get]] answered, before the argument replaced it",
      "var o = {a: 1}; var g = function(k){ return 'g' + k; };" +
        " var out = String(o.hasOwnProperty((o.hasOwnProperty = g, 'a'))) + String(o.hasOwnProperty('a'));",
    ],
    [
      "Object.create(null) holds no method: `undefined`, and the call is the catchable TypeError",
      "function mk(){ return Object.create(null); } var n = mk(); Object.defineProperty(n, 'q', {value: 1});" +
        " var out = typeof n.hasOwnProperty + t(function(){ n.hasOwnProperty('q'); });",
    ],
    [
      "an undefined or null receiver throws at the [[Get]], before the argument is evaluated",
      "var u; var z = null; var n = 0; function k(){ n = n + 1; return 'x'; }" +
        " var out = t(function(){ u.hasOwnProperty(k()); }) + t(function(){ z.propertyIsEnumerable(k()); }) + String(n);",
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});
