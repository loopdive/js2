// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 G1 — the Error family as realm values on the Prepared path: `Error` and the six NativeErrors are function
// objects of the realm (identity, `typeof`, `length`, `name`, their prototypes), an error is an ordinary object of
// its constructor's prototype, and the realm's own TypeError is one too. Each program computes `out` and is checked
// against node (in a fresh realm, as some write a built-in prototype) and with a wrong answer
// (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression: on this path a function
// value is what makes the dispatcher exist.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";
/** A realm TypeError: the nullish member read inside `g`. */
const REALM = "function g(o) { return o.x; }\n";

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "the constructors: typeof, length, name, prototype.constructor, prototype name and message",
    `var out = typeof TypeError + TypeError.length + TypeError.name + Error.name + Error.length
  + String(TypeError.prototype.constructor === TypeError) + String(Error.prototype.constructor === Error)
  + EvalError.prototype.name + RangeError.prototype.name + ReferenceError.prototype.name
  + SyntaxError.prototype.name + URIError.prototype.name + "[" + URIError.prototype.message + "]"
  + String(TypeError === TypeError) + String(TypeError !== RangeError);`,
  ],
  [
    "the prototype chains: isPrototypeOf and instanceof across the family",
    `var e = new TypeError("m");
var out = String(Error.prototype.isPrototypeOf(TypeError.prototype)) + String(TypeError.prototype.isPrototypeOf(e))
  + String(e instanceof TypeError) + String(e instanceof Error) + String(e instanceof RangeError)
  + String(new RangeError() instanceof Error) + String(new Error() instanceof TypeError)
  + String(ReferenceError.prototype instanceof Error) + String({} instanceof Error);`,
  ],
  [
    "new X(m) and X(m): message, name, constructor, ToString, and the call form",
    `var a = new SyntaxError("s"); var b = URIError("u"); var c = Error();
var out = a.message + a.name + String(a.constructor === SyntaxError) + String(a) + "|" + b.message
  + String(b instanceof URIError) + String(b.constructor === URIError) + "|" + String(c) + "|" + c.message;`,
  ],
  [
    'message is an own property only when given (undefined: none; "": one)',
    `var out = String(new Error().hasOwnProperty("message")) + String(new Error(undefined).hasOwnProperty("message"))
  + String(new Error("").hasOwnProperty("message")) + String(new TypeError("q").hasOwnProperty("message"))
  + String(new Error("q").propertyIsEnumerable("message")) + String(new Error("q").hasOwnProperty("name"));`,
  ],
  [
    "ToString(message) runs once, through the message's own toString, in order",
    `var c = {n: 0, s: ""};
var e = new TypeError({toString: function(){ c.n = c.n + 1; c.s = c.s + "t"; return "q"; }});
var f = new Error(12); var t = new Error(true);
var out = e.message + c.n + c.s + "|" + f.message + typeof f.message + "|" + t.message;`,
  ],
  [
    "a message whose toString throws: the throw is catchable",
    `var out; try { new Error({toString: function(){ throw 7; }}); out = "no"; } catch (x) { out = "c" + x; }`,
  ],
  [
    "Error.prototype.toString: name and message defaults, empty strings",
    `var a = new Error(); var b = new Error("m"); var c = new TypeError("");
var d = new RangeError("r"); d.name = ""; var e = new Error("x"); e.message = "";
var out = String(a) + "|" + String(b) + "|" + String(c) + "|" + String(d) + "|" + String(e) + "|"
  + b.toString() + "|" + ("" + d) + "|" + String(b.toString === Error.prototype.toString);`,
  ],
  [
    "the realm's TypeError: constructor, name, message, instanceof, ToString, Object.prototype.toString",
    `${REALM}var out;
try { g(null); } catch (e) {
  out = String(e.constructor === TypeError) + e.name + "|" + e.message + "|" + String(e.hasOwnProperty("message"))
    + String(e instanceof TypeError) + String(e instanceof Error) + String(e instanceof RangeError)
    + "|" + String(e) + "|" + Object.prototype.toString.call(e) + "|" + Object.prototype.toString.call(new Error());
}`,
  ],
  [
    "the Object statics on a caught error, an ordinary object (it was the abort while the error was its own kind)",
    `${REALM}var out;
try { g(null); } catch (e) {
  Object.defineProperty(e, "p", {value: 1});
  var d = Object.getOwnPropertyDescriptor(e, "message");
  out = String(e.p) + String(d.enumerable) + String(d.writable) + String(d.configurable) + typeof d.value;
}`,
  ],
  [
    "a caught error keeps its identity through a rethrow, and a caught program error is the same object",
    `${REALM}var a, b, c, d = new RangeError("r");
try { g(null); } catch (e) { a = e; }
try { throw a; } catch (e) { b = e; }
try { throw d; } catch (e) { c = e; }
var out = String(a === b) + String(c === d) + String(c instanceof RangeError) + c.message;`,
  ],
  [
    "an error is an ordinary object: own properties, writes, strict writes, ToNumber",
    `"use strict";
var e = new TypeError("m"); e.foo = 3; e.message = "z";
var out = e.foo + String(e) + String(+e) + String(e === e) + typeof e;`,
  ],
];

/** Programs that write a built-in prototype: node evaluates each in a fresh realm. */
const WRITES: readonly (readonly [string, string])[] = [
  [
    "TypeError.prototype.name written: a later String(e) reads it",
    `var e = new TypeError("m"); TypeError.prototype.name = "X";
var n = new TypeError("n"); var out = String(e) + "|" + ("" + n) + "|" + new TypeError().name;`,
  ],
  [
    'Error.prototype.toString replaced: "" + e and String(e) call the replacement',
    `Error.prototype.toString = function(){ return "over:" + this.message; };
var e = new RangeError("m"); var out = "" + e + "|" + String(e) + "|" + e.toString();`,
  ],
  [
    "Error.prototype gains a property every error inherits",
    `Error.prototype.extra = 5; var out = String(new TypeError("t").extra) + String(new Error().extra);`,
  ],
];

describe("#7354 G1 — the Error family is the realm's", () => {
  it.each(PROGRAMS)("%s", (_name, body) => agreesWithNode(body + CALLS, true, runnerOptions()), SLOW);
  it.each(WRITES)("%s", (_name, body) => agreesWithNode(body + CALLS, true, runnerOptions(), freshRealmOut), SLOW);
});
