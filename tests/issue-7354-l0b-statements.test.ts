// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0b — statement shapes on the Prepared path. An EmptyStatement refused (`unsupported body statement`), a switch
// over a value the typed ladder cannot compare refused (`switch disc must lower to i32/f64`, mixed or non-literal
// tests), a call with more arguments than formals refused, and a call of a function without a result used as a value
// refused. Now: `;` completes empty; such a switch evaluates its tests lazily in source order and selects the first
// strictly equal one, `default` keeping its place; extra arguments are evaluated and dropped; the call's value is
// `undefined`.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0b — statement shapes", () => {
  it("completes an EmptyStatement empty, at top level and in a function", async () => {
    await agrees(
      'var out = "";; if (out === "") ; else out = "x"; for (var i = 0; i < 3; i++) ; while (i < 5) i++; out = out + i;',
    );
    await agrees(
      "function t(c) { ; var r = 1; var n = 0; ; if (c) ; else r = 2; while (n++ < 2) ; return String(r + n); ; }\nvar out = t(true) + t(false);",
    );
  });

  it("dispatches a switch over the dynamic value by strict equality, lazily and in source order", async () => {
    await agrees(
      'var log = "";\nfunction c(v) { log = log + v; return v; }\nfunction f(s) { switch (s) { case c("a"): log = log + "A"; break; default: log = log + "D"; break; case c("b"): log = log + "B"; } }\nf("b"); f("q"); f("a"); var out = log;',
    );
    await agrees(
      'function f(v) { switch (v) { case 1: return "num"; case "1": return "str"; case true: return "t"; case null: return "n"; case undefined: return "u"; case NaN: return "nan"; } return "x"; }\nfunction sw(v) { switch (v.k) { case 1: return "1"; } return "0"; }\nvar out = f(1) + f("1") + f(true) + f(null) + f(undefined) + f(NaN) + f(-0) + f(false) + sw({ k: 1 }) + sw({ k: "1" });',
    );
  });

  it("falls through and keeps default's place, and takes the first of duplicate tests", async () => {
    await agrees(
      'function f(v) { var r = ""; switch (v) { default: r = r + "d"; case 1: r = r + "1"; break; case "2": r = r + "2"; case "k": r = r + "k"; } return r; }\nvar out = f(1) + "|" + f("2") + "|" + f(3) + "|" + f("k");',
    );
    await agrees(
      'var a = {}; var b = {};\nfunction f(v) { switch (v) { case a: return "a1"; case a: return "a2"; case b: return "b"; } return "x"; }\nvar out = f(a) + f(b) + f({});',
    );
  });

  it("evaluates extra arguments in order and drops them, at top level and in a function", async () => {
    await agrees(
      'var log = "";\nfunction c(v) { log = log + v; return v; }\nfunction f(a) { log = log + "f" + a; return a; }\nf(c("1"), c("2"), c("3")); var out = log;',
    );
    await agrees(
      "function g(a, b) { return a * b; }\nfunction t() { var x = 1; return String(g(2, 3, x++)) + x; }\nvar out = t();",
    );
  });

  it("reads a call of a function without a result as undefined", async () => {
    await agrees(
      'var log = "";\nfunction f() { log = log + "f"; }\nfunction g() { return; }\nvar out = String(f()) + String(g() === undefined) + String(1 + f()) + log;',
    );
  });

  it("ends at the run-time abort where the callee reads the arguments an extra argument would show", async () => {
    await abortsAtRunTime(
      "function f(a) { return arguments.length; }\nfunction t() { return f(1, 2); }\nvar r = t();",
      runnerOptions(),
    );
  });
});
