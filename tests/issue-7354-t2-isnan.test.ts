// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T, cause 3 — `isNaN(v)` on the Prepared path. It had no plan there ("direct call to "isNaN" has no
// exact AST-site plan"). The unshadowed global `isNaN` is now `Number(v)`'s conversion followed by the NaN test
// (§19.2.3): the first argument's ToNumber (ToPrimitive of an object included), extra arguments evaluated and ignored,
// no argument at all tests ToNumber(undefined). A program that declares or writes `isNaN` keeps the ordinary route.
import { describe, expect, it } from "vitest";
import { agreesWithNode, refusal } from "./helpers/prepared-node-agreement.js";

const NUMBERS = ["NaN", "0", "-0", "1 / 0", "-1 / 0", "1e21", "-1e-7"];
// Through an unannotated parameter, which the checker types `any`: TypeScript reports `isNaN(true)` as an error.
const OTHERS = [
  "true",
  "false",
  "undefined",
  "null",
  '""',
  '" 12 "',
  '"x"',
  '"0x1A"',
  '"-Infinity"',
  '"1e3"',
  '"12px"',
];
const ID = "function id(v) { return v; }\n";

describe("#7354 T — isNaN", () => {
  it("tests every primitive kind as node does, at top level and in a function", async () => {
    await agreesWithNode(
      `${ID}var out = "";\n${NUMBERS.map((v) => `out = out + isNaN(${v});`).join("\n")}\n` +
        `function f() { return "" + isNaN(NaN) + isNaN(2) + isNaN(id(undefined)); }\nout = out + f();`,
    );
  });

  it("converts booleans, undefined, null and strings by ToNumber", async () => {
    await agreesWithNode(`${ID}var out = "";\n${OTHERS.map((v) => `out = out + isNaN(id(${v}));`).join("\n")}`);
  });

  it("reads dynamic homes, before and after their initializers", async () => {
    await agreesWithNode(
      `${ID}var out = f();\nvar n = 4; var s = id("a"); var x = id(undefined);\n++x;\nfunction f() { return "" + isNaN(n) + isNaN(s); }\n` +
        `out = out + f() + isNaN(x) + isNaN(n) + (isNaN(s) ? "y" : "n");`,
    );
  });

  it("tests ToNumber(undefined) with no argument, and evaluates extra arguments in order", async () => {
    await agreesWithNode(
      `var log = "";\nfunction note(s) { log = log + s; return s; }\n` +
        `var out = "" + isNaN() + isNaN(note(1), note("b"), note("c")) + log;`,
    );
  });

  it("calls an object's valueOf once, and its throw is catchable", async () => {
    await agreesWithNode(
      `${ID}var hits = 0;\nvar o = { valueOf: function () { hits = hits + 1; return 7; } };\n` +
        `var bad = { valueOf: function () { throw "boom"; } };\nvar out = "" + isNaN(id(o)) + hits;\n` +
        `try { isNaN(id(bad)); out = out + "no"; } catch (e) { out = out + e; }`,
    );
  });

  it("does not take a program's own isNaN for the global one", async () => {
    expect(await refusal('function isNaN(v) { return "mine"; }\nvar out = isNaN(NaN) + isNaN(1);\n')).toContain(
      'direct call to "isNaN" has no exact AST-site plan in <module-init>',
    );
  });

  it("refuses a program that writes isNaN", async () => {
    expect(await refusal("isNaN = function (v) { return 1; };\nvar r = isNaN(NaN);\n")).toContain(
      'assignment to undeclared identifier "isNaN"',
    );
  });
});
