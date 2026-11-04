// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a destructuring declaration whose source is a fresh array or object
// literal lowers in the IR without building the literal: the plan
// (`src/ir/literal-pattern-plan.ts`) binds each leaf to the expression at its
// position, to `undefined`, or to its default, and the selector checks the
// same plan the builder lowers. These run the test262 `for (;;)` head shapes
// behind the original harness on both lanes, and the shapes that stay legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planLiteralPattern } from "../src/ir/literal-pattern-plan.js";
import { programPatchesDestructuringRealm } from "../src/ir/realm-keys.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

/** Compile `body` behind assert.js + sta.js; a claim is never withdrawn after the fact. */
async function compileHarness(target: Target, body: string) {
  const result = await compile(assembleHarnessBody(body), {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

/** Run `<module-init>` (an assert failure throws) and report whether the IR claimed it. */
async function runHarness(target: Target, body: string): Promise<boolean> {
  const result = await compileHarness(target, body);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as () => void)();
  return moduleInit(result)?.irBodyEmitted === true;
}

const loop = (head: string, checks: string) =>
  `var n = 0;\nfor (${head}; n < 1; ) {\n${checks}\n  n += 1;\n}\nassert.sameValue(n, 1);`;

const CLAIMED: Record<string, string> = {
  inRange: loop(
    "const [x, y, z] = [1, 2, 3]",
    "assert.sameValue(x, 1); assert.sameValue(y, 2); assert.sameValue(z, 3);",
  ),
  objectKeys: loop("let { x, y: w, } = { x: 23, y: 7 }", "assert.sameValue(x, 23); assert.sameValue(w, 7);"),
  pastTheEnd: loop("const [_, x] = []", "assert.sameValue(_, undefined); assert.sameValue(x, undefined);"),
  exhaustedDefault: loop("const [x = 23] = []", "assert.sameValue(x, 23);"),
  holeDefault: loop("let [x = 23] = [,]", "assert.sameValue(x, 23);"),
  // A default runs on `undefined`, not on `0`.
  undefinedDefault: loop("const [x = 23, y = 4] = [undefined, 0]", "assert.sameValue(x, 23); assert.sameValue(y, 0);"),
  missingKeyDefault: loop("const { x: y = 33 } = { }", "assert.sameValue(y, 33);"),
  nestedDefault: loop(
    "const [[x, y, z] = [4, 5, 6]] = []",
    "assert.sameValue(x, 4); assert.sameValue(y, 5); assert.sameValue(z, 6);",
  ),
  nestedSource: loop(
    "let [{ x, y, z } = { x: 44, y: 55, z: 66 }] = [{ x: 11, y: 22, z: 33 }]",
    "assert.sameValue(x, 11); assert.sameValue(y, 22); assert.sameValue(z, 33);",
  ),
  nestedArrayInObject: loop("const { x: [y], } = { x: [45] }", "assert.sameValue(y, 45);"),
  restIntoPattern: loop("const [...[x, y, z]] = [3, 4, 5]", "assert.sameValue(x, 3); assert.sameValue(z, 5);"),
  restLength: loop(
    "let [, ...{ 0: v, 1: w, length: z }] = [7, 8, 9]",
    "assert.sameValue(v, 8); assert.sameValue(w, 9); assert.sameValue(z, 2);",
  ),
  // Destructuring `null` or `undefined` throws a TypeError, after the source is evaluated.
  typeErrorNull: "assert.throws(TypeError, function () {\n  for (const {} = null; ; ) { return; }\n});",
  typeErrorNestedUndefined:
    "assert.throws(TypeError, function () {\n  for (let [[x]] = [undefined]; ; ) { return; }\n});",
  typeErrorNestedNull:
    "assert.throws(TypeError, function () {\n  for (const { w: [x, y] = [4, 5] } = { w: null }; ; ) { return; }\n});",
  typeErrorDefaultUndefined:
    "assert.throws(TypeError, function () {\n  for (const { w: { x } = undefined } = {}; ; ) { return; }\n});",
  functionLocal: "function f() { const [a, b = 2] = [1]; return a + b; }\nassert.sameValue(f(), 3);",
};

// Refused at selection. Legacy answers some of these wrongly, so they only compile.
const REFUSED: Record<string, string> = {
  generatorSource: "function* g() { yield 1; }\n" + loop("const [x] = g()", "assert.sameValue(x, 1);"),
  iterableVariable: "var src = [1, 2];\n" + loop("const [a, b] = src", "assert.sameValue(b, 2);"),
  untypedDefault: "var u;\n" + loop("const [x = 5] = [u]", "assert.sameValue(x, 5);"),
  functionName: loop("const [fn = function () {}] = []", "assert.sameValue(fn.name, 'fn');"),
  arrowName: loop("const { arrow = () => {} } = {}", "assert.sameValue(arrow.name, 'arrow');"),
  objectPrototypeKey: loop("const { toString: t } = {}", "assert.sameValue(t, Object.prototype.toString);"),
  arrayPrototypeKey: loop("const [...{ join }] = [1]", "assert.sameValue(typeof join, 'function');"),
  restIdentifier: loop("const [, ...rest] = [1, 2, 3]", "assert.sameValue(rest.length, 2);"),
  spreadSource: "var more = [2];\n" + loop("const [a, b] = [1, ...more]", "assert.sameValue(b, 2);"),
  leafInDefault: loop("const [a = 1, b = a] = []", "assert.sameValue(b, 1);"),
  nullLeaf: loop("const [x = 1] = [null]", "assert.sameValue(x, null);"),
  // Follow-ups: a script-level pattern (S5), and the call-graph scan still
  // sees a default IIFE the plan never runs.
  scriptLevel: "const [a, b = 2] = [1];\nassert.sameValue(a + b, 3);",
  unusedDefaultCall: loop("const [[] = function () { throw 1; }()] = [[23]]", "assert.sameValue(n, 0);"),
  // Review round 1: an index past the end reads `Array.prototype`, and a
  // patched `Object.prototype` answers a missing key (legacy misses both).
  indexPastTheEnd: loop("const { 3: a } = [1]", "assert.sameValue(a, undefined);"),
  objectPrototypePatched: "Object.prototype.zz = 7;\n" + loop("const { zz } = {}", "assert.sameValue(zz, 7);"),
};

// Review round 1: refused at selection, and legacy gives the right answer.
const LEGACY: Record<string, string> = {
  // A written leaf: a `const` write must throw, which only legacy raises.
  constWriteInUpdate: "assert.throws(TypeError, function () {\n  for (const [a] = [1]; a < 3; a++) {}\n});",
  constWriteInBody: "assert.throws(TypeError, function () {\n  for (const { a } = { a: 1 }; ; ) { a = 2; }\n});",
  // A written `let` leaf has no storage analysis behind it.
  reassignedLet:
    "var count = 0;\nfor (let [i, j] = [0, 6]; i < j; i++, j--) { count += 1; }\nassert.sameValue(count, 3);",
  // Review round 2: a leaf's family reaches the operator check.
  mixedPlus: loop("const [a, b] = [1, 'x']", "assert.sameValue(a + b, '1x');"),
  // A leaf never binds a literal whole: that would build it.
  wholeArray: loop("const [a] = [[1, 2]]", "assert.sameValue(a.length, 2); assert.sameValue(a[1], 2);"),
  wholeObjectWithNull: loop("const { a } = { a: { b: null } }", "assert.sameValue(a.b, null);"),
  // A program that patches the realm the readers assume.
  arrayIteratorPatched:
    "Array.prototype[Symbol.iterator] = function* () { yield 42; };\n" +
    loop("const [a] = [1]", "assert.sameValue(a, 42);"),
  arrayIteratorDeleted:
    "delete Array.prototype[Symbol.iterator];\nfunction g() { const [a] = [1]; return a; }\nassert.throws(TypeError, g);",
};

describe("#7106 for-head destructuring over a fresh literal", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runHarness(target, body)).toBe(true);
        });
      }
      for (const [name, body] of Object.entries(REFUSED)) {
        it(`stays legacy: ${name}`, async () => {
          expect(moduleInit(await compileHarness(target, body))?.irBodyEmitted).toBe(false);
        });
      }
      for (const [name, body] of Object.entries(LEGACY)) {
        it(`stays legacy and runs: ${name}`, async () => {
          expect(await runHarness(target, body)).toBe(false);
        });
      }
    });
  }

  // Main used to claim the first and demote it at build: the checker types
  // the literal as a tuple of `any`, which the vec reader cannot lower.
  const FUNCTIONS: Record<string, [string, number]> = {
    arrayLiteral: ["export function f() { const [x, y, z] = [1, 2, 3]; return x + y * z; }", 7],
    forHeadLeaves: [
      "export function f() { let s = 0; for (const [i, j] = [0, 6]; s < 12; ) { s = s + j - i; } return s; }",
      12,
    ],
  };
  // Review round 1: refused at selection (main claimed several, then demoted or
  // failed the compile), and legacy gives the right answer.
  const typeErrorOf = (statements: string) =>
    `export function f() { try { ${statements} return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }`;
  const LEGACY_FUNCTIONS: Record<string, [string, number]> = {
    constWrite: [typeErrorOf("const [a] = [1]; a = 2;"), 1],
    constWriteInForUpdate: [typeErrorOf("for (const [a] = [1]; a < 3; a++) {}"), 1],
    constCompoundWrite: [typeErrorOf("const { a } = { a: 1 }; a += 1;"), 1],
    constWriteInLaterCase: [typeErrorOf("switch (0) { case 0: const [a] = [1]; case 1: a = 2; }"), 1],
    letRetypedObject: ["export function f() { let [a] = [{ x: 1 }]; a = { x: 2 }; return a.x; }", 2],
    letRetypedString: [
      "export function f() { var s = ''; for (let [a, b] = ['x', 0]; b < 3; b++) { s += a; a = a + 'y'; } return s.length; }",
      6,
    ],
    indexPastTheEnd: ["export function f() { const { 3: a } = [1]; return a === undefined ? 7 : 0; }", 7],
    // Review round 2: a leaf has its source value's family, so a mixed `+` is refused like `lowerBinary` refuses it.
    mixedPlus: ["export function f() { const [a, b] = [1, 'x']; return (a + b).length; }", 2],
    mixedPlusForHead: [
      "export function f() { let n = 0; let s = ''; for (const [a, b] = [1, 'x']; n < 1; n++) { s = a + b; } return s.length; }",
      2,
    ],
  };
  const compileFunction = (source: string, target: Target) =>
    compile(source, {
      fileName: "f.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      ...(target ? { target } : {}),
    });
  for (const [claimed, cases] of [
    [true, FUNCTIONS],
    [false, LEGACY_FUNCTIONS],
  ] as const) {
    for (const [name, [source, expected]] of Object.entries(cases)) {
      it(`a .js function is ${claimed ? "claimed" : "refused"} and runs: ${name}`, async () => {
        for (const target of TARGETS) {
          const result = await compileFunction(source, target);
          expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
          expect(result.irPostClaimErrors ?? []).toEqual([]);
          expect(result.irOutcomes?.find((outcome) => outcome.displayName === "f")?.irBodyEmitted).toBe(claimed);
          const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
          const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
          expect((instance.exports.f as () => number)()).toBe(expected);
        }
      });
    }
  }

  const parse = (source: string) => ts.createSourceFile("plan.js", source, ts.ScriptTarget.ES2022, true);
  const firstDeclaration = (source: string) =>
    (parse(source).statements[0] as ts.VariableStatement).declarationList.declarations[0]!;

  it("the plan evaluates every literal expression in source order before any default", () => {
    const declaration = firstDeclaration("const [a, , b = d(), c] = [x(), y()];");
    const plan = planLiteralPattern(declaration.name as ts.BindingPattern, declaration.initializer!)!;
    expect(plan.evaluations.map((expression) => expression.getText())).toEqual(["x()", "y()"]);
    expect(
      plan.steps.map((step) => (step.kind === "nested" ? "nested" : `${step.kind} ${step.leaf.name.text}`)),
    ).toEqual(["bind a", "default b", "bind c"]);
    expect(plan.steps[0]).toMatchObject({ value: { kind: "evaluated", index: 0 } });
    expect(plan.steps[2]).toMatchObject({ value: { kind: "undefined" } });
  });

  it("an `undefined` the program binds anywhere is not the global value (round 2)", () => {
    const plain = firstDeclaration("const [a = 1] = [undefined];");
    expect(planLiteralPattern(plain.name as ts.BindingPattern, plain.initializer!)).not.toBeNull();
    // A later block-scoped `let undefined` holds the name in TDZ, so the default cannot be proven to run.
    const tdz = firstDeclaration("const [a = 1] = [undefined]; let undefined = 5;");
    expect(planLiteralPattern(tdz.name as ts.BindingPattern, tdz.initializer!)).toBeNull();
  });

  it("the realm guard sees every patch it can name, and no plain member read (round 2)", () => {
    const patches = [
      "Array.prototype[Symbol.iterator] = g;",
      "delete Array.prototype[Symbol.iterator];",
      "Reflect.defineProperty(Array.prototype, Symbol.iterator, { value: g });",
      "Object.assign(Array.prototype, { 0: 1 });",
      "Object.setPrototypeOf(Array.prototype, null);",
      "globalThis.Array.prototype[Symbol.iterator] = g;",
      "[Array.prototype[Symbol.iterator]] = [g];",
      "Object.prototype.zz ??= 7;",
      "Object.prototype.k += 1;",
      "Object.prototype.__defineGetter__('zz', g);",
      "var AP = Array.prototype;",
    ];
    for (const source of patches) expect(programPatchesDestructuringRealm(parse(source)), source).toBe(true);
    const reads = [
      "Array.prototype.map.call(xs, String);",
      "Object.prototype.toString.call(v);",
      "var join = Function.prototype.call.bind(Array.prototype.join);",
    ];
    for (const source of reads) expect(programPatchesDestructuringRealm(parse(source)), source).toBe(false);
  });
});
