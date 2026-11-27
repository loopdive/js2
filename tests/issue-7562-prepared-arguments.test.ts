// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7562 — `arguments.length` through the strict Prepared entry, as an original-harness script compiles it. A function
// that reads its own `arguments.length` takes the count the dispatcher installed or a direct call published; each
// accepted program runs twice against node: its answer returns, a wrong one throws. A use the path does not build
// ends at the run-time abort or refuses, never at a wrong value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;

describe("#7562 — arguments.length", () => {
  it.each([
    [
      "through a value and as a method: fewer, equal and more arguments than formals, 0 and 20",
      "function f(a, b) { return arguments.length; } var g = f; var o = { m: f };" +
        " var out = g() + ',' + g(1) + ',' + g(1, 2) + ',' + g(1, 2, 3) + ',' + o.m(1, 2, 3, 4, 5) + ','" +
        " + g(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20);",
    ],
    [
      "direct calls with fewer and equal arguments, strict and sloppy",
      "function f(a, b) { return arguments.length; } function s(a, b) { 'use strict'; return arguments.length; }" +
        " var keep = f; var out = '' + f() + f(1) + f(1, 2) + s(1) + s(1, 2);",
    ],
    [
      // The dispatcher enters `h` with its count (2) and one extra installed; `h`'s direct call must replace both.
      "a direct call from a function the dispatcher entered with more arguments",
      "function f(a) { return arguments.length; } function h(x, y) { return f(9); } var hv = h;" +
        " var out = '' + hv(1, 2, 3) + hv();",
    ],
    [
      "recursion, and a count read after the call returned",
      "function r(n, m) { if (n === 0) return arguments.length; return r(n - 1); }" +
        " function c(a) { var n = arguments.length; return function () { return n; }; } var g = r, k = c;" +
        " var out = '' + g(3, 5, 6) + r(0, 1) + k(1, 2)() + c()();",
    ],
    [
      "`arguments` shadowed by a parameter and by a catch binding, and dead code naming it",
      "function p(arguments) { return arguments; } function d(a) { if (false) { arguments.length; } return 1; }" +
        " function c(a) { var n; try { throw { length: 9 }; } catch (arguments) { n = arguments.length; }" +
        " return n + ',' + arguments.length; } var g = p, e = d, h = c;" +
        " var out = String(p(4)) + g(4, 5) + (d(4) + e(5, 6)) + h(1, 2);",
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);

  it.each([
    [
      "a nested function expression's own arguments",
      "function f(a) { return (function () { return arguments.length; })(1, 2, 3); } var g = f; f(1);",
    ],
    ["an arrow's inherited arguments", "function f(a) { return (() => arguments.length)(); } var g = f; g(1, 2);"],
    ["typeof arguments", "function f(a) { return typeof arguments; } var g = f; g(1);"],
    ["an indexed read", "function f(a, b) { return arguments[0]; } var g = f; g(1, 2);"],
    // A `var arguments` starts as the arguments object (§10.2.11 step 27), which is not a block-local `undefined`.
    [
      "a `var arguments` without initializer",
      "function f(a) { var arguments; return arguments.length; } var g = f; g(1);",
    ],
    ["a `var arguments` read before it", "function f() { return arguments.length; var arguments; } var g = f; g(1);"],
    [
      "a `var arguments` then assigned",
      "function f(a) { var arguments; arguments = 5; return arguments; } var g = f; g();",
    ],
    [
      "a `var arguments` with initializer in a block, read after it",
      "function f(a) { if (a) { var arguments = 4; } return arguments.length; } var g = f; g(1, 2);",
    ],
    [
      "a for-head `var arguments`",
      "function f(a) { for (var arguments in { x: 1 }) {} return arguments; } var g = f; g(1);",
    ],
    [
      "a function expression's `var arguments`",
      "var g = function (a) { var arguments; return arguments.length; }; g(1, 2);",
    ],
  ])("%s ends at the run-time abort", (_label, source) => abortsAtRunTime(source, runnerOptions()), SLOW);

  it.each([
    [
      "a direct call with more arguments than formals",
      "function f(a) { return arguments.length; } var g = f; f(1, 2);",
    ],
    [
      // Without a source closure the program has no dispatcher state to publish the count into.
      "a reader in a program without a function value",
      "function f(a, b) { return arguments.length; } f(1, 2);",
    ],
    ["a getter's arguments", "var o = { get x() { return arguments.length; } }; o.x;"],
  ])(
    "%s refuses",
    async (_label, source) => {
      expect(await refusal(source, runnerOptions())).not.toBe("");
    },
    SLOW,
  );
});
