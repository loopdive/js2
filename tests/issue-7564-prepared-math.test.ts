// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7564 — `Math.*` calls on the Prepared path. The members the backend emits in place (abs, floor, ceil, sqrt, trunc,
// fround, max, min, clz32, imul) compile and agree with node, -0 and NaN included; their arguments are evaluated, then
// converted in order (ToNumber), as node does. The self-hosted members (pow, `**`, exp, log, the trigonometric ones,
// round, …), Math.random, other arities, the constants and `Math` as a value stay refused: the self-hosted bodies differ
// from node's results, and the rest has no Prepared lowering yet.
//
// Each program computes `out` and is checked against node, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts), under the test262 runner's options.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;

/** Appends a number to `out`, telling -0 from +0 and naming NaN. */
const ADD = `var out = "";
function add(v) { var s = "" + v; if (v !== v) s = "NaN"; else if (v === 0) { if (1 / v > 0) s = "+0"; else s = "-0"; } out = out + s + ","; }`;

const UNARY = ["abs", "floor", "ceil", "sqrt", "trunc", "fround", "clz32"];
const UNARY_INPUTS =
  "0|-0|1|-1|0.5|-0.5|1.5|-1.5|-2.5|0.49999999999999994|4503599627370495.5|1e300|-1e-300|1/0|-1/0|0/0|2147483648|-4294967295|3.7";
const BINARY = ["max", "min", "imul"];
const BINARY_INPUTS = "0,-0|-0,0|-0,-0|1,0/0|0/0,1|1,2|-1,-2|1/0,-1/0|4294967295,5|2147483648,2|3.7,-2.2";
/** For each input row, its values assigned to `vars`, then one `add` per member called on them. */
const calls = (members: readonly string[], inputs: string, vars: readonly string[]) =>
  inputs
    .split("|")
    .map((row) => {
      const values = row.split(",");
      const assigned = vars.map((name, index) => `${name} = ${values[index]};`).join(" ");
      return `${assigned} ${members.map((m) => `add(Math.${m}(${vars.join(", ")}));`).join(" ")}`;
    })
    .join("\n");

const PROGRAMS: readonly (readonly [string, string])[] = [
  ["unary members on edge inputs", `${ADD}\nvar x;\n${calls(UNARY, UNARY_INPUTS, ["x"])}`],
  ["binary members on edge inputs", `${ADD}\nvar a, b;\n${calls(BINARY, BINARY_INPUTS, ["a", "b"])}`],
  [
    "non-number arguments convert",
    `${ADD}
var u;
add(Math.abs(null)); add(Math.abs("-2")); add(Math.abs("")); add(Math.abs(" 7 ")); add(Math.abs("x")); add(Math.abs(true));
add(Math.abs(u)); add(Math.floor("-0")); add(Math.ceil("-0.5")); add(Math.max("3", 2)); add(Math.min(null, -0));
add(Math.max(u, 1)); add(Math.max({ valueOf: function () { return 9; } }, 1));
add(Math.trunc({ toString: function () { return "-3.5"; } })); add(Math.imul("3", true)); add(Math.clz32(null));`,
  ],
  [
    "every argument is evaluated before any is converted",
    `var out = "";
var a = { valueOf: function () { out = out + "a"; return 1; } };
var b = { valueOf: function () { out = out + "b"; return 2; } };
function ea() { out = out + "A"; return a; }
function eb() { out = out + "B"; return b; }
out = out + Math.max(ea(), eb()) + Math.min(eb(), ea());`,
  ],
  [
    "a function's untyped parameters convert",
    `function f(a, b) { return Math.max(a, b); }
var r = f(-0, 0);
var out = "" + 1 / r + "," + f("3", null) + "," + f({ valueOf: function () { return 9; } }, 1) + "," + f(true, 0 / 0);`,
  ],
  [
    "a throwing conversion stops the call",
    `var out = "";
var bad = { valueOf: function () { throw 7; } };
var seen = { valueOf: function () { out = out + "s"; return 1; } };
try { Math.max(bad, seen); } catch (e) { out = out + "caught" + e; }`,
  ],
];

describe("#7564 — Math calls on the Prepared path agree with node", () => {
  for (const [title, source] of PROGRAMS)
    it(title, { timeout: SLOW }, async () => agreesWithNode(source, true, runnerOptions()));
});

describe("#7564 — Math members without a node-exact Prepared lowering refuse", () => {
  it.each([
    ["Math.pow (self-hosted, differs from node)", "var r = Math.pow(2, 10);"],
    ["** (the same math.pow intrinsic)", "var a = 2; var r = a ** 10;"],
    ["Math.exp", "var r = Math.exp(1);"],
    ["Math.round", "var r = Math.round(1.5);"],
    ["Math.random", "var r = Math.random();"],
    ["Math.max with three arguments", "var r = Math.max(1, 2, 3);"],
    ["Math.max without arguments", "var r = Math.max();"],
    ["a constant", "var r = Math.PI;"],
    ["Math as a value", "var m = Math; var r = m.abs(-1);"],
  ])("%s", { timeout: SLOW }, async (_name, source) => {
    await refusal(source, runnerOptions());
  });
});
