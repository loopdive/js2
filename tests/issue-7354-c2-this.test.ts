// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 C2 — `this` in plain functions through the strict Prepared entry, and the harness's `Test262Error`
// (test262/harness/sta.js, verbatim). A function that reads its own `this` binds the receiver the dispatcher
// installed, once at entry (C2-D2); sloppy code with a primitive receiver ends at the run-time abort (C2-D3); a call
// that installs no receiver refuses. Each accepted program runs twice against node: its answer returns, a wrong one
// throws.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runPrepared } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const STA = readFileSync(new URL("../test262/harness/sta.js", import.meta.url), "utf8");

describe("#7354 C2 — this", () => {
  it.each([
    [
      "a method call's receiver: an object, the object itself",
      "var o = {k: 1}; o.m = function(){ return this.k; }; o.self = function(){ return this; };" +
        " var out = String(o.m()) + (o.self() === o ? 'y' : 'n');",
    ],
    [
      // A separate program: a function returning its `this` is a route to the global object, which no declaration's
      // binding survives (`bindingHoldsItsDeclaration`).
      "a function object's method call",
      "function a(){} a.k = 2; a.m = function(){ return this.k; }; var out = String(a.m());",
    ],
    [
      "strict code without a receiver: undefined, called through a var, a local, a parameter and a method's callee",
      "'use strict'; var g = function(){ return this; }; function h(f){ return f(); }" +
        " function w(){ var f = function(){ return this; }; return f(); } var o = {}; o.m = function(){ return g(); };" +
        " var out = (g() === undefined ? 'y' : 'n') + (h(g) === undefined ? 'y' : 'n') + (w() === undefined ? 'y' : 'n') + (o.m() === undefined ? 'y' : 'n');",
    ],
    [
      "a nested call does not change the caller's `this`; a nested function has its own",
      "var p = {k: 2}; p.n = function(){ return this.k; }; var o = {k: 1};" +
        " o.m = function(){ var x = p.n(); var f = function(){ 'use strict'; return this; }; return String(this.k + x) + (f() === undefined ? 'y' : 'n'); };" +
        " var out = o.m();",
    ],
    [
      "a declaration entered through its value as a method",
      "function F(){ return this.k; } var o = {k: 6}; o.m = F; var out = String(o.m());",
    ],
    [
      "OrdinaryToPrimitive calls toString with the object as `this`",
      "function T(m){ this.m = m; } T.prototype.toString = function(){ return 'T:' + this.m; };" +
        " function s(v){ return '' + v; } var out = s(new T(1));",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);

  it.each([
    ["sloppy code without a receiver, through a var", "var g = function(){ return this; }; g();"],
    [
      "sloppy code without a receiver, through a parameter",
      "function h(f){ return f(); } h(function(){ return this; });",
    ],
    [
      "sloppy code without a receiver, through a local",
      "function w(){ var f = function(){ return this; }; return f(); } w();",
    ],
    [
      "a write to `this` that is a caught error",
      "function F(){ this.k = 1; } function c(v){ try { v.x; } catch (e) { return e; } } var e = c(null); e.m = F; e.m();",
    ],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source), SLOW);

  it.each([
    [
      "a direct call of a declaration that reads `this`",
      "function F(){ return this; } F();",
      "a direct call of F installs no receiver for its 'this'",
    ],
    ["`this` at top level", "var x = this;", "'this' reference outside an instance method body (<module-init>)"],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});

describe("#7354 C2 — Test262Error (sta.js verbatim)", () => {
  it(
    "constructs, reads `message`, is an instance, names its constructor, converts to its text, and throws from thrower",
    () =>
      agreesWithNode(
        `${STA}\nfunction s(v){ return '' + v; } var e = new Test262Error('m'); var out = e.message + new Test262Error().message;` +
          " out = out + (e instanceof Test262Error ? 'i' : 'n') + (e.constructor === Test262Error ? 'c' : 'n') + s(e) + String(e);" +
          " try { Test262Error.thrower('x'); } catch (t) { out = out + (t instanceof Test262Error ? 'i' : 'n') + t.message; }",
      ),
    SLOW,
  );

  it(
    "ends the program with an uncaught Test262Error, as node does",
    async () => {
      const source = `${STA}\nthrow new Test262Error('boom');`;
      expect(() => new Function(source)()).toThrow();
      expect(await runPrepared(source)).toBe("threw");
    },
    SLOW,
  );

  it("refuses a call without new: it installs no receiver", async () => {
    expect(await refusal(`${STA}\nvar e = Test262Error('m');`)).toContain(
      "a direct call of Test262Error installs no receiver for its 'this'",
    );
  });
});
