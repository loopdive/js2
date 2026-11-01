// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a destructuring declaration whose source is a fresh array or object
// literal lowers in the IR without building the literal: the plan
// (`src/ir/binding-pattern-plan.ts`) binds each leaf to the expression at its
// position, to `undefined`, or to its default, and the selector checks the
// same plan the builder lowers. These run the test262 `for (;;)` head shapes
// behind the original harness on both lanes, and the shapes that stay legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planLiteralPattern } from "../src/ir/binding-pattern-plan.js";
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
    "let [, ...{ 0: v, 1: w, 9: u, length: z }] = [7, 8, 9]",
    "assert.sameValue(v, 8); assert.sameValue(w, 9); assert.sameValue(u, undefined); assert.sameValue(z, 2);",
  ),
  // Each reassigned `let` leaf is a slot.
  reassignedLet:
    "var count = 0;\nfor (let [i, j] = [0, 6]; i < j; i++, j--) { count += 1; }\nassert.sameValue(count, 3);",
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
    });
  }

  // Main used to claim the first and demote it at build: the checker types
  // the literal as a tuple of `any`, which the vec reader cannot lower.
  const FUNCTIONS: Record<string, [string, number]> = {
    arrayLiteral: ["export function f() { const [x, y, z] = [1, 2, 3]; return x + y * z; }", 7],
    reassignedLeaves: [
      "export function f() { let s = 0; for (let [i, j] = [0, 6]; i < j; i++, j--) { s = s + j - i; } return s; }",
      12,
    ],
  };
  for (const [name, [source, expected]] of Object.entries(FUNCTIONS)) {
    it(`a .js function is claimed and runs: ${name}`, async () => {
      for (const target of TARGETS) {
        const result = await compile(source, {
          fileName: "f.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        });
        expect(result.success).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(result.irOutcomes?.find((outcome) => outcome.displayName === "f")?.irBodyEmitted).toBe(true);
        const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
        expect((instance.exports.f as () => number)()).toBe(expected);
      }
    });
  }

  it("the plan evaluates every literal expression in source order before any default", () => {
    const source = "const [a, , b = d(), c] = [x(), y()];";
    const declaration = (
      ts.createSourceFile("plan.js", source, ts.ScriptTarget.ES2022, true).statements[0] as ts.VariableStatement
    ).declarationList.declarations[0]!;
    const plan = planLiteralPattern(declaration.name as ts.BindingPattern, declaration.initializer!)!;
    expect(plan.evaluations.map((expression) => expression.getText())).toEqual(["x()", "y()"]);
    expect(
      plan.steps.map((step) => (step.kind === "nested" ? "nested" : `${step.kind} ${step.leaf.name.text}`)),
    ).toEqual(["bind a", "default b", "bind c"]);
    expect(plan.steps[0]).toMatchObject({ value: { kind: "evaluated", index: 0 } });
    expect(plan.steps[2]).toMatchObject({ value: { kind: "undefined" } });
  });
});
