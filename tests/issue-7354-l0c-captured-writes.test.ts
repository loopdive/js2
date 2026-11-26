// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0c — writes through a closure on the Prepared path. A closure that writes a variable of its enclosing
// function refused the program (`nondefaultable reference widening needs a separately authenticated physical
// post-state`): the native ref cells were issued, but the presentation did not count their types among the realm's
// authenticated slots. A captured variable holding the dynamic value refused (`mutable closure capture must be a
// primitive`), and `log += v` / `n++` on a script `var` inside a function aborted (`undeclared`). Now each is
// JavaScript's value: the cell is shared by the function and every closure that captures it.
import { describe, it } from "vitest";
import { agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

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
});
