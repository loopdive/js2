// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0c — function declarations inside functions on the Prepared path. They aborted the function
// (`nested func must have a return type annotation`, `nested func params must be Identifier-named with annotations`):
// the ordinary pipeline lifts an annotated declaration for direct calls only. On the Prepared lane each is hoisted
// (§10.2.11 step 36): its name is a cell of the dynamic value bound at function entry, the declarations are created as
// function values in source order, and the `var`s they capture are hoisted with them, so a call before the
// declaration, recursion, mutual recursion and redeclaration behave as in JavaScript.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0c — function declarations inside functions", () => {
  it("calls a declaration before and after it, with its parameters and captures", async () => {
    await agrees(
      'function t(p) { var r = g(2); function g(a) { return a * 3 + p; } var s = g(1); return r + "," + s; }\n' +
        'function u() { var a = k(); var x = 3; function k() { return x; } return String(a) + k(); }\nvar out = t(1) + "|" + u();',
    );
  });

  it("recurses, mutually too, and returns a declaration as a value", async () => {
    await agrees(
      "function t(n) { function fact(k) { return k <= 1 ? 1 : k * fact(k - 1); }\n" +
        "  function even(k) { return k === 0 ? true : odd(k - 1); } function odd(k) { return k === 0 ? false : even(k - 1); }\n" +
        '  return fact(n) + "," + even(n) + "," + odd(n); }\nfunction mk() { function g(a) { return a + "!"; } return g; }\n' +
        'var out = t(5) + "|" + t(4) + "|" + mk()("x") + mk().name + mk().length;',
    );
  });

  it("lets a later declaration, a var and an assignment rebind the name", async () => {
    await agrees(
      "function t() { function g() { return 1; } function g() { return 2; } var a = g();\n" +
        "  var b = typeof h; var h = 123; function h() {} g = function () { return 3; }; return a + typeof h + h + b + g(); }\nvar out = t();",
    );
  });

  it("writes the enclosing function's variables from the declaration", async () => {
    await agrees(
      'function t() { var n = 0; var s = "p"; function add(k) { n += k; s = s + k; } add(2); add(3); return n + s; }\nvar out = t();',
    );
  });

  it("ends at the run-time abort where a declaration shares a parameter's name", async () => {
    await abortsAtRunTime(
      "function t(g) { function g() { return 2; } return typeof g; }\nvar r = t(1);",
      runnerOptions(),
    );
  });
});
