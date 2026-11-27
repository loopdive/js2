// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0c part 2 — function declarations in blocks and `var`s reached outside the statement declaring them, on the
// Prepared path. A block, case block or try/catch/finally block binds its functions at entry (a fresh cell of the
// block); in sloppy function code an Annex B one also has a var binding of the function, `undefined` from function
// entry and assigned the block's function when the declaration is evaluated (B.3.3.1); an `if` arm's function is a
// block of its own (B.3.4). A function body binds a `var` that code reaches outside its statement, or before it, at
// entry. Strict code, a catch parameter shadowing the var binding and a block `let` of a hoisted name keep aborting.
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0c — Annex B block functions", () => {
  it("reads a block function's var binding before and after its block, and in an if arm", async () => {
    await agrees(
      "function t(){ var a = typeof f; { function f(){ return 'in'; } } return a + ',' + f(); }\n" +
        "function u(c){ var a = String(f); if (c) { function f(){ return 1; } } return a + ',' + typeof f; }\n" +
        "function w(c){ if (c) function f(){ return 'a'; } else function f(){ return 'b'; } return f(); }\n" +
        "var out = t() + '|' + u(true) + '|' + u(false) + '|' + w(true) + w(false);",
    );
  });

  it("keeps the block binding apart from the var binding", async () => {
    await agrees(
      "var iv, cv, vb; (function(){ { function f(){ iv = f; f = 123; cv = f; return 'decl'; } } vb = f; f(); }());\n" +
        "var out = iv() + ',' + cv + ',' + vb();",
    );
  });

  it("binds a case block's functions before the dispatch, for every clause", async () => {
    await agrees(
      "function t(){ var a = typeof f; switch (1) { case 1: function f(){ return 123; } } return a + typeof f + f(); }\n" +
        "function u(x){ switch (x) { case 1: return typeof f; case 2: function f(){} return 'two:' + typeof f; }\n" +
        "  return 'none' + typeof f; }\nvar out = t() + '|' + u(1) + u(2) + u(3);",
    );
  });

  it("skips the var binding where a let, a parameter or strict code takes the name", async () => {
    await agrees(
      "function t(){ let f = 123; { function f(){ return 1; } } return typeof f; }\n" +
        "function u(f){ { function f(){ return 1; } } return typeof f; }\n" +
        "function w(){ 'use strict'; { function f(){ return 2; } } return 1; }\nvar out = t() + u(5) + w();",
    );
  });

  it("updates an existing var or function, repeats a block function and declares one per loop turn", async () => {
    await agrees(
      "function t(){ var f = 123; var a = f; if (true) { function f(){ return 'x'; } } return a + typeof f + f(); }\n" +
        "function u(){ function f(){ return 1; } var a = f(); { function f(){ return 2; } } return a + ',' + f(); }\n" +
        "function w(){ { function f(){ return 1; } function f(){ return 2; } } return f(); }\n" +
        "function v(){ var s = ''; for (var i = 0; i < 3; i++) { function g(){ return i; } s += g(); } return s + typeof g; }\n" +
        "var out = t() + '|' + u() + '|' + w() + '|' + v();",
    );
  });

  it.each([
    [
      "a catch parameter shadowing the var binding",
      "function t(){ var a = typeof f; try { throw null; } catch (f) { { function f(){ return 1; } } } return a + typeof f; }\nvar r = t();",
    ],
    [
      "a strict block function read outside its block",
      "function t(){ 'use strict'; var r = typeof f; { function f(){ return 1; } r += typeof f; } return r + typeof f; }\nvar r = t();",
    ],
    [
      "a block function reading a block let of a hoisted name",
      "function t(){ var x = 'o'; { function g(){ return x; } let x = 'i'; return g(); } }\nvar r = t();",
    ],
  ])("ends at the run-time abort for %s, never a wrong value", async (_label, source) => {
    await abortsAtRunTime(source, runnerOptions());
  });
});

describe("#7354 L0c — vars reached outside their statement", () => {
  it("reads a var after its case, loop, if or try block, and before its declaration", async () => {
    await agrees(
      "function a(x){ switch (x) { case 1: var r = 'one'; break; default: r = 'other'; } return r; }\n" +
        "function b(){ try { var v = 1; throw 2; } catch (e) { v += e; } return v; }\n" +
        "function c(k){ if (k) { var v = 'y'; } return String(v); }\n" +
        "function d(){ var r = String(z); { var z = 5; } return r + z; }\n" +
        "function e(){ for (var i = 0; i < 3; i++) {} l: { var x = 1; if (x) break l; x = 5; } return i + x; }\n" +
        "var out = a(1) + a(2) + b() + c(true) + c(false) + d() + e();",
    );
  });

  it("lowers a block before the tail", async () => {
    await agrees("function t(){ var x = 1; { x = 2; } { ; } { var y = x + 1; } return x + ',' + y; }\nvar out = t();");
  });

  it("ends at the run-time abort where a block let shadows a hoisted var", async () => {
    await abortsAtRunTime(
      "function t(){ for (var i = 0; i < 2; i++) {} { let i = 'b'; } return i; }\nvar r = t();",
      runnerOptions(),
    );
  });
});

// (#7554 review r1) A function the lowering never creates (it sits in a dead arm, after a `continue`, in a
// non-matching case) leaves its var binding `undefined`; a cell whose only capturing closure is dead code has no
// closure root, which the program refuses by name instead of throwing.
describe("#7354 L0c — block functions in dead code", () => {
  it("reads the var binding of a function the lowering never creates", async () => {
    await agrees(
      "function a(){ if (false) { function f(){} } return typeof f; }\n" +
        "function b(){ if (false) { function f(){} return 1; } else { return typeof f; } }\n" +
        "function c(){ for (var i = 0; i < 2; i++) { continue; function f(){} } return typeof f; }\n" +
        "function d(){ switch (2) { case 1: function f(){} } return typeof f; }\n" +
        "function e(){ if (true) function f(){ return 3; } return f(); }\n" +
        "var out = a() + b() + c() + d() + e();",
    );
  });

  it("refuses a cell whose capturing closure is dead code", async () => {
    expect(
      await refusal(
        "function t(){ if (false) { function g(){ return x; } } var x = 1; return x; }\nvar r = t();",
        runnerOptions(),
      ),
    ).toContain("a mutable capture cell needs a closure root, and the program creates no closure");
  });
});
