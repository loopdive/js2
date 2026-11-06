// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever T — the ES5 `if (x !== 1) throw new Test262Error('#1: ' + x)`
// shape over a script var. The selector judges the thrown value by its own
// family (`throwOperandAdmissible`) and a module `+` by #7066's additive rule,
// so `<module-init>` is claimed; a compound write the builder cannot lower on
// a dynamic script var is refused at selection instead of withdrawn.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";

/** Run `body`'s `<module-init>` on `target` (an assert failure throws); report whether the IR claimed it. */
async function runBody(target: Target, body: string): Promise<boolean> {
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

const check = (expression: string, expected: string): string =>
  `if (${expression} !== ${JSON.stringify(expected)}) { throw new Test262Error('#1: ' + ${expression}); }`;

const CLAIMED: Record<string, string> = {
  numberMessage: "var x = 1;\nif (x !== 1) { throw new Test262Error('#1: ' + x); }",
  parenthesizedOperand: "var x = 1;\nif (x !== 1) { throw new Test262Error('#1: x === 1. Actual: ' + (x)); }",
  rewrittenVar: "var x = 1;\nx = x + 1;\nif (x !== 2) { throw new Test262Error('#1: ' + x); }",
  fraction: `var x = 1.5;\n${check("'#' + x", "#1.5")}`,
  negativeZero: `var x = -0;\n${check("'#' + x", "#0")}`,
  exponent: `var x = 1e21;\n${check("'#' + x", "#1e+21")}`,
  booleanMessage: `var x = true;\n${check("'#' + x", "#true")}`,
};

const REFUSED: Record<string, string> = {
  // A number has no throw box (`throwOperandAdmissible`).
  thrownNumber: "var x = 1;\ntry { throw x; } catch (e) { if (e !== 1) { throw new Test262Error('e'); } }",
  // A boolean beside a number is no concatenation.
  booleanPlusNumber: "var x = true;\nif (x + 1 !== 2) { throw new Test262Error('#1'); }",
  // `lowerCompoundAssignment` writes no dynamic module slot yet (#7130).
  dynamicCompound: "var y;\ny = 1;\ny *= -1;\nif (y !== -1) { throw new Test262Error('#1: ' + y); }",
  dynamicAppend: "var y;\ny = 1;\ny += 1;\nif (y !== 2) { throw new Test262Error('#1: ' + y); }",
  // A void local call has no value to combine (S13.2.1_A9_T1).
  voidCallOperand:
    "var x;\nfunction f() { x = 1; return; }\n" +
    "if (f() !== undefined) { throw new Test262Error('#1: ' + f()); }\nif (x !== 1) { throw new Test262Error('#2: ' + x); }",
};

describe("#7106 lever T — throw messages over a script scalar", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runBody(target, body)).toBe(true);
        });
      }
      for (const [name, body] of Object.entries(REFUSED)) {
        it(`refuses at selection, never withdraws: ${name}`, async () => {
          expect(await runBody(target, body)).toBe(false);
        });
      }
      it("a failing check throws its message", async () => {
        await expect(
          runBody(target, "var x = 1;\nif (x !== 2) { throw new Test262Error('#1: ' + x); }"),
        ).rejects.toThrow();
      });
    });
  }
});
