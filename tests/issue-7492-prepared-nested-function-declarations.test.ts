// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7492 — on the Prepared path an unannotated function declaration nested in a function body is a closure, made
// before the first statement that names it (src/ir/hoisted-closures.ts); a statement list ends at a `return`; any
// non-tail statement is a body statement; and a tail that completes normally falls out into the implicit return.
// Each program gives node's answer (and a wrong answer throws); each shape left out aborts by name, never a wrong value.
import { describe, expect, it } from "vitest";
import { abortBodies, agreesWithNode } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

describe("#7492 — nested function declarations: node's answer", () => {
  it.each([
    ["called after its declaration", "function g(){ function f(){ return 2; } return f(); } var out = String(g());"],
    [
      "called above its declaration",
      "function g(){ return f(1); function f(a){ return a + 1; } } var out = String(g());",
    ],
    [
      "captures a var initialised above its first use",
      "function g(){ var k = 1; function f(a){ return a + k; } return f(1); } var out = String(g());",
    ],
    [
      "captures a parameter of any type",
      "function g(x){ function f(){ return x; } return f(); } var out = String(g(7)) + String(g('s'));",
    ],
    [
      "recursion through its own name",
      "function g(){ function f(n){ return n <= 1 ? 1 : n * f(n - 1); } return f(5); } var out = String(g());",
    ],
    [
      "stored and called through a var",
      "function g(){ function f(a){ return a + 1; } var h = f; return h(1); } var out = String(g());",
    ],
    [
      "a later duplicate wins",
      "function g(){ function f(){ return 1; } function f(){ return 2; } return f(); } var out = String(g());",
    ],
    [
      "nested two deep",
      "function g(){ function h(){ function i(){ return 3; } return i(); } return h(); } var out = String(g());",
    ],
    ["inside an IIFE", "var out = String((function(){ function f(){ return 2; } return f(); })());"],
    ["a call result the checker calls void", "function g(){ function f(){} return f(); } var out = String(g());"],
    ["never named", "var c = 0; function g(){ c = c + 1; function f(){} } g(); var out = String(c);"],
    [
      "one capturing another, never called: still compiles",
      "function g(){ function b(){ return 6; } function a(){ return b() + 1; } return a(); } var out = 'x';",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7492 — statement shapes before and at a function tail: node's answer", () => {
  it.each([
    ["a var as the tail", "var c = 0; function g(){ c = 1; var x = 2; } g(); var out = String(c);"],
    ["a block before the tail", "function g(){ var r = 1; { r = r + 1; } return r; } var out = String(g());"],
    ["a return before more statements", "function g(){ var x = 1; return x; var y = 2; } var out = String(g());"],
    ["empty statements", "function g(){ var a = 1;; return a; ; } function h(){ ; } h(); var out = String(g());"],
    [
      "a labelled loop as the tail",
      "var n = 0; function g(){ l: for (var i = 0; i < 3; i++) { n = n + 1; } } g(); var out = String(n);",
    ],
    [
      "the implicit return of a dynamic result",
      "function g(c){ if (c) return 1; var x = 2; } var out = String(g(0)) + String(g(1));",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7492 — shapes left out abort by name", () => {
  it.each([
    [
      "a captured var declared after the first use",
      "function g(){ var y = f(); function f(){ return z; } var z = 3; return y; } g();",
      "declared after the closure is created",
    ],
    [
      "sibling mutual recursion",
      "function g(){ return even(4); function even(n){ return n === 0 ? true : odd(n - 1); } function odd(n){ return n === 0 ? false : even(n - 1); } } g();",
      'direct call to "odd" has no exact AST-site plan',
    ],
    [
      "one capturing another",
      "function g(){ function b(){ return 6; } function a(){ return b() + 1; } return a(); } g();",
      'nested function a captures the closure "b"',
    ],
    [
      "one returning another, both named in one statement",
      "function g(){ var r = a()(); function a(){ return b; } function b(){ return 6; } return r; } g();",
      'identifier "b" is not in scope',
    ],
    [
      "a rewritten declaration",
      "function g(){ function f(){ return 1; } f = 2; return f; } g();",
      "nested func must have a return type annotation",
    ],
  ])(
    "%s",
    async (_label, source, detail) => {
      const rows = await abortBodies(source);
      expect(rows.some((row) => row.startsWith("g: ") && row.includes(detail))).toBe(true);
    },
    SLOW,
  );
});
