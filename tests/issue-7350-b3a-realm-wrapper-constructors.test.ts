// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 B3a — `String`, `Number` and `Boolean` as realm values on the Prepared path. The three constructors are the
// realm's function objects (identity, `typeof`, `name`, `length`), Number's five constants fold to their numbers, and
// `String(v)`, `Number(v)`, `Boolean(v)` convert, directly and through the realm's value. Their `prototype` and statics
// wait for B3bc: the catalog models the constructors as identity rows, so a static read of a key they lack refuses by
// name and a dynamic one aborts uncatchably, never answering `undefined` or a catchable error.
//
// Each program computes `out` and is checked against node, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts), at module level and inside a function. Every program calls a function
// expression, as the test262 harness does: on this path a function value is what makes the dispatcher exist.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareConversionResolvers } from "../src/frontend/builtins/prepare-number-conversion.js";
import { pristineBuiltinGlobal } from "../src/ir/builtin-global-binding.js";
import { ts } from "../src/frontend/typescript.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";

/** `body` at module level, and the same statements as a function's whose result is `out`. */
const positions = (body: string): readonly (readonly [string, string])[] => [
  ["at module level", body],
  ["inside a function", `function run() {\n${body}\nreturn out;\n}\nvar out = run();`],
];

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "the constructors as values: identity, stored, passed, compared, typeof",
    `var S = String, N = Number, B = Boolean; var o = {s: S}; var id = function (x) { return x; };
var out = String(S === String) + String(N === Number) + String(B !== String) + String(o.s === String)
  + String(id(Number) === Number) + String(id(B) === Boolean) + typeof S + typeof N + typeof Boolean;`,
  ],
  [
    "name and length",
    `var N = Number;
var out = String.name + String.length + Number.name + Number.length + Boolean.name + Boolean.length + N.name;`,
  ],
  [
    "Number's constants, folded and read through the value",
    `var N = Number;
var out = String(Number.MAX_VALUE) + "|" + String(Number.MIN_VALUE) + "|" + String(Number.NaN) + "|"
  + String(Number.POSITIVE_INFINITY) + "|" + String(Number.NEGATIVE_INFINITY) + "|" + String(N.MAX_VALUE === Number.MAX_VALUE)
  + String(N.NaN !== N.NaN) + String(N.NEGATIVE_INFINITY === -Infinity);`,
  ],
  [
    "String(v) of undefined, null, numbers, strings and Booleans; String()",
    `var out = String(undefined) + String(null) + String(-0) + String(1.5) + String("ab") + String(true) + String(false)
  + "[" + String() + "]";`,
  ],
  [
    "Number(v) of undefined, null, strings, Booleans and an object with valueOf; Number()",
    `var o = {valueOf: function () { return 4; }};
var out = String(Number(undefined)) + String(Number(null)) + String(Number(" 12 ")) + String(Number("abc"))
  + String(Number(true)) + String(Number(false)) + String(Number(o)) + String(Number({valueOf: function () { return 6; }}))
  + String(Number()) + String(Number("3", "4"));`,
  ],
  [
    "Boolean(v) of numbers, strings, nullish values and objects; Boolean()",
    `var x;
var out = String(Boolean(0)) + String(Boolean(-0)) + String(Boolean(NaN)) + String(Boolean(1)) + String(Boolean(""))
  + String(Boolean("a")) + String(Boolean(null)) + String(Boolean(x)) + String(Boolean({})) + String(Boolean())
  + String(Boolean(true));`,
  ],
  [
    "the conversions through the realm's value; empty calls",
    `var out = (0, String)({toString: function () { return "q"; }}) + (String)(5) + (0, Number)("7") + (Boolean)(0)
  + "[" + (String)() + "]" + (0, Number)() + (Boolean)() + (0, Boolean)("a");`,
  ],
  [
    "instanceof a wrapper constructor of a primitive is false",
    `var S = String;
var out = String(1 instanceof S) + String("a" instanceof Number) + String(true instanceof Boolean);`,
  ],
  [
    "a shadowed name is not the realm's",
    `var f = function (String) { return String(1); };\nvar out = f(function (x) { return "p" + x; });`,
  ],
  ["a declared name is not the realm's", `var Number = function (x) { return 7; };\nvar out = "n" + Number("3");`],
];

describe("#7350 B3a — String, Number and Boolean are the realm's", () => {
  for (const [name, body] of PROGRAMS)
    it.each(positions(body))(
      `${name} (%s)`,
      (_where, program) => agreesWithNode(program + CALLS, true, runnerOptions()),
      SLOW,
    );
});

describe("#7350 B3a — what the identity rows lack refuses by name or aborts", () => {
  // A static read off the pristine constructor: the receiver is the realm's read, so the missing key is known.
  it.each([
    [
      "String.prototype",
      "var p = String.prototype;",
      "String.prototype is not reachable on this path yet (#7350 B3bc)",
    ],
    [
      "Number.prototype",
      "var p = Number.prototype;",
      "Number.prototype is not reachable on this path yet (#7350 B3bc)",
    ],
    ["a static's read", "var p = Number.isNaN;", "Number.isNaN is not reachable on this path yet (#7350 B3bc)"],
    ["a static's call", "var p = String.fromCharCode(65);", "String.fromCharCode is not reachable on this path yet"],
    // (#7350 slice 1) The statement is an expando, which no longer makes `Boolean` non-pristine: the key refuses.
    ["a write of a key it lacks", "Boolean.prototype = 1;", "Boolean.prototype is not reachable on this path yet"],
    ["new String", 'var w = new String("a");', "new String (a wrapper object; #7350 B3bc)"],
    ["new Number", "var w = new Number(1);", "new Number (a wrapper object; #7350 B3bc)"],
    ["new Boolean", "var w = new Boolean(1);", "new Boolean (a wrapper object; #7350 B3bc)"],
    // An `Object` static whose target is the constructor and whose key is a constant: as visible as a member read.
    [
      "Object.getOwnPropertyDescriptor(String, 'prototype')",
      'var d = Object.getOwnPropertyDescriptor(String, "prototype");',
      "String.prototype is not reachable on this path yet (#7350 B3bc)",
    ],
    [
      "Object.defineProperty(Number, 'zz', …)",
      'var r = Object.defineProperty(Number, "zz", {value: 1});',
      "Number.zz is not reachable on this path yet (#7350 B3bc)",
    ],
    [
      "Object.defineProperties(Boolean, {length, zz})",
      "var r = Object.defineProperties(Boolean, {length: {value: 1}, zz: {value: 2}});",
      "Boolean.zz is not reachable on this path yet (#7350 B3bc)",
    ],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source + CALLS, runnerOptions())).toContain(expected);
  });

  it(
    "an Object static of a key the identity row has still answers",
    () =>
      agreesWithNode(
        `var d = Object.getOwnPropertyDescriptor(Number, "MAX_VALUE");
var out = String(d.value === Number.MAX_VALUE) + String(d.writable) + String(d.configurable);${CALLS}`,
        true,
        runnerOptions(),
      ),
    SLOW,
  );

  // A dynamic query of a key the realm lacks (through a variable) aborts, inside `try` / `catch` and inside an
  // `assert.throws`-shaped function alike: never caught, never `undefined`.
  const CHECK = `function check(f) { try { f(); } catch (e) { return "caught"; } return "none"; }\nvar S = String;\n`;
  it.each([
    ["S.prototype", "return S.prototype;"],
    ["S.hasOwnProperty('prototype')", 'return S.hasOwnProperty("prototype");'],
    ["Object.getOwnPropertyDescriptor(S, 'prototype')", 'return Object.getOwnPropertyDescriptor(S, "prototype");'],
    ["S.prototype = 1", "S.prototype = 1;"],
    ["Object.defineProperty(S, 'prototype', …)", 'Object.defineProperty(S, "prototype", {value: 1});'],
    ["({}) instanceof S", "return ({}) instanceof S;"],
    ["a static of Number through a variable", "var N = Number; return N.isNaN;"],
  ])(
    "aborts %s",
    async (_label, statement) => {
      await abortsAtRunTime(`${CHECK}var out = check(function () { ${statement} });${CALLS}`, runnerOptions());
      await abortsAtRunTime(
        `${CHECK}var out; try { (function () { ${statement} })(); } catch (e) { out = e; }${CALLS}`,
        runnerOptions(),
      );
    },
    SLOW,
  );

  // A call through a variable reaches the dispatcher, whose built-in arm is the run-time abort (as G1).
  it(
    "aborts a call and a construct through a variable",
    async () => {
      await abortsAtRunTime(
        `var B = Boolean; var out; try { out = B(1); } catch (e) { out = e; }${CALLS}`,
        runnerOptions(),
      );
      await abortsAtRunTime(
        `var S = String; var out; try { out = new S("a"); } catch (e) { out = e; }${CALLS}`,
        runnerOptions(),
      );
    },
    SLOW,
  );
});

describe("#7350 B3a — a folded constant holds nothing", () => {
  const hash = async (source: string) => {
    const result = await compile(source, runnerOptions());
    expect(result.success).toBe(true);
    return createHash("sha256").update(result.binary).digest("hex");
  };
  // `x` is read, so the #3418 dead-binding elision (#7354 F0) keeps the declaration whatever its initializer is.
  const READ = "\nfunction f() { return x; }\nvar k = function () { return f(); };\nif (k() !== x) throw 1;";
  it.each([
    ["Number.MAX_VALUE", "1.7976931348623157e308"],
    ["Number.MIN_VALUE", "5e-324"],
    ["Number.NaN", "NaN"],
    ["Number.POSITIVE_INFINITY", "Infinity"],
    ["Number.NEGATIVE_INFINITY", "-Infinity"],
  ])("var x = %s has the bytes of var x = %s", async (constant, literal) => {
    expect(await hash(`var x = ${constant};${READ}`)).toBe(await hash(`var x = ${literal};${READ}`));
  });
});

/** Whether the Prepared conversion plan admits the `name(…)` call inside the source's function `run`. */
function admitsCall(source: string, name: "String" | "Number" | "Boolean"): boolean {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const run = ast.entryFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "run",
  )!;
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) call ??= node;
    ts.forEachChild(node, visit);
  };
  visit(run);
  const pristine = pristineBuiltinGlobal(ast.checker, ast.sourceFiles);
  const plans = prepareConversionResolvers(ast.checker, ast.sourceFiles, run, pristine);
  if (name === "String") return plans.isAmbientStringBinding(call!.expression as ts.Identifier);
  return (name === "Number" ? plans.preparedNumberCall : plans.preparedBooleanCall)(call!);
}

// (#7350) The Prepared conversion plans hold while the realm's global is pristine, whatever value reads the program
// makes (the harness prelude reads `String` as a value: `map.call(arrayLike, String)`); a declaration or write of the
// name withdraws the plan.
describe("#7350 — the conversion call plans ask the pristine realm binding", () => {
  const call = (name: string) => `export function run(v: any) { return ${name}(v); }`;
  for (const name of ["String", "Number", "Boolean"] as const) {
    it.each([
      ["the call alone", call(name)],
      ["a value read beside it", `${call(name)}\nvar mapped = [1].map.call([1], ${name});`],
      [`${name} stored as a value`, `${call(name)}\nvar S: any = ${name};`],
      [`${name} read off globalThis`, `${call(name)}\nvar G: any = globalThis.${name};`],
    ])(`keeps the ${name} plan: %s`, (_, source) => {
      expect(admitsCall(source, name)).toBe(true);
    });
    it.each([
      [`${name} assigned`, `${call(name)}\n(${name} as any) = 1;`],
      [`${name} written through globalThis`, `${call(name)}\n(globalThis as any).${name} = 1;`],
      [`${name} declared`, `${call(name)}\nvar ${name}: any = 1;`],
    ])(`withdraws the ${name} plan: %s`, (_, source) => {
      expect(admitsCall(source, name)).toBe(false);
    });
  }
});
