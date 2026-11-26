// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 (Fa's cases, moved here) — a function expression's parameters: written, updated, and a function value
// passed as an argument.
import { describe } from "vitest";
import { runsFunctionExpressions } from "./helpers/function-expression-cases.js";

describe("#7354 F1 — function expressions as values (parameters)", () => {
  runsFunctionExpressions([
    // A written parameter reads through a slot seeded from the argument, as a declaration's does.
    [
      "assigning its parameter (the harness's `if (message === undefined) message = …`)",
      "var f = function (a) { if (a === undefined) a = 3; return a; };",
      "f(undefined) !== 3 || f(5) !== 5",
      "f(undefined) !== undefined",
    ],
    [
      "updating its parameters with `++`, `--`, `-=` and `+=`",
      "var f = function (a, b) { a++; b--; b -= 2; b += 1; return a - b; };",
      "f(1, 1) !== 3",
      "f(1, 1) !== 4",
    ],
    [
      "passed to an untyped parameter",
      "function t(fn) { return fn; } var k = function (x) { return x; };",
      "t(k) !== k || t(function (y) { return y; }) === k",
      "t(k) === k",
    ],
  ]);
});
