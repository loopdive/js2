// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T, cause 2 — a call whose callee is no Reference on the Prepared path: an IIFE, `function(){}()`,
// `f()()`, `(0, o.m)()`, `(c ? o.m : g)()`, `(a || o.m)()`, `(o.m = g)()`. Such a callee was refused ("only direct
// calls supported"); it is now F2's call through a value with `this` undefined (§13.3.6.1). A parenthesized member
// access is still a Reference whose receiver is `this`; it keeps its refusal.
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal } from "./helpers/prepared-node-agreement.js";

describe("#7354 T — a call through a callee that is no Reference", () => {
  it("calls every non-Reference callee form at top level", async () => {
    await agreesWithNode(
      `function w() { return function (a) { return a + 1; }; }\nfunction g() { return 10; }\nvar c = true;\n` +
        `var a = w()(3); var b = (0, g)(); var d = (c ? g : w)(); var e = (false || g)();\n` +
        `var out = "" + (function () { return 1; })() + function () { return 2; }() + a + b + d + e +` +
        ` (function named(a, b) { return a * b; })(3, 4);`,
    );
  });

  it("pads missing arguments, evaluates extra ones, callee first", async () => {
    await agreesWithNode(
      `var log = "";\nfunction note(s) { log = log + s; return s; }\n` +
        `var t = (note("c"), function (a, b) { return typeof b; })(note("a"));\n` +
        `var u = (function (a) { return a; })(note("x"), note("y"));\nvar out = t + u + log;`,
    );
  });

  it("gives `this` undefined in strict code, also through a comma, conditional, `||` or assignment", async () => {
    await agreesWithNode(
      `var o = { m: function () { "use strict"; return this === undefined ? "u" : "o"; } };\nvar g = o.m;\n` +
        `var out = (function () { "use strict"; return typeof this; })() + o.m() + (0, o.m)() + (true ? o.m : g)() +` +
        ` (false || o.m)() + (o.m = g)();`,
    );
  });

  it("keeps sloppy `this` (the global object) from reading as undefined: the abort", async () => {
    await abortsAtRunTime("var r = (function () { return this === undefined; })();\nif (r) throw 1;");
    await abortsAtRunTime('var r = (function () { return typeof this; })();\nif (r !== "object") throw 1;');
  });

  it("throws a catchable error for a callee that is not callable", async () => {
    await agreesWithNode(
      // A program without a function value refuses every such call by name (F2); this one calls `f`.
      `var out = "";\nvar n = 5;\nvar f = function () {};\nf();\ntry { (0, n)(); out = "no"; } catch (e) { out = "caught"; }\n` +
        `var u;\ntry { (0, u)(); } catch (e) { out = out + " again"; }`,
    );
  });

  it("uses a checker-typed result as the dynamic value it is", async () => {
    await agreesWithNode(
      `var a = (function () { return 1; })() + 1;\nvar s = "a" + (function () { return 1; })();\n` +
        `var m = -(function () { return 1; })() * 3;\nvar b = (function () { return true; })() ? 1 : 2;\n` +
        `var t = typeof (function () { return 1; })();\nvar e = (function () { return 1; })() === 1;\n` +
        `var v = (function () { return 1; })();\nv = v * 2;\nv += 1;\n` +
        `if ((function () { return 0; })()) throw 1;\nvar out = "" + a + s + m + b + t + e + v;`,
    );
  });

  it("calls in a function, in loop conditions and in statement position", async () => {
    await agreesWithNode(
      `var hits = 0;\nfunction h() { return (function () { return 1; })() + (function (x) { return x; })(2); }\n` +
        `do { var reached = 1; break; } while (function f() { return 0; }());\n` +
        `while (function () { return hits < 3; }()) { hits = hits + 1; }\n` +
        `(function () { hits = hits + 10; })();\nvar out = "" + h() + reached + hits;`,
    );
  });

  it("refuses a parenthesized member callee, which keeps its receiver", async () => {
    for (const call of ["(o.m)()", '(o["m"])()'])
      expect(await refusal(`var o = { m: function () { return 1; } };\nvar r = ${call};\n`)).toContain(
        "only direct calls supported in Phase 2 (<module-init>)",
      );
  });
});
