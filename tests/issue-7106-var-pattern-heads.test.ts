// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S5 — a script's `var` pattern over a fresh literal, as a statement or
// as a `for (;;)` head, writes each leaf's own `__mod_<name>` slot as the
// dynamic carrier. These run the test262 shapes behind the original harness on
// both lanes, and the shapes that stay legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
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
  statement: "var [a, b = 2] = [1];\nassert.sameValue(a, 1);\nassert.sameValue(b, 2);",
  pastTheEnd: "var [_, x] = [];\nassert.sameValue(_, undefined);\nassert.sameValue(x, undefined);",
  objectKeys: "var { x, y: w, } = { x: 23, y: 'w' };\nassert.sameValue(x, 23);\nassert.sameValue(w, 'w');",
  nestedDefault: "var [[x, y, z] = [4, 5, 6]] = [];\nassert.sameValue(x, 4);\nassert.sameValue(z, 6);",
  forHead: loop("var [x, y = 'y'] = [1]", "assert.sameValue(x, 1); assert.sameValue(y, 'y');"),
  // The leaves are script `var`s: read after the loop, from a function, and before the declaration.
  readAfterLoop: loop("var { x } = { x: 7 }", "") + "\nassert.sameValue(x, 7);",
  // A typed slot takes a matching literal: an `f64` default and a string.
  typedSlots: "var [t = 23, { s }] = [, { s: 's' }];\nassert.sameValue(t + 1, 24);\nassert.sameValue(s, 's');",
  readFromFunction: "var [s] = ['s'];\nfunction f() { return s; }\nassert.sameValue(f(), 's');",
  readBeforeDeclaration: "assert.sameValue(h, undefined);\nvar [h] = [1];\nassert.sameValue(h, 1);",
  // Review round 1: a labelled head is still the statement's head.
  labelledHead: loop("var { k } = { k: 2 }", "assert.sameValue(k, 2);").replace("for (", "outer: for ("),
};

// Refused at selection.
const REFUSED: Record<string, string> = {
  // Only a `var` list of a top-level statement declares module-init leaves.
  lexical: "const [a] = [1];\nassert.sameValue(a, 1);",
  nestedVar: "{ var [a] = [1]; }\nassert.sameValue(a, 1);",
  // S6: an identifier `for` head.
  identifierHead: loop("var i = 0", "assert.sameValue(i, 0);"),
  // A redeclared leaf is already in scope.
  redeclared: "var x;\nvar [x] = [1];\nassert.sameValue(x, 1);",
  // A `var` pattern takes the literal plan only.
  variableSource: "var src = [1];\nvar [a] = src;\nassert.sameValue(a, 1);",
  // An array length has no source expression to box.
  lengthLeaf: "var { length: n } = [1, 2];\nassert.sameValue(n, 2);",
  // NamedEvaluation is the literal plan's own refusal.
  functionDefault: "var [fn = function () {}] = [];\nassert.sameValue(fn.name, 'fn');",
};

// Review round 1: a no-default number leaf's slot is the carrier (#3423), so its
// read is a dynamic value although the checker types it as a number; a boolean
// leaf's slot reads back as an unbranded i32. Each of these was claimed and
// then withdrawn after the claim; now nothing is.
const NO_WITHDRAWAL: Record<string, string> = {
  copyToVar: "var [a] = [3];\nvar b = a;",
  readBefore: "var r = a;\nvar { a } = { a: 1 };",
  readBeforeHead: "var r = a;\nfor (var [a] = [1]; ; ) { break; }",
  compoundInHead: "var s = 0, n = 0;\nfor (var [a] = [4]; n < 3; n++) { s += a; }",
  returnRead: "var { a } = { a: 5 };\nfunction g() { return a; }\ng();",
  returnReadNoCaller: "var { a } = { a: 5 };\nfunction g() { return a; }",
  compoundLocal: "var { a } = { a: 5 };\nfunction m() { var s = 0; s += a; return s; }",
  booleanLeaf: "var { x } = { x: true };\nassert.sameValue(x, true);",
  additionToVar: "var [a] = [3];\nvar b = a + 1;",
  assignment: "var b = 0;\nvar [a] = [3];\nb = a;",
};

describe("#7106 S5 script `var` patterns", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runHarness(target, body)).toBe(true);
        });
      }
      for (const [name, body] of Object.entries(REFUSED)) {
        it(`stays legacy and runs: ${name}`, async () => {
          expect(await runHarness(target, body)).toBe(false);
        });
      }
      for (const [name, body] of Object.entries(NO_WITHDRAWAL)) {
        it(`withdraws no claim: ${name}`, async () => {
          await compileHarness(target, body);
        });
      }
    });
  }
});
