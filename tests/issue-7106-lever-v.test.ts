// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7292 (#7106 lever V) — a script `var` whose one write is a string array
// literal binds to the native-string vec slot legacy allocates, read as that
// vec; its named (expando) properties and unproven element reads go through
// the dynamic carrier, as legacy's do. These run the shapes behind the
// original harness on both lanes: the ones the IR claims, and the ones that
// stay legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

/** Run `<module-init>` behind assert.js + sta.js (an assert failure throws); report whether the IR claimed it. */
async function runHarness(target: Target, body: string): Promise<boolean> {
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
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as () => void)();
  return moduleInit(result)?.irBodyEmitted === true;
}

const CLAIMED: Record<string, string> = {
  // The S15.10.2 expectation object: an array with two expandos, compared element-wise in a counted loop.
  expectationArray:
    'var __expected = ["abc", "d"];\n__expected.index = 2;\n__expected.input = "x";\nvar __pieces = ["abc", "d"];\n' +
    "assert.sameValue(__expected.length, 2);\nassert.sameValue(__expected.index, 2);\n" +
    'assert.sameValue(__expected.input, "x");\n' +
    "for (var index = 0; index < __expected.length; index++) { assert.sameValue(__expected[index], __pieces[index]); }",
  literalIndex: 'var e = ["a", "b"];\nassert.sameValue(e[1], "b");',
  // An unproven read answers `undefined` out of bounds, for a fractional and a negative index too.
  outOfBounds:
    'var e = ["a"];\nassert.sameValue(e[3], undefined);\nassert.sameValue(e[0.5], undefined);\nassert.sameValue(e[-1], undefined);',
  strictExpando: '"use strict";\nvar e = ["a"];\ne.index = 2;\nassert.sameValue(e.index, 2);',
};

// Refused at selection; legacy runs them.
const REFUSED: Record<string, string> = {
  // A number vec's unproven read would answer NaN, not undefined.
  numberArray: "var a = [1, 2];\nassert.sameValue(a[1], 2);",
  holes: 'var e = ["a", , "b"];\nassert.sameValue(e.length, 3);',
  mixed: 'var e = ["a", 1];\nassert.sameValue(e.length, 2);',
  reassigned: 'var e = ["a"];\ne = ["b"];\nassert.sameValue(e[0], "b");',
  elementStore: 'var e = ["a"];\ne[0] = "z";\nassert.sameValue(e[0], "z");',
  lengthStore: 'var e = ["a", "b"];\ne.length = 1;\nassert.sameValue(e.length, 1);',
  methodCall: 'var e = ["a"];\ne.push("b");\nassert.sameValue(e.length, 2);',
  passedAsValue: 'var e = ["a"];\nassert.compareArray(e, ["a"]);',
  readBeforeDeclaration: 'var r = typeof e;\nvar e = ["a"];\nassert.sameValue(r, "undefined");',
  nested: 'if (true) { var e = ["a"]; }\nassert.sameValue(e[0], "a");',
  readInFunction: 'var e = ["a"];\nfunction f() { return e[0]; }\nassert.sameValue(f(), "a");',
  // Review round 1: an inherited name, and an expando read before its write.
  inheritedConstructor: 'var a = ["a", "b"];\nassert.sameValue(a.constructor === Array, true);',
  inheritedJoinTypeof: 'var a = ["a", "b"];\nassert.sameValue(typeof a.join, "function");',
  expandoReadBeforeWrite:
    'var e = ["a"];\nassert.sameValue(e.index, undefined);\ne.index = 1;\nassert.sameValue(e.index, 1);',
};

// Review round 1: refused at selection, never claimed and then withdrawn. Compiled only:
// legacy answers some of these differently from node, which is not this lever's to fix.
const REFUSED_COMPILE: Record<string, string> = {
  inheritedJoin: 'var a = ["a", "b"];\nassert.sameValue(a.join === undefined, false);',
  keyLeadingZero: 'var a = ["a", "b"];\nassert.sameValue(a["01"], undefined);',
  keyMinusZero: 'var a = ["a", "b"];\nassert.sameValue(a["-0"], undefined);',
  keyLength: 'var a = ["a", "b"];\nassert.sameValue(a["length"], 2);',
  keyFoo: 'var a = ["a", "b"];\nassert.sameValue(a["foo"], undefined);',
  keyUndefined: 'var a = ["a", "b"];\nassert.sameValue(a[undefined], undefined);',
  keyStringVar: 'var a = ["a", "b"];\nvar k;\nk = "0";\nassert.sameValue(a[k], "a");',
  keyNull: 'var a = ["a", "b"];\nassert.sameValue(a[null], undefined);',
  elementLength: 'var a = ["ab"];\nvar n = a[0].length;\nassert.sameValue(n, 2);',
  comparedWithUndefined: 'var a = ["a"];\nassert.sameValue(a[9] === undefined, true);',
  expandoPlusOne: 'var a = ["a"];\nassert.sameValue(a.foo + 1, NaN);',
  expandoPlusExpando: 'var a = ["a"];\nassert.sameValue(a.foo + a.bar, NaN);',
  expandoWrittenPlusOne: 'var a = ["a"];\na.foo = 1;\nassert.sameValue(a.foo + 1, 2);',
};

async function compileHarness(target: Target, body: string): Promise<boolean> {
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
  return moduleInit(result)?.irBodyEmitted === true;
}

describe("#7292 lever V: script-var string-array literals", () => {
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
      for (const [name, body] of Object.entries(REFUSED_COMPILE)) {
        it(`refused at selection: ${name}`, async () => {
          expect(await compileHarness(target, body)).toBe(false);
        });
      }
    });
  }
});
