// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 lever B — a numeric operator (`- * / %`, the bitwise operators, the
// relationals) over primitives and fresh wrappers. A boolean or string operand
// is boxed into the dynamic carrier (`carrierNumericReaderOperands`), so the
// pair takes `lowerBinary`'s dynamic arm: `dyn.to_number`, or the carrier
// relationals, whose IsLessThan compares two strings as strings.

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

const check = (cond: string): string => `if (!(${cond})) { throw new Test262Error(${JSON.stringify(cond)}); }`;

const CLAIMED: Record<string, string> = {
  arithmeticBoolean: [check("true * 1 === 1"), check("true - new Boolean(true) === 0"), check('"5" / true === 5')].join(
    "\n",
  ),
  arithmeticString: [check('"3" - 1 === 2'), check('new String("1") - "1" === 0'), check('isNaN("x" * 2)')].join("\n"),
  arithmeticNullish: [check('null - "1" === -1'), check('isNaN(undefined % "2")')].join("\n"),
  bitwise: [check("(true << true) === 2"), check('("8" >>> 1) === 4'), check('("6" & new Number(3)) === 2')].join("\n"),
  // §7.2.13: two strings compare as strings, through a wrapper too; any other pair as numbers.
  relational: [
    check('"10" < new String("9")'),
    check('!("10" < 9)'),
    check('new String("a") < "b"'),
    check('true >= "1"'),
  ].join("\n"),
};

const REFUSED: Record<string, string> = {
  // ToPrimitive of an ordinary object needs a `reference` family in the predicate: a follow-up.
  objectOperand: check("isNaN({} - 1)"),
  // `+` keeps the #7066 rule: `true + true` is not a numeric reader.
  additionOfBooleans: check("true + true === 2"),
};

describe("#7106 lever B — mixed-family operands of the numeric operators", () => {
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
    });
  }
});
