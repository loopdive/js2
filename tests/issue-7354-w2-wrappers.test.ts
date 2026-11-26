// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 W2 — String, Number, Boolean and Object as realm constructors on the Prepared path: the constructors are
// function objects of the realm (identity, `typeof`, `length`, `name`, their prototypes), `new String(v)` and its
// siblings are #3518's wrapper objects (the primitive in a slot, a String's indices and `length` stored), the calls
// without `new` are ToString / ToNumber / ToBoolean / ToObject, and the wrappers' `valueOf` / `toString` answer
// thisXValue. Each program computes `out` and is checked against node and with a wrong answer
// (tests/helpers/prepared-node-agreement.ts); a program that writes a built-in prototype runs in a fresh node realm.
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, freshRealmOut, refusal } from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
/** A function expression: on this path a function value is what makes the dispatcher exist. */
const CALLS = "\nvar k = function(){ return 1; }; k();";

const VALUES: readonly (readonly [string, string])[] = [
  [
    "the constructors: typeof, identity, length, name, prototype and prototype.constructor",
    `var out = typeof String + typeof Number + typeof Boolean + typeof Object
  + String(String === String) + String(String !== Number) + String.length + Number.length + Boolean.length
  + Object.length + String.name + Number.name + Boolean.name + Object.name + typeof String.prototype
  + String(String.prototype.constructor === String) + String(Number.prototype.constructor === Number)
  + String(Boolean.prototype.constructor === Boolean);`,
  ],
  [
    "a constructor's prototype property: read only, not enumerable, not configurable",
    `var d = Object.getOwnPropertyDescriptor(Number, "prototype");
var out = String(d.writable) + String(d.enumerable) + String(d.configurable) + String(d.value === Number.prototype);`,
  ],
  [
    "Number's data constants",
    `var d = Object.getOwnPropertyDescriptor(Number, "MAX_VALUE");
var out = Number.MAX_VALUE + "|" + Number.MIN_VALUE + "|" + Number.POSITIVE_INFINITY + "|" + Number.NEGATIVE_INFINITY
  + "|" + String(Number.NaN !== Number.NaN) + "|" + Number.EPSILON + "|" + Number.MAX_SAFE_INTEGER
  + String(d.writable) + String(d.configurable);`,
  ],
  [
    "the calls without new: ToString, ToNumber, ToBoolean",
    `var o = { valueOf: function () { return 4; }, toString: function () { return "t"; } };
var out = String(12) + String(true) + String() + String(undefined) + "|" + Number("3") + Number() + Number(true)
  + Number("x") + Number(null) + Number(o) + "|" + Boolean("") + Boolean("a") + Boolean() + Boolean(0) + Boolean(o)
  + "|" + String(o);`,
  ],
  [
    "new String / Number / Boolean: typeof, valueOf, toString, truthiness",
    `var s = new String("ab"); var n = new Number(5); var b = new Boolean(false);
var out = typeof s + typeof n + typeof b + s.valueOf() + n.valueOf() + b.valueOf() + s.toString() + n.toString()
  + b.toString() + (b ? "T" : "F") + typeof n.valueOf() + new String().valueOf() + "|" + new Number().valueOf()
  + new Boolean().valueOf() + String(new Number(NaN).valueOf() !== new Number(NaN).valueOf());`,
  ],
  [
    "a wrapper's ToPrimitive: +, concatenation, arithmetic, String(), Number()",
    `var n = new Number(6); var s = new String("x"); var b = new Boolean(true);
var out = String(n + 1) + (s + "y") + String(b + 1) + String(n * 2) + String(n - 1) + String(new Number(7) % 4)
  + String(new Number(1)) + String(Number(new String("5"))) + (new Number(1) + "" + new Boolean(false));`,
  ],
  [
    "a String object's own indices and length (the exotic object's attributes)",
    `var s = new String("abc"); var d = Object.getOwnPropertyDescriptor(s, "1");
var l = Object.getOwnPropertyDescriptor(s, "length");
var out = s.length + d.value + String(d.writable) + String(d.enumerable) + String(d.configurable)
  + String(l.writable) + String(l.enumerable) + String(s.hasOwnProperty("2")) + String(s.hasOwnProperty("3"))
  + String(s.propertyIsEnumerable("0")) + String(s.propertyIsEnumerable("length"));`,
  ],
  [
    "a String object's index cannot be redefined; the same value can",
    `var s = new String("ab"); var out;
try { Object.defineProperty(s, "0", { value: "x" }); out = "no"; } catch (e) { out = String(e instanceof TypeError); }
Object.defineProperty(s, "0", { value: "a" }); out = out + Object.getOwnPropertyDescriptor(s, "0").value;`,
  ],
  [
    "Object(v) and new Object(v): a new object, the object itself, a primitive's wrapper",
    `var o = {}; var w = Object(1); var t = Object("ab"); var u = Object(true);
var out = String(Object(o) === o) + String(new Object(o) === o) + typeof Object(null) + typeof Object(undefined)
  + typeof Object() + typeof new Object() + typeof w + String(w + 1) + String(w instanceof Number) + t.length
  + String(t instanceof String) + String(u instanceof Boolean) + String(u.valueOf()) + String(Object(k) === k);`,
  ],
  [
    "instanceof and isPrototypeOf over the wrappers and their prototypes",
    `var out = String(new String("a") instanceof String) + String("a" instanceof String)
  + String(new Number(1) instanceof Object) + String(new Number(1) instanceof String)
  + String(String.prototype.isPrototypeOf(new String("x"))) + String(Number.prototype.isPrototypeOf(1))
  + String(Object.prototype.isPrototypeOf(new Boolean(true))) + String(Object.prototype.isPrototypeOf(String))
  + String(String instanceof Object);`,
  ],
  [
    "Object.prototype.toString of wrappers, a wrapper's constructor",
    `var t = function (v) { return Object.prototype.toString.call(v); };
var out = t(new String("a")) + t(new Number(1)) + t(new Boolean(false)) + t({})
  + String(new String("a").constructor === String) + String(Object(1).constructor === Number);`,
  ],
  [
    "a wrong receiver of valueOf / toString is a catchable TypeError",
    `var o = { valueOf: String.prototype.valueOf }; var p = { toString: Number.prototype.toString };
var q = { valueOf: Boolean.prototype.valueOf }; var out = "";
try { o.valueOf(); } catch (e) { out = out + String(e instanceof TypeError); }
try { String(p); } catch (e) { out = out + String(e instanceof TypeError); }
try { out = out + (q + 1); } catch (e) { out = out + String(e instanceof TypeError); }
try { Object.create(Number.prototype).valueOf(); } catch (e) { out = out + String(e instanceof TypeError); }`,
  ],
  [
    "a wrapper is an ordinary object: own properties, defineProperty, strict equality",
    `var n = new Number(1); Object.defineProperty(n, "x", { value: 5 }); n.y = 2; var m = n;
var out = String(n.x) + String(n.y) + String(n + 1) + String(n === m) + String(n !== new Number(1))
  + String(new Number(1) === 1);`,
  ],
  [
    "valueOf overridden on the instance; a valueOf returning an object falls to toString",
    `var n = new Number(1); n.valueOf = function () { return 10; };
var m = new Number(5); Object.defineProperty(m, "valueOf", { value: function () { return {}; } });
var out = String(n + 1) + "|" + String(m + 1);`,
  ],
];

/** Programs that write a built-in prototype: node evaluates each in a fresh realm. */
const WRITES: readonly (readonly [string, string])[] = [
  [
    "Number.prototype.valueOf replaced: ToPrimitive calls the replacement",
    `Number.prototype.valueOf = function () { return 20; }; var out = String(new Number(1) + 1);`,
  ],
  [
    "String.prototype.toString replaced: String() calls the replacement",
    `String.prototype.toString = function () { return "T"; }; var out = String(new String("x"));`,
  ],
  [
    "a property added to String.prototype is read by a String object and by a string",
    `String.prototype.foo = 3; var s = "a"; var out = String(s.foo) + String(new String("b").foo);`,
  ],
];

describe("#7354 W2 — wrappers and the four constructors agree with node", () => {
  it.each(VALUES)("%s", async (_label, body) => agreesWithNode(body + CALLS), SLOW);
  it.each(WRITES)("%s", async (_label, body) => agreesWithNode(body + CALLS, true, undefined, freshRealmOut), SLOW);
});

describe("#7354 W2 — what the realm does not hold refuses or aborts", () => {
  it.each([
    ["an unheld static", `var out = typeof String.fromCharCode;${CALLS}`],
    ["an unheld Object static", `var out = typeof Object.keys;${CALLS}`],
    ["an unheld prototype method of a String object", `var out = typeof new String("a").charAt;${CALLS}`],
    ["a constructor called through a variable", `var C = String; var out = typeof new C("a");${CALLS}`],
    ["Number.prototype.toString with a radix", `var out = new Number(255).toString(16);${CALLS}`],
  ])("%s ends at the run-time abort", async (_label, source) => abortsAtRunTime(source), SLOW);

  it(
    "a script var of a realm constructor refuses by name",
    async () => {
      expect(await refusal(`var String; var out = typeof String;${CALLS}`)).toContain("script var 'String'");
    },
    SLOW,
  );

  it(
    "loose equality with a wrapper refuses as all loose equality does",
    async () => {
      expect(await refusal(`var out = String(new Number(1) == 1);${CALLS}`)).toContain("dyn.eq (loose)");
    },
    SLOW,
  );
});
