// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 (Fa's cases, moved here) — a function expression stored in a script var, compared, and thrown.
import { describe } from "vitest";
import { runsFunctionExpressions } from "./helpers/function-expression-cases.js";

describe("#7354 F1 — function expressions as values (identity)", () => {
  runsFunctionExpressions([
    [
      "writing a script var on each call",
      "var n = 0; var f = function () { n = n + 1; return n; }; f();",
      "f() !== 2 || n !== 2",
      "f() !== 3",
    ],
    [
      "of the function kind: ToBoolean true, strict equality by reference",
      "var f = function () {}; var g = function () {};",
      "!f || f !== f || f === g || g === f",
      "f !== g",
    ],
    [
      "thrown and caught",
      "var f = function () {}; var c; try { throw f; } catch (e) { c = e; }",
      "c !== f || !c",
      "c === f",
    ],
    [
      "kept by identity through the dynamic home, a copy, a call result and ToBoolean",
      "var f = function (a) { return a; }; var g = f; function h() { return f; }",
      "g !== f || h() !== f || f(f) !== f || !f",
      "g === f",
    ],
  ]);
});
