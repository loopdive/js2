// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever L2 — a `var` statement or a `for (var …)` head nested in a
// script's top-level control flow declares script `var`s in their
// `__mod_<name>` slots, as a top-level one does; and a `for` update may be a
// prefix `++i` / `--i`. These run the shapes behind the original harness on
// both lanes: the ones the IR now claims, and the ones that stay legacy.

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
  // A `var` in a loop body is a write on every iteration.
  forBody:
    "var s = 0;\nfor (var i = 0; i < 3; i++) { var x = i * 2; s += x; }\nassert.sameValue(s, 6);\nassert.sameValue(x, 4);",
  whileBody: "var n = 0;\nwhile (n < 2) { var y = n; n++; }\nassert.sameValue(y, 1);",
  doBody: "var d = 0;\ndo { var dd = d; d++; } while (d < 3);\nassert.sameValue(dd, 2);",
  // A re-executed `var z;` is a no-op.
  bareInLoop: "for (var i = 0; i < 2; i++) { var z; }\nassert.sameValue(z, undefined);",
  ifBranch: "if (true) { var a = 5; }\nassert.sameValue(a, 5);",
  tryBlock: "try { var t = 1; } catch (e) { }\nassert.sameValue(t, 1);",
  switchCase: "switch (1) { case 1: var sv = 4; }\nassert.sameValue(sv, 4);",
  // Hoisting and redeclaration: one binding, one slot.
  readBefore: "assert.sameValue(w, undefined);\nif (true) { var w = 1; }\nassert.sameValue(w, 1);",
  statementThenNested: "var r = 1;\nif (true) { var r = 2; }\nassert.sameValue(r, 2);",
  nestedThenStatement: "if (true) { var r = 2; }\nvar r = 3;\nassert.sameValue(r, 3);",
  readFromFunction: "if (true) { var g1 = 7; }\nfunction rd() { return g1; }\nassert.sameValue(rd(), 7);",
  // A nested `for (var …)` head.
  headInIf: "if (true) { for (var k = 0; k < 2; k++) { } }\nassert.sameValue(k, 2);",
  headInBlock: "{ for (var i = 0; i < 2; i++) { } }\nassert.sameValue(i, 2);",
  headInLabelledBlock: "lbl: { for (var i = 0; i < 2; i++) { if (i) break lbl; } }\nassert.sameValue(i, 1);",
  // A prefix update in the `for` head.
  prefixIncrement: "for (var i = 0, n = 3; i < n; ++i) { }\nassert.sameValue(i, 3);",
  prefixDecrement:
    "var c = 0;\nfor (var i = 3; i > 0; --i) { c += 1; }\nassert.sameValue(c, 3);\nassert.sameValue(i, 0);",
  prefixLexical: "var t = 0;\nfor (let k = 0; k < 4; ++k) { t += k; }\nassert.sameValue(t, 6);",
};

// Refused at selection; legacy runs them.
const REFUSED: Record<string, string> = {
  // Annex B.3.5: a `var` re-declaring the catch parameter writes the parameter.
  catchParameter: "try { throw new Test262Error(); } catch (e) { var e = 2; assert.sameValue(e, 2); }",
  // Review round 1: a string or class-instance slot reads as written, and a
  // nested declaration may never run, so the binding gets no reference home.
  stringIfFalse: "if (false) { var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringIfFalseNotEqual: "if (false) { var a = 'x'; }\nif (a !== undefined) throw new Test262Error('a');",
  templateIfFalse: "if (false) { var a = `x`; }\nassert.sameValue(a, undefined);",
  stringWhileFalse: "while (false) { var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringForFalse: "for (; false; ) { var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringZeroIterations: "for (var i = 0; i < 0; i++) { var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringSwitchMiss: "switch (1) { case 2: var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringAfterBreak: "L: { break L; var a = 'x'; }\nassert.sameValue(a, undefined);",
  stringNestedHead: "if (false) { for (var a = 'x'; false; ) { } }\nassert.sameValue(a, undefined);",
  stringUnreachedCatch: "try { } catch (e) { var a = 'x'; }\nassert.sameValue(a, undefined);",
  classInstanceInBlock: "class C { m() { return 1; } }\n{ var c = new C(); }\nassert.sameValue(c.m(), 1);",
  // A name in a `with` body may resolve to the object.
  withBody: "var o = { v: 1 };\nwith (o) { var v = 2; }\nassert.sameValue(o.v, 2);",
};

describe("#7106 lever L2: nested script `var`s and prefix `for` updates", () => {
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
