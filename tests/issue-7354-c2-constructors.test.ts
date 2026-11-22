// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 C2 — `new` and `instanceof` on plain functions through the strict Prepared entry
// (src/ir/program/dynamic-function-operations.ts). Each accepted program runs twice against node: its answer returns,
// a wrong one throws. Run-time aborts and refusals are asserted by their exact outcome.
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, gapText, refusal } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;

describe("#7354 C2 — new", () => {
  it.each([
    [
      "the body runs with the new object as `this`; missing and extra arguments; `new F` without parentheses",
      "function F(a, b){ this.a = a; this.b = b; } var p = new F(1), q = new F(2, 3, 4), r = new F;" +
        "var out = String(p.a) + p.b + q.a + q.b + r.a + (p === q);",
    ],
    [
      "an object result (object, function, error) replaces the new object, a primitive one does not",
      "function O(){ this.a = 1; return {a: 2}; } function P(){ this.a = 1; return 5; }" +
        " function G(){ return function(){ return 3; }; } var g = new G();" +
        " function E(v){ try { v.x; } catch (e) { return e; } }" +
        " var out = String(new O().a) + String(new P().a) + String(g()) + String(new E(null).name);",
    ],
    [
      "the prototype link: shared, live, own writes shadow; a replaced or non-object prototype",
      "function F(){} F.prototype.k = 2; var o = new F(); var out = String(o.k); F.prototype.k = 3; out = out + o.k;" +
        " o.k = 4; out = out + F.prototype.k + o.k; function G(){} G.prototype = {k: 5}; out = out + new G().k;" +
        " function H(){} H.prototype = 1; out = out + new H().k;",
    ],
    [
      "`constructor` through the prototype; nested construction",
      "function A(){ this.a = 1; } function B(){ this.x = new A(); this.b = 2; } var o = new B();" +
        " var out = (o.constructor === B ? 'y' : 'n') + (o.constructor === A ? 'y' : 'n') + String(o.x.a) + String(o.b) + String(o.a);",
    ],
    [
      "a function expression, a parameter, a loop, strict code",
      "'use strict'; var F = function (m){ this.m = m; }; function mk(C, v){ return new C(v); }" +
        " var out = ''; for (var i = 0; i < 3; i++) out = out + mk(F, i).m;",
    ],
    [
      "a non-constructor throws a TypeError, after the arguments are evaluated",
      "var c = {n: 0}; function g(){ c.n = c.n + 1; return 1; } function mk(C){ try { new C(g()); } catch (e) { return e.name; } return 'none'; }" +
        " var arrow = function(){}; var out = String(mk(1)) + String(mk({})) + String(mk(undefined)) + String(mk(null)) + String(mk('s')) + String(mk(arrow)) + String(c.n);",
    ],
    [
      "the constructor's throw propagates; an unused `new` still runs",
      "var c = {n: 0}; function F(){ c.n = c.n + 1; } function T(){ throw 7; } new F(); new F;" +
        " var out = String(c.n); try { new T(); } catch (e) { out = out + e; }",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);

  it(
    "ends at the run-time abort where the prototype is a function (the realm cannot link one)",
    // Linking to Object.prototype instead would answer `k` wrongly (undefined), so the abort is the answer here.
    () => abortsAtRunTime("function F(){} var p = function(){}; p.k = 1; F.prototype = p; var k = new F().k;"),
    SLOW,
  );

  it.each([
    [
      "a spread argument",
      "function F(){} var xs = [1]; new F(...xs);",
      "resolver cannot register vec for array literal",
    ],
    ["a member callee", "var a = {b: function(){}}; new a.b();", "only direct constructor names supported in slice 4"],
    ["a built-in constructor", "function f(){ return new TypeError('m'); } f();", 'unknown class "TypeError" in f'],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});

describe("#7354 C2 — instanceof", () => {
  it.each([
    [
      "a program without a function value: every `new` is the TypeError",
      "function mk(C){ try { new C(); } catch (e) { return e.name; } return 'none'; } var out = String(mk(1)) + String(mk('s'));",
    ],
    [
      "a primitive literal on the left of instanceof",
      "function F(){} var out = (1 instanceof F ? 'y' : 'n') + ('s' instanceof F ? 'y' : 'n');",
    ],
    [
      "every kind on the left: an instance is one, nothing else is",
      "function F(){} function t(v){ return v instanceof F ? 'y' : 'n'; } function c(v){ try { v.x; } catch (e) { return e; } }" +
        " var out = t(new F()) + t({}) + t(1) + t('s') + t(true) + t(undefined) + t(null) + t(function(){}) + t(c(null));",
    ],
    [
      "the chain: an inherited prototype, a replaced prototype",
      "function A(){} function B(){} B.prototype = new A(); var o = new B(); var p = new A(); A.prototype = {};" +
        " var out = String(o instanceof B) + (p instanceof A) + (new A() instanceof A);",
    ],
    [
      "a TypeError for a non-callable right operand, and for a non-object prototype only with an object on the left",
      "function F(){} function G(){} F.prototype = 1;" +
        " function t(v, C){ try { return v instanceof C ? 'y' : 'n'; } catch (e) { return e.name; } }" +
        " var out = String(t(1, 1)) + String(t({}, {})) + String(t(new G(), F)) + String(t(1, F));",
    ],
    [
      "the left operand is evaluated first; a condition, a negation, a loop, an unused result",
      "var s = {v: ''}; function F(){} function l(){ s.v = s.v + 'l'; return new F(); } var x = l() instanceof F;" +
        " var o = new F(); var n = 0; for (var i = 0; i < 3; i++) { if (o instanceof F) n++; if (!(o instanceof F)) n = n + 10; }" +
        " o instanceof F; var out = s.v + x + n;",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);

  it.each([
    [
      "in a program that names Symbol (@@hasInstance)",
      "function F(){} var s = typeof Symbol; var x = ({}) instanceof F;",
      gapText("instanceof in a program that names 'Symbol'"),
    ],
    [
      "a member right operand",
      "var a = {b: function(){}}; var x = ({}) instanceof a.b;",
      "instanceof RHS must be a class identifier",
    ],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});
