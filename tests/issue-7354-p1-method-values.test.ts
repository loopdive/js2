// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 P1 — `isPrototypeOf`, and the three Object.prototype methods as values, through the strict Prepared entry with
// the test262 runner's options. A method read is a built-in function object of the realm (its `typeof`, `length`,
// `name`, identity); a call that does not read it as `o.m(…)` reaches the dispatcher, which cannot run a built-in: the
// run-time abort. A value that is not callable keeps the dispatcher's catchable TypeError.
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { CATCHES } from "./helpers/object-static-probes.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const PRELUDE = `var fv = function(){ return 1; }; fv(); ${CATCHES} `;
const agrees = (body: string) => agreesWithNode(PRELUDE + body, true, runnerOptions());

describe("#7354 P1 — isPrototypeOf", () => {
  it.each([
    [
      "a two-level Object.create chain; a value that is no object is never an instance",
      "var a = {}; var b = Object.create(a); var c = Object.create(b);" +
        " var out = String(a.isPrototypeOf(c)) + String(b.isPrototypeOf(c)) + String(c.isPrototypeOf(a))" +
        " + String(c.isPrototypeOf(c)) + String(a.isPrototypeOf(1)) + String(a.isPrototypeOf()) + String(a.isPrototypeOf(fv));",
    ],
    [
      "a constructor's prototype and its instances",
      "function C(){} var other = {}; function check(p, c){ return String(p.isPrototypeOf(c)) + String(other.isPrototypeOf(c)); }" +
        " var out = check(C.prototype, new C());",
    ],
    [
      "(#7354 G1) a caught error is an ordinary object: its own message, and Error.prototype on its chain",
      "function nul(){ return null; } var out; try { nul().x; } catch (e) {" +
        " out = String(e.hasOwnProperty('message')) + String(e.propertyIsEnumerable('message'))" +
        " + String(TypeError.prototype.isPrototypeOf(e)) + String(e.isPrototypeOf(e)); }",
    ],
    [
      "a primitive or function receiver is no object's prototype",
      "function id(v){ return v; } var o = {}; var out = String(id(1).isPrototypeOf(o)) + String(id('s').isPrototypeOf(o))" +
        " + String(fv.isPrototypeOf(o));",
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

describe("#7354 P1 — the methods as values", () => {
  it.each([
    [
      "typeof, length, name and identity",
      "var a = {}; var b = {x: 1}; var h = a.hasOwnProperty;" +
        " var out = typeof h + String(h.length) + h.name + String(a.hasOwnProperty === b.hasOwnProperty)" +
        " + String(a.hasOwnProperty === a.propertyIsEnumerable) + String(h.prototype) + String(a.isPrototypeOf.length)" +
        " + a.propertyIsEnumerable.name;",
    ],
    [
      "a method's own properties: length and name, read only, no prototype; a written one",
      "var h = ({}).hasOwnProperty; h.x = 3; h.length = 9;" +
        " var out = String(h.hasOwnProperty('length')) + String(h.hasOwnProperty('prototype'))" +
        " + String(h.propertyIsEnumerable('name')) + String(h.x) + String(h.length);",
    ],
    [
      "read off a primitive: Object.prototype's own",
      "function id(v){ return v; } var one = id(1), s = id('abc');" +
        " var out = typeof one.hasOwnProperty + typeof s.isPrototypeOf + String(one.hasOwnProperty === ({}).hasOwnProperty);",
    ],
    [
      "calling a value that is not callable stays the catchable TypeError",
      "var o = {n: 1}; var x = 2; function call(f){ return f(); }" +
        " var out = t(function(){ o.n(); }) + t(function(){ o.missing(); }) + t(function(){ call(x); }) + String(o.hasOwnProperty('n'));",
    ],
  ])("%s", (_label, body) => agrees(body), SLOW);
});

describe("#7354 P1 — what ends at the run-time abort", () => {
  it.each([
    [
      "a method called through another value (its this is undefined)",
      "var h = ({}).hasOwnProperty; t(function(){ h('x'); });",
    ],
    ["a method as a constructor", "var h = ({}).propertyIsEnumerable; t(function(){ new h(); });"],
    // (review r1) Only `o.m(v)` runs the method's algorithm: a detached call's receiver is not the [[Get]]'s, and JS
    // throws (ToObject of `undefined`), where the algorithm would have answered `false`.
    ...[
      ["isPrototypeOf", "c"],
      ["hasOwnProperty", "'a'"],
      ["propertyIsEnumerable", "'a'"],
    ].flatMap(([method, argument]): [string, string][] => [
      [
        `a detached ${method} read into a local`,
        `function f(p, c){ var m = p.${method}; try { return String(m(${argument})); } catch (e) { return 'T'; } }` +
          ` var p = {a: 1}; f(p, Object.create(p));`,
      ],
      [
        `a detached ${method} through a comma`,
        `function f(p, c){ try { return String((0, p.${method})(${argument})); } catch (e) { return 'T'; } }` +
          ` var p = {a: 1}; f(p, Object.create(p));`,
      ],
    ]),
    [
      "a string receiver (the String exotic's own keys)",
      "function id(v){ return v; } id('abc').hasOwnProperty('length');",
    ],
    ["Object.prototype's other keys stay C2-D1's own-or-abort", "var o = {}; String(o.toString);"],
  ])("%s", (_label, body) => abortsAtRunTime(PRELUDE + body, runnerOptions()), SLOW);
});

describe("#7354 P1 — what refuses", () => {
  it(
    "a program that reads a method but creates no function value (the function kind is not admitted)",
    async () => {
      expect(await refusal("var o = {a: 1}; var out = typeof o.hasOwnProperty;", runnerOptions())).toBe(
        "dynamic operation member read 'hasOwnProperty' in a program that creates no function value has no Prepared intrinsic",
      );
    },
    SLOW,
  );
});
