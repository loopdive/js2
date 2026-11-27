// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 A1 (#7352) — what arrays on the Prepared path do not do yet ends at a refusal by name or the run-time abort,
// never at a wrong answer: a spread element; a `length` value whose ToNumber needs the program (a string, an object);
// an Array.prototype method (A1b), read or called, and so an array's ToPrimitive (`join`); a computed key the realm
// cannot classify (a string it does not hold, `"__proto__"`, an object key, a primitive receiver). Beside them, what does
// answer agrees with node and a wrong answer throws.
import { describe, expect, it } from "vitest";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
const OP_TO_STRING = "Object.prototype.toString = function () { return 'z'; };";
const OP_VALUE_OF = "Object.prototype.valueOf = function () { return 7; };";

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
    // An array's ToPrimitive aborts before it reads `toString` / `valueOf`, whatever Object.prototype holds: node
    // answers through Array.prototype's own `toString` ("1,2"), never Object.prototype's.
    ["String() under a written Object.prototype.toString", `${OP_TO_STRING} var a = [1, 2]; var out = String(a);`],
    [
      "a function-local String() under a written Object.prototype.toString",
      `${OP_TO_STRING} function f() { var a = [1, 2]; return String(a); } var out = f();`,
    ],
    ["concatenation under a written Object.prototype.toString", `${OP_TO_STRING} var a = [1, 2]; var out = a + "";`],
    ["a computed key under a written Object.prototype.toString", `${OP_TO_STRING} var o = { z: 1 }; var v = o[[1]];`],
    ["unary + under a written Object.prototype.valueOf", `${OP_VALUE_OF} var out = +[1];`],
    ["Number() under a written Object.prototype.valueOf", `${OP_VALUE_OF} var a = [1]; var out = Number(a);`],
    ["a relational under a written Object.prototype.valueOf", `${OP_VALUE_OF} var a = [1]; var out = a < 8 ? 1 : 2;`],
    ["isNaN under a written Object.prototype.valueOf", `${OP_VALUE_OF} var a = [1]; var out = isNaN(a);`],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source, runnerOptions()), SLOW);

  // A function-local array is the same dynamic value as a script-level one: for-of needs the iteration protocol, so
  // the function aborts at run time, and compile() never throws.
  it.each([
    ["var", "function f() { var a = [1, 2]; var n = 0; for (var x of a) n = n + 1; return n; } f();"],
    ["const", "function f() { var a = [1, 2]; var n = 0; for (const x of a) n = n + 1; return n; } f();"],
    ["let", "function f() { var a = [1, 2]; var n = 0; for (let x of a) n++; return n; } f();"],
    ["over a literal", "function f() { var n = 0; for (var v of [1, 2, 3]) n = n + 1; return n; } f();"],
    ["with a sum", "function f() { var a = [1, 2]; var s = 0; for (var v of a) s = s + v; return s; } f();"],
  ])(
    "ends for-of %s over a function-local array at the run-time abort",
    (_label, source) => abortsAtRunTime(source, runnerOptions()),
    SLOW,
  );

  // A function-local object is a raw externref, and the Prepared program has no host iterator protocol to take it.
  it("refuses for-of over a function-local object by name", async () => {
    const source = "function f() { var o = { a: 1 }; var n = 0; for (var x of o) n = n + 1; return n; } f();";
    expect(await refusal(source, runnerOptions())).toContain("for-of iterable type externref");
  });

  it.each([
    ["typeof", "function f() { var a = [1, 2]; return typeof a; } var out = f();"],
    ["===", "function f() { var a = [1, 2]; var b = a; return (a === b) + ':' + (a === null); } var out = f();"],
    ["! and ?:", "function f() { var a = [1, 2]; return !a ? 'n' : 'y'; } var out = f();"],
    [
      "a closure capture",
      "function f() { var a = [1, 2]; var g = function () { return a.length; }; return g(); } var out = String(f());",
    ],
    [
      "Array.isArray and instanceof",
      "function f() { var a = [1]; return Array.isArray(a) + ':' + (a instanceof Array); } var out = f();",
    ],
    [
      "an index write past the end",
      "function f() { var a = [1, 2]; a[5] = 7; return a.length + ':' + a[1]; } var out = f();",
    ],
  ])("answers %s of a function-local array", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);

  // node in a fresh realm: the program writes Object.prototype.
  it(
    "answers an object's ToPrimitive under a written Object.prototype.toString",
    () =>
      agreesWithNode(
        `${OP_TO_STRING} var a = [1]; var o = {}; var out = String(o) + a.length;`,
        true,
        runnerOptions(),
        freshRealmOut,
      ),
    SLOW,
  );

  it.each([
    ["an object's ToPrimitive beside an array", "var a = [1]; var o = {}; var out = '' + o + a.length;"],
    ["a computed read through parameters", "function f(o, k) { return o[k]; } var out = String(f({ a: 1 }, 'a'));"],
    [
      "a computed write through parameters",
      "function f(o, k) { o[k] = 2; return o.a; } var out = String(f({ a: 1 }, 'a'));",
    ],
  ])("answers %s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);
});
