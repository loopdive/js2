// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever L — a script's top-level `for (var i = …; …; …)` head declares
// script `var`s in their `__mod_<name>` slots, exactly as a `var` statement
// does. These run the shapes behind the original harness on both lanes: the
// heads the IR now claims, and the ones that stay legacy.

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
  counter: "var n = 0;\nfor (var i = 0; i < 3; i++) { n += 1; }\nassert.sameValue(n, 3);\nassert.sameValue(i, 3);",
  compoundUpdate: "for (var i = 0; i < 10; i += 3) { }\nassert.sameValue(i, 12);",
  twoDeclarators: "for (var i = 0, j = 10; i < j; i++, j--) { }\nassert.sameValue(i, 5);\nassert.sameValue(j, 5);",
  // `for (var i; …)` is a no-op at the head: the prologue seeded the slot.
  noInitializer: "var n = 0;\nfor (var i; n < 2; n++) { }\nassert.sameValue(i, undefined);\nassert.sameValue(n, 2);",
  // Hoisting: the binding exists before the loop.
  readBeforeHead: "assert.sameValue(i, undefined);\nfor (var i = 0; i < 1; i++) { }\nassert.sameValue(i, 1);",
  // Two heads, and a head beside a statement: one binding, one slot.
  repeatedHead:
    "var s = 0;\nfor (var i = 0; i < 2; i++) { s += i; }\nfor (var i = 5; i < 7; i++) { s += i; }\nassert.sameValue(s, 12);\nassert.sameValue(i, 7);",
  statementThenHead: "var i = 9;\nfor (var i = 0; i < 2; i++) { }\nassert.sameValue(i, 2);",
  headThenStatement: "for (var i = 0; i < 2; i++) { }\nvar i = 9;\nassert.sameValue(i, 9);",
  labelled: "outer: for (var i = 0; i < 3; i++) { if (i === 1) break outer; }\nassert.sameValue(i, 1);",
  emptyCondition: "var x = 0;\nfor (var i = 0; ; ) { x++; if (x > 2) break; }\nassert.sameValue(i, 0);",
  booleanHead: "for (var b = true; b; b = false) { }\nassert.sameValue(b, false);",
  // Review round 1: the head binds in the enclosing scope, so an update after the loop is a slot write.
  incrementAfter: "for (var i = 0; i < 2; i++) { }\ni++;\nassert.sameValue(i, 3);",
  decrementAfter: "for (var i = 0; i < 2; i++) { }\n--i;\nassert.sameValue(i, 1);",
  compoundAfter: "for (var i = 0; i < 2; i++) { }\ni += 5;\nassert.sameValue(i, 7);",
  whileAfter: "for (var i = 0; i < 2; i++) { }\nwhile (i < 5) i++;\nassert.sameValue(i, 5);",
  // A function reads and writes the head's slot.
  readFromFunction: "for (var i = 0; i < 4; i++) { }\nfunction g() { return i; }\nassert.sameValue(g(), 4);",
  writeFromFunction: "function w() { i = 10; }\nfor (var i = 0; i < 4; i++) { w(); }\nassert.sameValue(i, 11);",
};

// Refused at selection; legacy runs them.
const REFUSED: Record<string, string> = {
  // A `var` merged with a function owns the function's slot.
  functionName: "function i() {}\nfor (var i = 0; i < 1; i++) { }\nassert.sameValue(i, 1);",
  // A lexical head may not shadow a script `var`, nor a script `var` head a lexical name.
  letAfterVar: "for (var i = 0; i < 2; i++) { }\nfor (let i = 0; i < 1; i++) { }\nassert.sameValue(i, 2);",
  varAfterLet: "for (let i = 0; i < 1; i++) { }\nfor (var i = 0; i < 2; i++) { }\nassert.sameValue(i, 2);",
  // A closure in the body captures the slot; the closure's own shape stays legacy.
  closureInBody: "var f;\nfor (var i = 0; i < 2; i++) { f = function () { return i; }; }\nassert.sameValue(f(), 2);",
  // Runtime eval withdraws the program, as before.
  evalProgram: "for (var i = 0; i < 2; i++) { }\nassert.sameValue(eval('i'), 2);",
  withProgram: "var o = { k: 1 };\nwith (o) { k = 2; }\nfor (var i = 0; i < 2; i++) { }\nassert.sameValue(i, 2);",
};

describe("#7106 lever L: script `var` `for` heads", () => {
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
    });
  }
});
