// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0a — `<`, `>`, `<=`, `>=` on the Prepared path over values of any kind (IsLessThan, §7.2.13). Two dynamic values
// refused (`__ir_dyn_lt has no Prepared intrinsic`), two typed strings needed a string compare the lane did not bind,
// and two typed operands of different kinds (`true > 0`, `"10" < 9`) refused at the front end. Now: ToPrimitive (hint
// number) of the left operand, then the right, for every operator; two strings compare by UTF-16 code units; any other
// pair by ToNumber, NaN on either side answering false.
import { describe, it } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const OPS = ["<", ">", "<=", ">="];
const ID = "function id(x) { return x; }\n";
const MK = 'var log = "";\nfunction mk(n, v) { return { valueOf: function () { log = log + n; return v; } }; }\n';
const flags = (expressions: readonly string[]) => expressions.map((e) => `(${e} ? "T" : "F")`).join(" + ");
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0a — relational operators over the dynamic value", () => {
  it("converts the left operand first for every operator, at top level and in a function", async () => {
    const pairs = OPS.map((op) => `log = log + "|"; r = mk("a", 1) ${op} mk("b", 2); out = out + (r ? "T" : "F");`);
    await agrees(`${MK}var r; var out = "";\n${pairs.join("\n")}\nout = out + log;`);
    const inFunction = OPS.map((op) => `(mk("x", 2) ${op} mk("y", 1) ? "T" : "F")`).join(" + ");
    await agrees(`${MK}function t() { return ${inFunction}; }\nvar out = t() + log;`);
  });

  it("answers false for NaN on either side, `<=` and `>=` included", async () => {
    const cases = OPS.flatMap((op) => [`n ${op} 1`, `1 ${op} n`, `n ${op} n`, `u ${op} 0`]);
    await agrees(`var o = {}; var n = o.missing * 1; var u = o.missing;\nvar out = ${flags(cases)};`);
  });

  it("orders strings by UTF-16 code units, typed and dynamic", async () => {
    const cases = [
      "a < b",
      "a > b",
      "a <= b",
      "b >= a",
      "c < d",
      "d < c",
      '"" < c',
      "c <= c",
      "c >= c",
      "c > c",
      '"ab" < "abc"',
      '"abc" < "ab"',
    ];
    const strings = 'var a = "\\uD800\\uDC00"; var b = "\\uFFFF"; var c = "a"; var d = "B";';
    await agrees(`${strings}\nvar out = ${flags(cases)};`);
    await agrees(`function t() { ${strings} return ${flags(cases)}; }\nvar out = t();`);
    await agrees(
      `var o = { x: "a" }; var s = o.x + "bc"; var t = "ab" + o.x;\nvar out = ${flags(["s < t", "t <= s", "s >= s"])};`,
    );
  });

  it("compares any other pair by ToNumber", async () => {
    const values = '{ abc: "abc", e: "", sp: " 12 ", n: id(null), u: undefined, t: true, f: false }';
    const cases = [
      "o.abc < 1",
      "o.abc >= 1",
      "o.e < 1",
      "o.e >= 0",
      "o.sp > 11",
      "o.sp < 13",
      "o.n >= 0",
      "o.n <= 0",
      "o.u < 1",
      "o.u >= 1",
      "o.t > 0",
      "o.t < 2",
      "o.f <= 0",
      '"10" < 9',
      '"10" < "9"',
      "true > 0",
    ];
    await agrees(`${ID}var o = ${values};\nvar out = ${flags(cases)};`);
    await agrees(
      `function t() { var b = true; var n = 1; var s = "1"; return ${flags(["b > 0", "s < 2", "n <= s", "b >= s"])}; }\nvar out = t();`,
    );
  });

  it("takes a conversion method's string as a string, and its throw or a TypeError is catchable", async () => {
    await agrees(
      `var o = { valueOf: function () { return "b"; } }; var p = { toString: function () { return "a"; } };\n` +
        `var out = ${flags(['o < "c"', 'o > "a"', 'p < "b"', "p < o", "o > p", "({}) < 1", "({}) < '[object Pbject]'"])};`,
    );
    await agrees(
      'var out = "";\nvar bad = { valueOf: function () { throw "boom"; } };\n' +
        "try { var r = bad < 1; out = out + r; } catch (e) { out = out + e; }\n" +
        "var both = { valueOf: function () { return {}; }, toString: function () { return {}; } };\n" +
        'try { var q = 1 > both; out = out + q; } catch (e) { out = out + (e instanceof TypeError ? "TE" : "?"); }',
    );
  });

  // A Boolean data property of a function-local object is read as the dynamic value: its native unbox needed a
  // keyed-Get proof this read has none of, and refused the whole program even where the function never ran.
  it("compares Boolean properties of a function-local object, and an uncalled such function leaves the program", async () => {
    const body = "var o = { t: true, f: false, n: 1 };\n  return ";
    const uses = ["o.t == o.n", "o.t == 1", "o.t != 2", "o.t > o.f", "o.f >= 0", "o.t === true", "o.t"];
    await agrees(`function t() { ${body}${flags(uses)}; }\nvar out = t();`);
    await agrees(`function t() { ${body}${flags(uses)}; }\nvar out = "ok";`);
  });

  it("compares two object locals of a function through their conversions", async () => {
    await agrees(
      'function t() { var a = { valueOf: function () { return 1; } }; var b = { toString: function () { return "2"; } };\n' +
        `return ${flags(["a < b", "b <= a", "a == 1", "b == a"])}; }\nvar out = t();`,
    );
  });

  it("converts an Error through its own toString", async () => {
    await agrees(
      `var e = new RangeError("z");\nvar out = ${flags(['e < "S"', 'e > "Q"', "e < 1", 'e >= "RangeError: z"'])};`,
    );
  });

  it("ends at the run-time abort where a function's source text would be compared", async () => {
    await abortsAtRunTime('var f = function () {}; var r = f < "g";', runnerOptions());
  });
});
