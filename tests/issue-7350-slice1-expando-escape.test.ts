// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 slice 1 — an expando statement binds nothing, and the escape rule. In a JavaScript file the binder records
// `X.k = v;` and `Object.defineProperty(X, "k", d);` as declarations of `X`, merged into the lib symbol; the pristine
// predicate (`builtin-global-binding.ts`) no longer counts them, so `X` stays the realm's. A writable member `X.k`
// folds only where `X` never escapes as a value (every reference is a callee, a member read, a `typeof` operand or the
// right side of `instanceof`) and no code writes the key `k` on any object (review RV-PR7549: a route that names no
// `X`, such as `(1).constructor` or `this` in an inherited method, still writes through a spelled key). A write of the
// member (any spelling, through any alias) stops the fold, so the member is read through the realm or the program
// refuses by name — never the folded built-in. Number's constants fold whatever `X` does: a write of one fails.
//
// Each program computes `out` and is checked against node, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts); a refused one is pinned by its refusal, next to a twin without the write
// whose fold still answers node's value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { foldsBuiltinMember, pristineBuiltinGlobal } from "../src/ir/builtin-global-binding.js";
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

/** The two answers for the `name` read by the program's last statement, `name.member(1);`, after `source`. */
function facts(source: string, name: string, member = "isNaN"): { pristine: boolean; fold: boolean } {
  const ast = analyzeMultiSource({ "./entry.js": `${source}\n${name}.${member}(1);` }, "./entry.js", undefined, {
    allowJs: true,
  });
  const last = ast.entryFile.statements.at(-1) as ts.ExpressionStatement;
  const callee = (last.expression as ts.CallExpression).expression as ts.PropertyAccessExpression;
  const id = callee.expression as ts.Identifier;
  return {
    pristine: pristineBuiltinGlobal(ast.checker, ast.sourceFiles)(id),
    fold: foldsBuiltinMember(ast.checker, ast.sourceFiles)(id),
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

// Review RV-PR7549: routes to a realm name that never spell it, each against a twin that writes another key or only
// reads. `F` is any function value.
describe("#7350 slice 1 — a write of the key stops the fold, whatever reaches the name", () => {
  const W = "function () { this.isNaN = 1; }";
  it.each([
    ["a: X.prototype.constructor", "Number.prototype.constructor.isNaN = 1;", "Number", "isNaN"],
    ["a: a held prototype's constructor", "var P = Number.prototype; P.constructor.isNaN = 1;", "Number", "isNaN"],
    ["b: a number's constructor", "(1).constructor.isNaN = 1;", "Number", "isNaN"],
    ["b: an object's constructor", "({}).constructor.keys = 1;", "Object", "keys"],
    ["b: a string's constructor", "''.constructor.fromCharCode = 1;", "String", "fromCharCode"],
    ["b: a boolean's constructor", "true.constructor.k = 1;", "Boolean", "k"],
    ["b: an error's constructor", "new Error().constructor.k = 1;", "Error", "k"],
    ["b: getPrototypeOf(1).constructor", "Object.getPrototypeOf(1).constructor.isNaN = 1;", "Number", "isNaN"],
    ["c: this of a Function.prototype method", `Function.prototype.m = ${W}; Number.m();`, "Number", "isNaN"],
    [
      "c: this of an Object.prototype getter",
      `Object.defineProperty(Object.prototype, "g", {get: ${W}}); Number.g;`,
      "Number",
      "isNaN",
    ],
    [
      "c: this of an Object.prototype method on Math",
      "Object.prototype.m = function () { this.abs = 1; }; Math.m();",
      "Math",
      "abs",
    ],
    ["d: an export", "export { Number };", "Number", "isNaN"],
    ["a computed key", 'var k = "isNaN"; (1).constructor[k] = 1;', "Number", "isNaN"],
    ["a with statement", "with ((1).constructor) isNaN = 1;", "Number", "isNaN"],
    ["Reflect", 'Reflect.set((1).constructor, "isNaN", 1);', "Number", "isNaN"],
    [
      "a held defineProperty",
      'var d = Object.defineProperty; d((1).constructor, "isNaN", {value: 1});',
      "Number",
      "isNaN",
    ],
    [
      "defineProperty by a computed key",
      'var k = "isNaN"; Object.defineProperty((1).constructor, k, {});',
      "Number",
      "isNaN",
    ],
    ["assign", "Object.assign((1).constructor, {isNaN: 1});", "Number", "isNaN"],
    ["assign of a held source", "var s = {isNaN: 1}; Object.assign((1).constructor, s);", "Number", "isNaN"],
    ["defineProperties", "Object.defineProperties((1).constructor, {isNaN: {value: 1}});", "Number", "isNaN"],
    [
      "__defineGetter__ through .call",
      'Object.prototype.__defineGetter__.call((1).constructor, "isNaN", function () {});',
      "Number",
      "isNaN",
    ],
    ["a fresh name assigned", "var o = {}; o = (1).constructor; o.isNaN = 1;", "Number", "isNaN"],
    [
      "a fresh name rebound through the global object",
      'var o = {}; Object.defineProperty(this, "o", {value: (1).constructor}); o.isNaN = 1;',
      "Number",
      "isNaN",
    ],
    ["a computed key on this", 'var o = {}; var k = "o"; this[k] = (1).constructor; o.isNaN = 1;', "Number", "isNaN"],
    ["a parameter receiver", "function f(o) { o.isNaN = 1; } f((1).constructor);", "Number", "isNaN"],
    ["a fresh name and a binding of it that is not", "var o = {}; function g(o) { o.isNaN = 1; }", "Number", "isNaN"],
    // Round 2: a key writer reached without spelling its name, through a reader of an operand's values.
    [
      "values of the descriptors of a realm object",
      'Object.values(Object.getOwnPropertyDescriptors(Object))[4].value((1).constructor, "isNaN", {value: 1});',
      "Number",
      "isNaN",
    ],
    [
      "a descriptor read by a computed key",
      'var k = "define" + "Property"; Object.getOwnPropertyDescriptor(Object, k).value((1).constructor, "isNaN", {});',
      "Number",
      "isNaN",
    ],
    [
      "a held descriptor reader",
      'var g = Object.getOwnPropertyDescriptor; var k = "define" + "Property"; g(Object, k).value((1).constructor, "isNaN", {});',
      "Number",
      "isNaN",
    ],
    // An `Object.create(…)` result is fresh only while `create` folds.
    [
      "a created receiver while create is written",
      "Object.create = function () { return (1).constructor; }; var n = Object.create(null); n.isNaN = 1;",
      "Number",
      "isNaN",
    ],
    [
      "a created receiver while create is written by a route that names no Object",
      "({}).constructor.create = function () { return (1).constructor; }; var n = Object.create(null); n.isNaN = 1;",
      "Number",
      "isNaN",
    ],
    [
      "a created receiver while Object escapes",
      "function f(o) {} f(Object); var n = Object.create(null); n.isNaN = 1;",
      "Number",
      "isNaN",
    ],
    [
      "a created receiver while Object is declared",
      "var Object = {create: function () { return (1).constructor; }}; var n = Object.create(null); n.isNaN = 1;",
      "Number",
      "isNaN",
    ],
    ["a parameter given a created value", "function h(p) { p.isNaN = 1; } h(Object.create(null));", "Number", "isNaN"],
  ])("%s stops the fold", (_label, source, name, member) => {
    expect(facts(source, name, member)).toEqual({ pristine: true, fold: false });
  });

  it.each([
    ["a: a read of X.prototype.constructor's member", "var v = Number.prototype.constructor.isNaN;", "Number", "isNaN"],
    ["b: another key through a constructor", "(1).constructor.k = 1; ({}).constructor.j = 1;", "Number", "isNaN"],
    [
      "c: a method that only reads this",
      "Function.prototype.m = function () { return this.isNaN; }; Number.m();",
      "Number",
      "isNaN",
    ],
    ["d: an export of another name", "var x = 1; export { x };", "Number", "isNaN"],
    [
      "a literal key of another name",
      '(1).constructor["k"] = 1; Object.defineProperty({}, "a", {value: 1});',
      "Number",
      "isNaN",
    ],
    [
      "assign of other literal keys",
      "Object.assign({}, {a: 1}); Object.defineProperties({}, {b: {value: 1}});",
      "Number",
      "isNaN",
    ],
    [
      "writes of any key on fresh objects",
      'var k = "isNaN"; var o = {}; var a = []; o[k] = 1; a[k] = 1; Object.defineProperty(o, k, {}); Object.assign(o, a); o.o = 1;',
      "Number",
      "isNaN",
    ],
    // Round 2's twins: readers of fresh operands or by a literal key, names, created values.
    [
      "readers of fresh operands and an iterator",
      'var o = {a: 1}; Object.getOwnPropertyDescriptor(o, "a"); Object.getOwnPropertyDescriptors({}); Object.values(o); Object.entries([1]); [1].values();',
      "Number",
      "isNaN",
    ],
    [
      "descriptor reads by a literal key",
      'Object.getOwnPropertyDescriptor((1).constructor, "MAX_VALUE"); Object.getOwnPropertyDescriptor((1).constructor, `isNaN`); Object.getOwnPropertyDescriptor(Math);',
      "Number",
      "isNaN",
    ],
    [
      "own names only",
      "var n = Object.getOwnPropertyNames(Object).length + Object.keys(Object).length;",
      "Number",
      "isNaN",
    ],
    ["a write on a created value", "var n = Object.create(null); n.isNaN = 1; n.create = 2;", "Number", "isNaN"],
    [
      "a created map",
      "var n = Object.create(null); Object.defineProperties(n, n); Object.assign(Object.create({}), n);",
      "Number",
      "isNaN",
    ],
  ])("%s keeps the fold", (_label, source, name, member) => {
    expect(facts(source, name, member)).toEqual({ pristine: true, fold: true });
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
