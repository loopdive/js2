// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0a — `==` and `!=` on the Prepared path over values of any kind (IsLooselyEqual, §7.2.14). Loose equality of a
// dynamic value refused (`dyn.eq (loose) has no Prepared intrinsic`), and two typed operands of different kinds
// (`"1" == 1`, `true == 1`) refused at the front end. Now: `undefined` and `null` equal each other and nothing else, two
// objects only as the same object, both without a conversion; otherwise the object side is converted and the primitives
// compared, two strings as strings and any other pair by ToNumber. The typed fast paths (two numbers, two strings) keep
// their lowering.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const ID = "function id(x) { return x; }\n";
const MK = 'var log = "";\nfunction mk(n, v) { return { valueOf: function () { log = log + n; return v; } }; }\n';
const flags = (expressions: readonly string[]) => expressions.map((e) => `(${e} ? "T" : "F")`).join(" + ");
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0a — loose equality over the dynamic value", () => {
  it("equates undefined and null with each other only, without a conversion", async () => {
    const cases = ["n == u", "u == n", "n == 0", "u == 0", "n == false", "u == false", 'n == ""', "n != u", "n != 0"];
    await agrees(`${ID}var o = { n: id(null) }; var u = o.missing; var n = o.n;\nvar out = ${flags(cases)};`);
    await agrees(
      `${ID}${MK}var a = mk("a", 1); var o = {};\nvar out = ${flags(["a == o.x", "a == id(null)", "id(null) == a", "a != undefined"])} + log;`,
    );
  });

  it("converts Booleans and strings by ToNumber, and compares two strings as strings", async () => {
    const cases = [
      'o.t == "1"',
      'o.f == ""',
      'o.t == "true"',
      "o.t == 1",
      "o.f == 0",
      "o.t == 2",
      "o.a == 1",
      "o.b == 1",
      "o.c == 0",
      "o.d == 0",
      "1 == o.a",
      'o.a == "01"',
      "o.c == o.c",
      'o.d != "x"',
    ];
    await agrees(`var o = { t: true, f: false, a: "1", b: " 1 ", c: "", d: "x" };\nvar out = ${flags(cases)};`);
    await agrees(`var out = ${flags(["true == 1", 'false == "0"', '"1" == 1', '"a" == 0', "true != 2"])};`);
    await agrees(
      `function t() { var b = true; var n = 1; var s = "1"; var z = ""; return ${flags(["b == n", "n == s", "s == b", "z == 0", "z != false", "b === n", "s !== n"])}; }\nvar out = t();`,
    );
  });

  it("converts the object side once, and never two objects", async () => {
    await agrees(
      `${MK}var a = mk("a", 1);\nvar out = ${flags(["a == 1", "1 == a", 'a == "1"', "a != 2", "a == true"])} + log;`,
    );
    await agrees(
      `${MK}var a = mk("a", 1); var b = mk("b", 1); var c = a;\nvar out = ${flags(["a == b", "a == c", "a != b"])} + "/" + log;`,
    );
    await agrees(
      `var o = { toString: function () { return "a"; } };\nvar out = ${flags(['o == "a"', 'o == "b"', "o == 1", '({}) == "[object Object]"'])};`,
    );
    // A conversion that answers null equals no primitive: `null == 0` is false, though ToNumber(null) is 0.
    await agrees(
      `${ID}var z = { valueOf: function () { return id(null); } };\nvar out = ${flags(["z == 0", 'z == ""', "z == false", "z != 0"])};`,
    );
  });

  it("keeps NaN unequal and the two zeros equal, and compares functions and errors as objects", async () => {
    await agrees(
      `var o = { n: NaN, z: 0, m: -0 };\nvar out = ${flags(["o.n == o.n", "o.n != o.n", "o.z == o.m", "o.m == 0"])};`,
    );
    await agrees(
      `${ID}var f = function () {}; var g = function () {}; var h = f;\nvar out = ${flags(["f == h", "f == g", "f != g", "f == id(null)", "f == undefined"])};`,
    );
    await agrees(`var e = new TypeError("m");\nvar out = ${flags(['e == "TypeError: m"', 'e != "x"', "e == e"])};`);
  });

  it("ends at the run-time abort where a function's source text would be compared", async () => {
    await abortsAtRunTime('var f = function () {}; var r = f == "x";', runnerOptions());
  });
});
