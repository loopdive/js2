// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 A1 (#7352) — what arrays on the Prepared path do not do yet ends at a refusal by name or the run-time abort,
// never at a wrong answer: a spread element; a `length` value whose ToNumber needs the program (a string, an object);
// an Array.prototype method (A1b), read or called, and so an array's ToPrimitive (`join`); a computed key the realm
// cannot classify (a string it does not hold, `"__proto__"`, an object key, a primitive receiver). Beside them, what does
// answer agrees with node and a wrong answer throws.
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;

describe("#7354 A1 — array limits", () => {
  it("refuses a spread element by name", async () => {
    expect(await refusal("var b = [1]; var a = [0, ...b];", runnerOptions())).toContain(
      "array literal with a spread element",
    );
  });

  it.each([
    ["a string length value", "var a = [1, 2, 3]; a.length = '1';"],
    ["an object length value", "var a = [1, 2, 3]; a.length = { valueOf: function () { return 1; } };"],
    ["an Array.prototype method read", "var a = [1]; var m = a.map;"],
    ["an array's ToPrimitive", "var a = [1, 2]; var s = '' + a;"],
    ["a computed key on a primitive", "function f(v, k) { return v[k]; } f('abc', 1);"],
    ["a computed number key on a string", "function f(v) { return v[0]; } f('abc');"],
    ["a computed string key the realm does not hold", "var o = {}; var k = 'q'; var v = o[k];"],
    ["a computed write of __proto__", "var o = {}; var k = '__proto__'; o[k] = 1;"],
    ["an object key", "var a = [1]; var k = {}; var v = a[k];"],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source, runnerOptions()), SLOW);

  it.each([
    ["an object's ToPrimitive beside an array", "var a = [1]; var o = {}; var out = '' + o + a.length;"],
    ["a computed read through parameters", "function f(o, k) { return o[k]; } var out = String(f({ a: 1 }, 'a'));"],
    [
      "a computed write through parameters",
      "function f(o, k) { o[k] = 2; return o.a; } var out = String(f({ a: 1 }, 'a'));",
    ],
  ])("answers %s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);
});
