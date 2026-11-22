// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 H2 — a script-level function declaration is a writable binding (§9.1.1.4.18). Where an identifier writes it,
// its home is mutable and every read and call reads the home; elsewhere the home and the direct call stay. Each
// accepted program agrees with node and a wrong twin throws; a refusal is asserted by its text.
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

describe("#7354 H2 — a written function declaration", () => {
  it.each([
    ["a write, then a call", "function f(){ return 1; } f = function(){ return 2; }; var out = String(f());"],
    [
      "an alias taken before the write keeps the old function",
      "function f(){ return 1; } var g = f; f = function(){ return 2; }; var out = String(f()) + String(g()) + String(g === f);",
    ],
    [
      "a write inside a function",
      "function f(){ return 1; } function h(){ f = 3; } var out = typeof f; h(); out += typeof f;",
    ],
    [
      "a write inside the declaration itself",
      "function f(){ f = function(){ return 2; }; return 1; } var out = String(f()) + String(f());",
    ],
    ["a write in a closure", "function f(){ return 1; } var k = function(){ f = 7; }; k(); var out = String(f);"],
    [
      "a write in a function that runs before the first call",
      "function f(){ return 1; } function h(){ f = function(){ return 3; }; } h(); var out = String(f());",
    ],
    [
      "the callee is evaluated before the arguments (§13.3.6.1)",
      "function f(a){ return 'old' + typeof a; } function g(a){ return 'new' + typeof a; } var r = f(f = g); var out = r + f(1);",
    ],
    [
      "a write between the arguments does not change the callee",
      "var log = ''; function arg(v){ log = log + String(v); return v; } function f(a, b){ return a + b; } function g(a, b){ return a * b; } var r = f(arg(2), (f = g, arg(3))); var out = String(r) + log + String(f(2, 3));",
    ],
    [
      "a call in another function's body reads the home, also for its result",
      "function f(){ return 1; } function h(){ return f(); } f = function(){ return 2; }; var out = String(h());",
    ],
    [
      "a call statement in another function's body",
      "var n = 0; function f(){ n = 1; } function h(){ f(); } f = function(){ n = 2; }; h(); var out = String(n);",
    ],
    [
      "a call before the declaration sees the function; a later write wins",
      "var out = String(f()); function f(){ return 1; } f = function(){ return 2; }; out += String(f());",
    ],
    [
      "a write placed before the declaration wins (the binding exists before any statement)",
      "f = function(){ return 2; }; function f(){ return 1; } var out = String(f());",
    ],
    [
      "a call through the home pads and drops arguments",
      "function f(a, b){ return typeof b; } f = function(a, b, c){ return typeof c + typeof a; }; var out = f() + f(1, 2, 3, 4);",
    ],
    [
      "a write in a loop",
      "function f(){ return 0; } var out = ''; for (var i = 0; i < 3; i++) { out += String(f()); f = function(){ return i; }; }",
    ],
    [
      "a call of a non-callable value throws a catchable TypeError",
      "function f(){ return 1; } f = 3; var out = ''; try { f(); out = 'no'; } catch (e) { out = 'caught'; }",
    ],
    [
      "strict code calls with `this` undefined",
      "'use strict'; function f(){ return typeof this; } f = f; var out = f();",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);

  // Static facts of the declaration are read from the home once the name is written anywhere.
  it.each([
    ["typeof", "function f(){ return 1; } var a = typeof f; f = 3; var out = a + typeof f;"],
    ["length", "function f(){ return 1; } f = function(a, b){ return 2; }; var out = String(f.length);"],
    ["name", "function f(){ return 1; } f = function named(){ return 2; }; var out = f.name;"],
    [
      "instanceof",
      "function f(){} var o = new f(); var a = o instanceof f; f = function(){}; var out = String(a) + String(o instanceof f);",
    ],
    [
      "new",
      "function f(){ return { a: 1 }; } f = function(){ return { b: 2 }; }; var o = new f(); var out = String(o.b) + String(o.a);",
    ],
    [
      "identity",
      "function f(){ return 1; } var g = f; var a = g === f; f = function(){ return 1; }; var out = String(a) + String(g === f);",
    ],
  ])("reads %s from the home", (_label, body) => agreesWithNode(body), SLOW);

  it(
    "a sloppy function called through the home ends at the abort where `this` would be the global object",
    () => abortsAtRunTime("function f(){ return typeof this; } var h = f; f = h; var out = f();"),
    SLOW,
  );

  it.each([
    [
      "a second function declaration",
      "function f(){ return 1; } function f(){ return 2; } var g = f;",
      "function declaration 'f' read as a value has a second declaration",
    ],
    [
      "a var beside it",
      "function f(){ return 1; } var f = 2;",
      "script var f shares its binding with a function declaration",
    ],
    [
      "an Annex B block function of the same name",
      "function f(){ return 1; } var g = f; { function f(){ return 2; } }",
      "unsupported body statement FunctionDeclaration",
    ],
  ])("refuses %s by name", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // Write forms the module-binding write path does not lower refuse at the write.
  it.each([
    ["compound assignment", "function f(){ return 1; } f += '';", 'compound assign to undeclared identifier "f"'],
    ["increment", "function f(){ return 1; } f++;", 'increment/decrement of undeclared "f"'],
    ["logical assignment", "function f(){ return 1; } f ||= 0;", "unsupported body ExpressionStatement shape"],
    ["destructuring", "function f(){ return 1; } [f] = [3];", "unsupported body ExpressionStatement shape"],
  ])("refuses a %s of the name at the write", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });
});
