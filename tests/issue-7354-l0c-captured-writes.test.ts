// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0c — writes through a closure on the Prepared path. A closure that writes a variable of its enclosing
// function refused the program (`nondefaultable reference widening needs a separately authenticated physical
// post-state`): the native ref cells were issued, but the presentation did not count their types among the realm's
// authenticated slots. A captured variable holding the dynamic value refused (`mutable closure capture must be a
// primitive`), and `log += v` / `n++` on a script `var` inside a function aborted (`undeclared`). Now each is
// JavaScript's value: the cell is shared by the function and every closure that captures it.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0c — closures and functions that write outer bindings", () => {
  it("shares a captured number between the function and its closures", async () => {
    await agrees(
      "function t() { var x = 1; var f = function () { x = x + 10; }; f(); var g = function () { x++; x *= 2; }; g();\n" +
        '  var inc = function () { x++; }; var get = function () { return x; }; inc(); return String(get()) + "," + x; }\nvar out = t();',
    );
  });

  it("keeps a counter alive in a returned closure, one per call of its maker", async () => {
    await agrees(
      "function counter() { var c = 0; return function () { c = c + 1; return c; }; }\n" +
        'var k = counter(); k(); var j = counter();\nvar out = String(k()) + "," + j() + "," + k();',
    );
  });

  it("writes through a closure nested in a closure, and a captured string", async () => {
    await agrees(
      "function t() { var x = 0; var f = function () { var g = function () { x += 5; }; g(); g(); }; f();\n" +
        '  var s = "a"; var h = function (v) { s += v; }; h("b"); h(1); return x + s; }\nvar out = t();',
    );
  });

  it("writes a parameter from a nested closure, whatever is stored", async () => {
    await agrees(
      'var f = function (a) { var k = function () { a = 5; }; k(); return a; };\nfunction g(a) { var k = function () { a = a + 1; }; k(); k(); return a; }\nvar out = String(f(1)) + "," + g(1) + "," + g("x");',
    );
  });

  it("writes a script var from a function with += and ++", async () => {
    await agrees(
      'var log = ""; var n = 0;\nfunction c(v) { log += v; n++; return v; }\nc("a"); c("b"); n += 10;\nvar out = log + n;',
    );
  });

  // A closure created in a block or a loop body writes the function's binding: a `var` or parameter has one cell per
  // activation, a loop body's `let` one per iteration.
  it("writes the function's var and parameter from closures created in loops and branches", async () => {
    await agrees(
      "function a() { var sum = 1; for (var i = 0; i < 4; i++) { var f = function () { sum = sum * 2; }; f(); } return sum; }\n" +
        "function b(c) { var s = 1; if (c) { var f = function () { s = s + 5; }; f(); } return s; }\n" +
        "function w() { var s = 1, i = 0; while (i < 3) { var f = function () { s += 2; }; f(); i++; }\n" +
        "  do { var g = function () { s = s * 3; }; g(); i--; } while (i > 1); return s; }\n" +
        "function x() { for (var i = 0; i < 3; i++) { var y; var f = function () { y = (y || 0) + 1; }; f(); } return y; }\n" +
        "function p(q) { for (var i = 0; i < 3; i++) { var f = function () { q = q + 1; }; f(); } return q; }\n" +
        'var out = a() + "," + b(true) + b(false) + "," + w() + "," + x() + "," + p(10);',
    );
  });

  it("writes from closures in try, switch and recursion, and a loop body's let per iteration", async () => {
    await agrees(
      "function tr() { var s = 1; try { var f = function () { s++; }; f(); throw 0; }\n" +
        "  catch (e) { var g = function () { s += 10; }; g(); } finally { var h = function () { s *= 2; }; h(); } return s; }\n" +
        "function sw(k) { var s = 0; switch (k) { case 1: var f = function () { s = 7; }; f(); break; default: s = 1; } return s; }\n" +
        "function rec(n) { var s = n; if (n > 0) { var f = function () { s = s + rec(n - 1); }; f(); } return s; }\n" +
        'function lt() { var r = ""; for (var i = 0; i < 3; i++) { let x = i; if (true) { var f = function () { x = x * 10; }; f(); } r += x; } return r; }\n' +
        'var out = tr() + "," + sw(1) + sw(2) + "," + rec(3) + "," + lt();',
    );
  });

  it("reads a var written after the closure is created, and one declared after it", async () => {
    await agrees(
      "function g() { var x = 1; var f = function () { return x; }; x = 2; return f(); }\n" +
        "function h() { var k = function () { return y; }; var y = 1; return k(); }\nvar out = String(g()) + h();",
    );
  });

  it("ends at the run-time abort where a closure writes a loop head's let", async () => {
    await abortsAtRunTime(
      'function t() { var r = ""; for (let i = 0; i < 3; i++) { var f = function () { i++; }; f(); r += i; } return r; }\nvar out = t();',
      runnerOptions(),
    );
  });
});
