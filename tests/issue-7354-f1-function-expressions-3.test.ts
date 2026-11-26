// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 — function expressions created inside functions and loops: a new closure per evaluation, returned as a
// function value (Fa's cases and the plan's group A).
import { describe } from "vitest";
import { runsFunctionExpressions } from "./helpers/function-expression-cases.js";

describe("#7354 F1 — function expressions as values (creation)", () => {
  runsFunctionExpressions([
    [
      "returned from a function and from a loop, a new closure each time",
      "function mk() { var g = function () {}; return g; } var a = mk(); var b = mk(); var fs0, fs1;" +
        " for (var i = 0; i < 2; i++) { var fn = function () {}; if (i === 0) fs0 = fn; else fs1 = fn; }",
      "a === b || !a || fs0 === fs1 || !fs1",
      "a !== b",
    ],
    [
      "in a function's local: assigning its parameter, and as an object literal's member",
      "function g() { var f = function (a) { a = 2; return a; }; return f(1); }" +
        " function h() { var o = { a: 1, m: function (v) { return v; } }; return o.a; }",
      "g() !== 2 || h() !== 1",
      "g() !== 1",
    ],
  ]);
});
