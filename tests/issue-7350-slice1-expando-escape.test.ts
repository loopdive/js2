// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 slice 1 — an expando statement binds nothing, and the escape rule. In a JavaScript file the binder records
// `X.k = v;` and `Object.defineProperty(X, "k", d);` as declarations of `X`, merged into the lib symbol; the pristine
// predicate (`builtin-global-binding.ts`) no longer counts them, so `X` stays the realm's. Its writable members fold
// only where `X` never escapes as a value: every reference is a callee, a member read, a `typeof` operand or the right
// side of `instanceof`. A write of a member (any spelling, through any alias) lets `X` escape, so the member is read
// through the realm or the program refuses by name — never the folded built-in. Number's constants fold whatever `X`
// does: a write of one fails.
//
// Each program computes `out` and is checked against node, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts); a refused one is pinned by its refusal, next to a twin without the write
// whose fold still answers node's value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { builtinMembersFold, pristineBuiltinGlobal } from "../src/ir/builtin-global-binding.js";
import { ts } from "../src/frontend/typescript.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";

/** `body` at module level, and the same statements as a function's whose result is `out`. */
const positions = (body: string): readonly (readonly [string, string])[] => [
  ["at module level", body],
  ["inside a function", `function run() {\n${body}\nreturn out;\n}\nvar out = run();`],
];

/** The two answers for the `name` read by the program's last statement, `name.isNaN(1);`, after `source`. */
function facts(source: string, name: string): { pristine: boolean; fold: boolean } {
  const ast = analyzeMultiSource({ "./entry.js": `${source}\n${name}.isNaN(1);` }, "./entry.js", undefined, {
    allowJs: true,
  });
  const last = ast.entryFile.statements.at(-1) as ts.ExpressionStatement;
  const callee = (last.expression as ts.CallExpression).expression as ts.PropertyAccessExpression;
  const id = callee.expression as ts.Identifier;
  return {
    pristine: pristineBuiltinGlobal(ast.checker, ast.sourceFiles)(id),
    fold: builtinMembersFold(ast.checker, ast.sourceFiles)(id),
  };
}

describe("#7350 slice 1 — the pristine and escape facts", () => {
  const NAMES = ["eval", "Object", "Error", "String", "Number", "Boolean"];
  it.each(
    NAMES.flatMap((name) => [
      [`${name}.k = 1;`, name] as const,
      [`Object.defineProperty(${name}, "k", {value: 1});`, name] as const,
    ]),
  )("an expando statement keeps the name pristine and lets it escape: %s", (source, name) => {
    expect(facts(source, name)).toEqual({ pristine: true, fold: false });
  });

  it.each([
    ["nothing", ""],
    ["a callee, a construction, typeof, instanceof", "Number(1); new Number(1); typeof Number; 1 instanceof Number;"],
    ["a member read and a method call", "var m = Number.MAX_VALUE; (Number).isFinite(2);"],
    ["a write of a member of a member", "Number.prototype.k = 1;"],
    [
      "a member name and a label of the same spelling",
      "var o = {Number: 1}; o.Number = 2; Number: for (;;) break Number;",
    ],
  ])("keeps the members foldable: %s", (_label, source) => {
    expect(facts(source, "Number")).toEqual({ pristine: true, fold: true });
  });

  it.each([
    ["an alias", "var N = Number; N.isNaN = 1;"],
    ["a parameter", "function w(x) { x.isNaN = 1; } w(Number);"],
    ["an element write", 'Number["isNaN"] = 1;'],
    ["a compound write", "Number.isNaN += 1;"],
    ["++", "Number.isNaN++;"],
    ["delete", "delete Number.isNaN;"],
    ["a destructuring target", "[Number.isNaN] = [1];"],
    ["an object destructuring target", "({a: Number.isNaN} = {a: 1});"],
    ["a for-in target", "for (Number.isNaN in {a: 1});"],
    ["__defineGetter__", 'Number.__defineGetter__("isNaN", function () {});'],
    ["__defineSetter__", 'Number.__defineSetter__("isNaN", function () {});'],
    ["a shorthand property", "var o = {Number};"],
    ["a comparison", "var same = Number === Number;"],
  ])("lets the name escape: %s", (_label, source) => {
    expect(facts(source, "Number")).toEqual({ pristine: true, fold: false });
  });

  it.each([
    ["a declaration", "function Number() {}"],
    ["an assignment", "Number = 1;"],
  ])("is no pristine global: %s", (_label, source) => {
    expect(facts(source, "Number")).toEqual({ pristine: false, fold: false });
  });
});

const PROGRAMS: readonly (readonly [string, string])[] = [
  // test262 language/types/number/S8.5_A9.js: NaN is a constant, so the write fails and the read still folds.
  [
    "S8.5_A9: Number.NaN = 1 leaves NaN",
    "Number.NaN = 1;\nvar out = String(Number.NaN !== Number.NaN) + String(Number.NaN === 1);",
  ],
  [
    "Number's constants still fold beside writes of them",
    `Number.MAX_VALUE = 1; Number.POSITIVE_INFINITY = 2; var N = Number; N.NEGATIVE_INFINITY = 3;
var out = String(Number.MAX_VALUE) + "|" + String(Number.POSITIVE_INFINITY) + "|" + String(N.NEGATIVE_INFINITY);`,
  ],
  [
    "Error: expando statements and an alias write, read back",
    `Error.k = 1; Object.defineProperty(Error, "j", {value: 2}); var E = Error; E.m = 3;
var out = String(Error.k) + String(Error.j) + String(Error.m) + new Error("x").message + typeof Error;`,
  ],
  [
    "the folds of writable members without an escape",
    `var o = {}; Object.defineProperty(o, "a", {value: 4});
var out = String(Number.isNaN(NaN)) + String(Number.isNaN(1)) + String(Number.isFinite(1)) + String(o.a)
  + String(Math.abs(-2)) + String(Number(3));`,
  ],
];

describe("#7350 slice 1 — an expando program agrees with node", () => {
  for (const [name, body] of PROGRAMS)
    it.each(positions(body))(
      `${name} (%s)`,
      (_where, program) => agreesWithNode(program + CALLS, true, runnerOptions(), freshRealmOut),
      SLOW,
    );
});

// A writable member of an escaping name never folds: until B3b-1 holds the wrapper rows' members the read refuses by
// name; `Object`, `eval` and `Math` are no values on this path, so their member writes refuse first.
const NOT_REACHABLE = (key: string) => `${key} is not reachable on this path yet (#7350 B3bc)`;
const ISNAN = NOT_REACHABLE("Number.isNaN");
const F = "function () { return 7; }";
describe("#7350 slice 1 — an escaping name's writable member does not fold", () => {
  it.each([
    ["Number.isNaN = f", `Number.isNaN = ${F};`, ISNAN],
    ["an alias write", `var N = Number; N.isNaN = ${F};`, ISNAN],
    ["a write through a parameter", `function w(x) { x.isNaN = ${F}; } w(Number);`, ISNAN],
    ['Number["isNaN"] = f', `Number["isNaN"] = ${F};`, ISNAN],
    ["defineProperty", `Object.defineProperty(Number, "isNaN", {value: ${F}});`, ISNAN],
    ["++", "Number.isNaN++;", ISNAN],
    ["__defineGetter__", `Number.__defineGetter__("isNaN", ${F});`, NOT_REACHABLE("Number.__defineGetter__")],
    ["a destructuring target", `[Number.isNaN] = [${F}];`, "unsupported body ExpressionStatement shape"],
    ["a for-in target", "for (Number.isNaN in {a: 1});", "for-in head is not an identifier"],
  ])("Number.isNaN(1) after %s refuses", async (_label, write, expected) => {
    expect(await refusal(`${write}\nvar out = Number.isNaN(1);${CALLS}`, runnerOptions())).toContain(expected);
  });

  it.each([
    ["String.k = v", "String.k = 1; var out = String(5);", NOT_REACHABLE("String.k")],
    ["defineProperty(String, …)", 'Object.defineProperty(String, "k", {value: 1});', NOT_REACHABLE("String.k")],
    ["an alias write of Object", "var O = Object; O.k = 1;", 'identifier "Object" is not in scope'],
    ["an alias write of eval", "var e = eval; e.k = 1;", 'identifier "eval" is not in scope'],
    ["Boolean.k = v", "Boolean.k = 1; var out = Boolean(0);", NOT_REACHABLE("Boolean.k")],
    ["defineProperty(Boolean, …)", 'Object.defineProperty(Boolean, "k", {value: 1});', NOT_REACHABLE("Boolean.k")],
    ["Boolean.prototype = v", "Boolean.prototype = 1;", NOT_REACHABLE("Boolean.prototype")],
    ["Object.keys = f", `Object.keys = ${F}; var out = Object.keys({});`, 'identifier "Object" is not in scope'],
    [
      "Object.defineProperty = f",
      `Object.defineProperty = ${F}; var out = Object.defineProperty({}, "a", {});`,
      'identifier "Object" is not in scope',
    ],
    [
      "defineProperty(Object, …)",
      'Object.defineProperty(Object, "k", {value: 1});',
      'identifier "Object" is not in scope',
    ],
    ["eval.k = v", 'eval.k = 1; var out = eval("1");', 'identifier "eval" is not in scope'],
    ["defineProperty(eval, …)", 'Object.defineProperty(eval, "k", {value: 1});', 'identifier "eval" is not in scope'],
    ["Math.abs = f", `Math.abs = ${F}; var out = Math.abs(-1);`, 'identifier "Math" is not in scope'],
  ])("%s refuses by name", async (_label, source, expected) => {
    expect(await refusal(source + CALLS, runnerOptions())).toContain(expected);
  });

  // A write through an alias reaches the identity row at run time: the uncatchable abort, as in B3a.
  it.each([
    ["String", "var S = String; S.k = 1; var out = String(5);"],
    ["Boolean", "var B = Boolean; B.k = 1; var out = Boolean(0);"],
  ])("an alias write of %s aborts", (_label, source) => abortsAtRunTime(source + CALLS, runnerOptions()), SLOW);

  // The write sits in a function nothing calls, which becomes its abort body: the module's own call still does not
  // fold, so the program refuses rather than answer with the native static.
  it(
    "a write in an uncalled function stops the fold elsewhere",
    async () => {
      const source = `function patch() { Object.defineProperty = function (o) { return o; }; }
var o = {}; var out = Object.defineProperty(o, "a", {value: 1}) === o;${CALLS}`;
      const result = await compile(source, runnerOptions());
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message)).toContainEqual(
        expect.stringContaining('identifier "Object" is not in scope in <module-init>'),
      );
    },
    SLOW,
  );
});
