// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O2 — accessor properties on the Prepared path: the realm calls a source getter / setter through F2's
// dispatcher (`buildAccessorCall`), for a read, a write, a descriptor field read and a defineProperties key read.
// Each program runs against node twice, with the test262 runner's options: its answer returns, a wrong one throws.
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  abortBodies,
  abortsAtRunTime,
  agreesWithNode,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());
/** `t(f)`: `f()`'s answer, or "T" for a TypeError, "seven" for `throw 7`, "x" for another throw. */
const T =
  "function t(f){ try { return String(f()); } catch (e) { return e.name === 'TypeError' ? 'T' : e === 7 ? 'seven' : 'x'; } }";
/** `n` statements writing fifty properties `k0`…`k49` of `target`: the storage grows. */
const grow = (target: string, value: string) =>
  Array.from({ length: 50 }, (_, index) => `${target}.k${index} = ${value};`).join(" ");
/** A descriptor object `d` whose fields are getters that log their own name. */
const LOGGED =
  "var log = ''; function logged(d, k, v){ Object.defineProperty(d, k, {enumerable: true, get: function(){ log = log + k + ','; return v; }}); }";

describe("#7354 O2 — the getter's receiver", () => {
  it.each([
    [
      "an inherited getter's `this` is the original object, three links deep too",
      "var a = {}; Object.defineProperty(a, 'x', {get: function(){ return this.tag; }}); var b = Object.create(a);" +
        " var c = Object.create(b); var d = Object.create(c); d.tag = 'd'; c.tag = 'c';" +
        " var p = {}; Object.defineProperty(p, 'y', {get: function(){ return this === q; }}); var q = Object.create(p);" +
        " var out = d.x + c.x + String(b.x) + String(q.y) + String(p.y);",
    ],
    [
      "a literal's getter on a prototype, and a child's own data shadowing it",
      "var p = {get x(){ return this.v; }}; var c = Object.create(p); c.v = 4;" +
        " var s = Object.create(p); Object.defineProperty(s, 'x', {value: 'own'}); var out = String(c.x) + String(p.x) + s.x;",
    ],
    [
      "a constructor's prototype accessor, on instances made with `new`",
      "function C(v){ this.v = v; } Object.defineProperty(C.prototype, 'dbl', {get: function(){ return this.v * 2; }});" +
        " var a = new C(2), b = new C(5); var out = String(a.dbl) + ',' + String(b.dbl);",
    ],
    [
      "accessors on a function object: getter and setter receive the function",
      "var f = function(){}; var s; Object.defineProperty(f, 'x', {get: function(){ return this === f; }," +
        " set: function(v){ s = this === f; }}); f.x = 8; var out = String(f.x) + String(s);",
    ],
    [
      "a getter returning a function: the call's `this` is the object",
      "var o = {n: 3, get m(){ return function(){ return this === o; }; }}; var out = String(o.m()) + String(o.n);",
    ],
    [
      "a descriptor's getter, called through a value, gets that call's receiver",
      "var o = {get x(){ return this === o ? 'o' : 'other'; }}; var g = Object.getOwnPropertyDescriptor(o, 'x').get;" +
        " var q = {g: g}; var out = q.g();",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — reads and writes", () => {
  it.each([
    [
      "one getter call per read, in a loop, inside a function and under typeof",
      "var n = 0; var o = {get x(){ n = n + 1; return n; }}; var s = 0; for (var i = 0; i < 4; i = i + 1) s = s + o.x;" +
        " function r(q){ return q.x; } var k = typeof o.x; var out = String(s) + String(r(o)) + k + String(n);",
    ],
    [
      "hasOwnProperty, propertyIsEnumerable and getOwnPropertyDescriptor never call the getter",
      "var n = 0; var o = {get x(){ n = n + 1; return 1; }}; var a = o.hasOwnProperty('x'), b = o.propertyIsEnumerable('x');" +
        " var d = Object.getOwnPropertyDescriptor(o, 'x'); var out = String(a) + String(b) + String(n) + typeof d.get;",
    ],
    [
      "an assignment's value is the right-hand side, whatever the setter stores",
      "var o = {}; var got; Object.defineProperty(o, 'x', {set: function(v){ got = v; this.y = 99; }});" +
        " var r = (o.x = 5); var a = {}; a.z = o.x = 7; var out = String(r) + String(got) + String(o.y) + String(o.x) + String(a.z);",
    ],
    [
      "a setter on the prototype chain intercepts the write: no own property is created",
      "var a = {}; Object.defineProperty(a, 'x', {set: function(v){ this.s = v; }}); var b = Object.create(a);" +
        " var c = Object.create(b); c.x = 9; var p = {set y(v){ this.seen = v; }}; var q = Object.create(p); q.y = 5;" +
        " var out = String(c.s) + String(c.hasOwnProperty('x')) + String(a.s) + String(q.seen) + String(q.hasOwnProperty('y'));",
    ],
    [
      "sloppy: a write to a getter-only property is ignored; a setter-only property reads undefined",
      "var o = {}; Object.defineProperty(o, 'x', {get: function(){ return 1; }}); o.x = 2; var w = {set x(v){}};" +
        " var out = String(o.x) + String(w.x);",
    ],
    [
      "strict: a write to a getter-only property, own, literal or inherited, is a catchable TypeError",
      `'use strict'; ${T} var o = {}; Object.defineProperty(o, 'x', {get: function(){ return 1; }}); var l = {get x(){ return 2; }};` +
        " var c = Object.create(l); var out = t(function(){ o.x = 3; }) + t(function(){ l.x = 3; }) + t(function(){ c.x = 3; })" +
        " + String(o.x) + String(c.hasOwnProperty('x'));",
    ],
    [
      "an accessor's valueOf / toString is read through the getter by ToPrimitive",
      "var o = {}; Object.defineProperty(o, 'valueOf', {get: function(){ return function(){ return 41; }; }});" +
        " var s = {get toString(){ return function(){ return 'S'; }; }}; var out = String(o + 1) + ('' + s) + String(s);",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — a throwing getter or setter", () => {
  it.each([
    [
      "propagates catchably from a read, a write and ToPrimitive, and the receiver is restored",
      `'use strict'; ${T} var o = {get x(){ throw 7; }, set x(v){ throw 7; }, get valueOf(){ throw 7; }};` +
        " var q = {m: function(){ try { o.x; } catch (e) {} return this === q; }};" +
        " var out = t(function(){ return o.x; }) + t(function(){ o.x = 1; }) + t(function(){ return o + 1; }) + String(q.m());",
    ],
    [
      "a TypeError raised inside a getter is catchable, twice",
      `${T} var o = {get x(){ var u; return u.boom; }}; var out = t(function(){ return o.x; }) + t(function(){ return o.x; });`,
    ],
    [
      "throws on its second call only",
      `${T} var n = 0; var o = {get x(){ n = n + 1; if (n === 2) throw 7; return n; }};` +
        " var a = o.x; var b = t(function(){ return o.x; }); var c = o.x; var out = String(a) + b + String(c);",
    ],
    [
      "propagates through defineProperty, create and defineProperties, which define nothing",
      `${T} var o = {}; var d = {get value(){ throw 7; }}; var made; var props = {};` +
        " Object.defineProperty(props, 'a', {enumerable: true, get: function(){ throw 7; }});" +
        " var two = {a: {value: 1}}; Object.defineProperty(two, 'b', {enumerable: true, get: function(){ throw 7; }});" +
        " var field = {a: {value: 1}, b: {get value(){ throw 7; }}}; var p = {}, q = {};" +
        " var out = t(function(){ Object.defineProperty(o, 'p', d); }) + String(o.hasOwnProperty('p'))" +
        " + t(function(){ made = Object.create({}, props); }) + String(made)" +
        " + t(function(){ Object.defineProperties(p, two); }) + String(p.hasOwnProperty('a'))" +
        " + t(function(){ Object.defineProperties(q, field); }) + String(q.hasOwnProperty('a')) + String(q.hasOwnProperty('b'));",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — re-entrancy: the realm keeps nothing across the call", () => {
  it.each([
    [
      "a getter that redefines its own property (as an accessor, as data)",
      "var o = {}; Object.defineProperty(o, 'x', {configurable: true, get: function(){" +
        " Object.defineProperty(o, 'x', {get: function(){ return 2; }}); return 1; }}); var a = o.x;" +
        " var d = {}; Object.defineProperty(d, 'x', {configurable: true, get: function(){ Object.defineProperty(d, 'x', {value: 4}); return 3; }});" +
        " var b = d.x; var out = String(a) + String(o.x) + String(b) + String(d.x);",
    ],
    [
      "a getter that grows the object it is read from, and the receiver of an inherited read",
      `var o = {}; Object.defineProperty(o, 'x', {get: function(){ ${grow("o", "1")} return 'g'; }}); var a = o.x;` +
        ` var p = {}; Object.defineProperty(p, 'y', {get: function(){ ${grow("this", "2")} return 1; }}); var c = Object.create(p);` +
        " var b = c.y; var out = a + String(o.k49) + String(o.x) + String(b) + String(c.k49) + String(c.y) + String(p.k0);",
    ],
    [
      "a setter that grows its receiver, and one that redefines the property it was found on",
      `var o = {}; Object.defineProperty(o, 'x', {set: function(v){ ${grow("this", "v")} }}); o.x = 3;` +
        " var r = {}; Object.defineProperty(r, 'x', {configurable: true, set: function(v){ Object.defineProperty(r, 'x', {value: v, writable: true}); }});" +
        " r.x = 4; r.x = 5; var p = {}; Object.defineProperty(p, 'z', {configurable: true, set: function(v){" +
        " Object.defineProperty(p, 'z', {value: 0, writable: true}); this.y = v; }}); var c = Object.create(p); c.z = 1; c.z = 2;" +
        " var out = String(o.k49) + String(r.x) + String(c.y) + String(c.z) + String(c.hasOwnProperty('z')) + String(p.z);",
    ],
    [
      "recursive reads and writes of the same accessor",
      "var depth = 0; var o = {get x(){ depth = depth + 1; if (depth < 4) return o.x + 1; return 0; }};" +
        " var n = 0; var w = {set x(v){ n = n + 1; if (v > 0) w.x = v - 1; }}; w.x = 3; var out = String(o.x) + String(depth) + String(n);",
    ],
    [
      "a descriptor getter that defines the same target while defineProperties converts",
      `${T} var o = {}; var props = {}; Object.defineProperty(props, 'a', {enumerable: true, get: function(){` +
        " Object.defineProperty(o, 'a', {value: 'inner', configurable: true}); return {value: 'outer'}; }}); Object.defineProperties(o, props);" +
        " var n = {}; var nc = {}; Object.defineProperty(nc, 'a', {enumerable: true, get: function(){" +
        " Object.defineProperty(n, 'a', {value: 'inner'}); return {value: 'outer'}; }});" +
        " var out = o.a + t(function(){ Object.defineProperties(n, nc); }) + n.a;",
    ],
    [
      "a key getter that hides a later key or adds one: the key list is read once, each key's attributes again",
      "var o = {}; var props = {}; Object.defineProperty(props, 'a', {enumerable: true, get: function(){" +
        " Object.defineProperty(props, 'b', {enumerable: false}); props.c = {value: 3}; return {value: 1}; }});" +
        " Object.defineProperty(props, 'b', {value: {value: 2}, enumerable: true, configurable: true}); Object.defineProperties(o, props);" +
        " var out = String(o.a) + String(o.hasOwnProperty('b')) + String(o.hasOwnProperty('c'));",
    ],
    [
      "a descriptor field getter that grows the descriptor object",
      `var d = {}; Object.defineProperty(d, 'value', {get: function(){ ${grow("d", "1")} d.writable = true; return 5; }});` +
        " var o = {}; Object.defineProperty(o, 'p', d); var out = String(o.p) + String(Object.getOwnPropertyDescriptor(o, 'p').writable);",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — ToPropertyDescriptor reads each field once, in order", () => {
  it.each([
    [
      "enumerable, configurable, value, writable, then get, set",
      `${LOGGED} var d = {}; logged(d, 'writable', true); logged(d, 'value', 1); logged(d, 'configurable', true); logged(d, 'enumerable', true);` +
        " var e = {}; logged(e, 'set', undefined); logged(e, 'get', function(){ return 2; }); var o = {};" +
        " Object.defineProperty(o, 'p', d); Object.defineProperty(o, 'q', e); var out = log + String(o.p) + String(o.q);",
    ],
    [
      "a get that is no function throws when get is processed, before set is read",
      `${T} ${LOGGED} var d = {}; logged(d, 'set', undefined); logged(d, 'get', 5); logged(d, 'configurable', true); var o = {};` +
        " var out = t(function(){ Object.defineProperty(o, 'p', d); }) + log + String(o.hasOwnProperty('p'));",
    ],
    [
      "a set that is no function; get and value together",
      `${T} ${LOGGED} var d = {}; logged(d, 'set', 'no'); logged(d, 'get', function(){}); var e = {}; logged(e, 'get', function(){});` +
        " logged(e, 'value', 1); var o = {}; var out = t(function(){ Object.defineProperty(o, 'p', d); }) + t(function(){" +
        " Object.defineProperty(o, 'q', e); }) + log + String(o.hasOwnProperty('p'));",
    ],
    [
      "inherited and getter-valued descriptor fields",
      "var proto = {get enumerable(){ return true; }, value: 3}; function D(){} D.prototype = proto; var o = {}; Object.defineProperty(o, 'p', new D());" +
        " var g = Object.getOwnPropertyDescriptor(o, 'p'); Object.defineProperty(o, 'q', {get get(){ return function(){ return 'G'; }; }});" +
        " var out = String(o.p) + String(g.enumerable) + String(g.writable) + o.q;",
    ],
    [
      "`get: undefined` and `set: undefined` define a property that reads undefined",
      `${T} var o = {}; Object.defineProperty(o, 'x', {get: undefined, set: undefined, configurable: true}); var d = Object.getOwnPropertyDescriptor(o, 'x');` +
        " var out = String(o.x) + String(d.get) + String(d.set) + String(d.hasOwnProperty('value')) + String(d.hasOwnProperty('writable'))" +
        " + t(function(){ Object.defineProperty(o, 'y', {get: 1}); }) + t(function(){ Object.defineProperty(o, 'y', {set: {}}); }) + String(o.hasOwnProperty('y'));",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — definitions", () => {
  it.each([
    [
      "getOwnPropertyDescriptor answers {get, set, enumerable, configurable}, the same functions",
      "var g = function(){ return 1; }, s = function(v){}; var o = {}; Object.defineProperty(o, 'x', {get: g, set: s, enumerable: true});" +
        " var d = Object.getOwnPropertyDescriptor(o, 'x'); var out = String(d.get === g) + String(d.set === s) + String(d.enumerable)" +
        " + String(d.configurable) + String(d.hasOwnProperty('value')) + String(d.hasOwnProperty('writable'));",
    ],
    [
      "an object literal's get and set merge into one enumerable, configurable accessor",
      "var o = {get x(){ return 1; }, set x(v){ this.s = v; }}; o.x = 4; var d = Object.getOwnPropertyDescriptor(o, 'x');" +
        " var l = {get y(){ return 1; }}; var e = Object.getOwnPropertyDescriptor(l, 'y');" +
        " var out = typeof d.get + typeof d.set + String(d.enumerable) + String(d.configurable) + String(o.s) + String(o.x) + String(e.set);",
    ],
    [
      "an accessor of a literal is a function object: length, `get x` / `set x`, no prototype",
      "var o = {get x(){ return 1; }, set x(v){}}; var d = Object.getOwnPropertyDescriptor(o, 'x');" +
        " var out = String(d.get.length === 0) + String(d.set.length === 1) + d.get.name + '|' + d.set.name + String(d.get.hasOwnProperty('prototype'));",
    ],
    [
      "a data key then an accessor of the same name in one literal, and the reverse",
      "var o = {x: 1, get x(){ return 2; }}; var p = {get x(){ return 2; }, x: 1};" +
        " var out = String(o.x) + String(Object.getOwnPropertyDescriptor(o, 'x').hasOwnProperty('value')) + String(p.x);",
    ],
    [
      "configurable redefinition: accessor to data, data to accessor, a half added",
      "var fv = function(){ return 1; }; var o = {}; Object.defineProperty(o, 'x', {get: fv, configurable: true}); Object.defineProperty(o, 'x', {value: 5});" +
        " var a = Object.getOwnPropertyDescriptor(o, 'x'); var p = {y: 1}; Object.defineProperty(p, 'y', {get: function(){ return 9; }});" +
        " var b = Object.getOwnPropertyDescriptor(p, 'y'); var s; var q = {}; Object.defineProperty(q, 'z', {get: function(){ return 1; }, configurable: true});" +
        " Object.defineProperty(q, 'z', {set: function(v){ s = v; }}); q.z = 4;" +
        " var out = String(o.x) + String(a.writable) + String(a.configurable) + String(p.y) + String(b.enumerable) + String(b.hasOwnProperty('writable')) + String(q.z) + String(s);",
    ],
    [
      "non-configurable redefinition: kind changes and another getter are TypeErrors, the same getter is not",
      `${T} var fv = function(){ return 1; }; var o = {}; Object.defineProperty(o, 'x', {get: fv}); var p = {}; Object.defineProperty(p, 'y', {value: 1});` +
        " var g = function(){ return 2; }; var q = {}; Object.defineProperty(q, 'z', {get: g}); Object.defineProperty(q, 'z', {get: g});" +
        " var out = t(function(){ Object.defineProperty(o, 'x', {value: 5}); }) + t(function(){ Object.defineProperty(p, 'y', {get: fv}); })" +
        " + t(function(){ Object.defineProperty(q, 'z', {get: function(){ return 3; }}); }) + String(o.x) + String(p.y) + String(q.z);",
    ],
    [
      "accessor descriptors through Object.create and through defineProperties on a function's properties",
      "var n = Object.create({}, {p: {get: function(){ return this === n; }, enumerable: true}}); var data = 'd'; var f = function(){};" +
        " f.prop = {set: function(v){ data = v; }}; var obj = {}; Object.defineProperties(obj, f); obj.prop = 'fd';" +
        " var out = String(n.p) + String(n.propertyIsEnumerable('p')) + data + String(obj.hasOwnProperty('prop'));",
    ],
  ])("%s", async (_, body) => agrees(body), SLOW);
});

describe("#7354 O2 — what stays an abort or a refusal", () => {
  it(
    "a built-in function as a getter: the realm runs its algorithm, the Object.prototype method's abort",
    async () =>
      abortsAtRunTime(
        "var f = function(){}; f(); var o = {}; Object.defineProperty(o, 'x', {get: o.hasOwnProperty}); var out = o.x;",
        runnerOptions(),
      ),
    SLOW,
  );
  // Compound assignment of a member is slice L0's (one [[Get]], one [[Set]]); pinned here for an accessor member.
  it(
    "o.x += v and o.x++ on an accessor: refused at top level",
    async () => {
      const setup = "var o = {get x(){ return 1; }, set x(v){}};";
      expect(await refusal(`${setup} o.x += 1;`, runnerOptions())).toContain(
        "compound property write on dynamic not in IR scope",
      );
      expect(await refusal(`${setup} o.x++;`, runnerOptions())).toContain(
        "compound property write on dynamic not in IR scope",
      );
    },
    SLOW,
  );
  it(
    "o.x += v on an accessor inside a function: the function's body is the abort",
    async () => {
      const bodies = await abortBodies("var o = {get x(){ return 1; }, set x(v){}}; function f(q){ q.x += 1; } f(o);");
      expect(bodies.some((row) => row.startsWith("f: "))).toBe(true);
    },
    SLOW,
  );
});
