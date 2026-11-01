// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a fresh `new Boolean/Number/String(x)` operand of an operator is the
// dynamic carrier of its ToPrimitive (the #4208 S4 producer, generalised from
// `==`): the hint is `number` for the numeric readers and `default` for `+` and
// `==`. A `null` operand of a numeric reader is +0. A pair `lowerBinary`
// cannot type is refused at selection (S0), never after the claim.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { lane, runModuleInit, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";
import { buildImports } from "../src/runtime.js";

const WRAPPERS = ["new Number(2)", 'new String("12")', "new Boolean(true)"];
const OTHERS = ["1.5", "undefined", "null", "new Number(3)", 'new String("2")'];
const RELATIONAL = ["<", "<=", ">", ">="];
const NUMERIC = ["-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"];
const OPERATORS = [...RELATIONAL, ...NUMERIC, "+", "==", "!="];

interface Case {
  readonly expression: string;
  readonly claimed: boolean;
}

const isWrapper = (operand: string) => operand.startsWith("new ");

/**
 * The claim rule: `null` and `undefined` only under a numeric reader (`+`
 * observes their value), and `==` keeps S4's number side.
 */
function claimed(operator: string, wrapper: string, other: string): boolean {
  if (operator === "==" || operator === "!=") return !isWrapper(other) && other === "1.5";
  return !((other === "null" || other === "undefined") && operator === "+");
}

const CASES: Case[] = WRAPPERS.flatMap((wrapper) =>
  OTHERS.flatMap((other) =>
    OPERATORS.flatMap((operator) => [
      { expression: `${wrapper} ${operator} ${other}`, claimed: claimed(operator, wrapper, other) },
      { expression: `${other} ${operator} ${wrapper}`, claimed: claimed(operator, wrapper, other) },
    ]),
  ),
);

/** `if (<expression> is not what node answers) throw`, with node's answer as a literal (NaN by self-inequality). */
function check(expression: string): string {
  const expected = new Function(`return ${expression};`)() as unknown;
  const label = JSON.stringify(expression);
  if (typeof expected === "number" && Number.isNaN(expected)) {
    return `if ((${expression}) === (${expression})) { throw ${label}; }`;
  }
  const literal = typeof expected === "number" ? String(expected) : JSON.stringify(expected);
  return `if ((${expression}) !== ${literal}) { throw ${label}; }`;
}

const chunks = (cases: readonly Case[], size = 8): string[] => {
  const out: string[] = [];
  for (let i = 0; i < cases.length; i += size)
    out.push(
      cases
        .slice(i, i + size)
        .map((c) => check(c.expression))
        .join("\n"),
    );
  return out;
};

async function compileSource(target: Target, source: string): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7106-wrapper-operands.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function exportsOf(target: Target, result: CompileResult) {
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, () => unknown>;
}

const unit = (result: CompileResult, name: string) => result.irOutcomes?.find((o) => o.displayName === name);

describe("#7106 fresh-wrapper operator operands", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      chunks(CASES.filter((c) => c.claimed)).forEach((source, index) => {
        it(`claims every typed operator and agrees with node (#${index})`, async () => {
          const run = await runModuleInit(target, source, { fileName: "issue-7106-wrapper-operands.js" });
          expect(run).toEqual({ claimed: true, threw: false });
        });
      });

      it("refuses identity equality, a null or undefined `+` and a non-number `==` side at selection", async () => {
        const refused = CASES.filter((c) => !c.claimed);
        const result = await compileSource(
          target,
          refused.map((c, index) => `export function c${index}() { return ${c.expression}; }`).join("\n"),
        );
        refused.forEach(({ expression }, index) => {
          expect(unit(result, `c${index}`), expression).toMatchObject({ irBodyEmitted: false, stage: "select" });
        });
      });

      it("claims a function body", async () => {
        const result = await compileSource(
          target,
          `export function lt() { return new Number(5) < 1.5; }
          export function mixed() { return 1 - new String("4") * new Boolean(true); }
          export function plus() { return (new String("1") + 2) === "12"; }
          export function nullRead() { return (null - 1) + (2 >>> null) + (null < 1 ? 10 : 0); }`,
        );
        for (const name of ["lt", "mixed", "plus", "nullRead"]) {
          expect(unit(result, name), name).toMatchObject({ irBodyEmitted: true });
        }
        const exports = await exportsOf(target, result);
        expect(Number(exports.lt!())).toBe(0);
        expect(exports.mixed!()).toBe(-3);
        expect(Number(exports.plus!())).toBe(1);
        expect(exports.nullRead!()).toBe(11);
      });
    });
  }

  // S0: a pair `lowerBinary` cannot type is refused before the claim.
  const S0_REFUSED: Record<string, string> = {
    stringNumber: `"1" < 1`,
    booleanDivide: "true / 1",
    mixedConcat: `"x" + 1`,
    nullPlus: "null + 1",
    stringNull: `"a" < null`,
    stringBitwise: `"1" & 1`,
    wrapperStrict: "new Number(1) === 1",
    wrapperIdentity: "new Number(1) == new Number(1)",
    wrapperString: 'new Boolean(true) == "1"',
    wrapperArgument: "new Number(true) < 1",
  };
  for (const target of TARGETS) {
    it(`S0 refuses at selection (${lane(target)})`, async () => {
      const source = Object.entries(S0_REFUSED)
        .map(([name, expression]) => `export function ${name}() { return ${expression}; }`)
        .join("\n");
      const result = await compileSource(target, source);
      for (const name of Object.keys(S0_REFUSED)) {
        expect(unit(result, name), name).toMatchObject({ irBodyEmitted: false, stage: "select" });
      }
    });
  }

  // The hint follows the operator, and a user method is observed.
  const PROBES: Record<string, string> = {
    toPrimitiveHint: `Number.prototype[Symbol.toPrimitive] = function (hint) { return hint === "number" ? 1 : 2; };
      function check() {
        if ((new Number(5) < 1.5) !== true) { throw "#lt"; }
        if ((new Number(5) * 3) !== 3) { throw "#mul"; }
        if ((new Number(5) + 0) !== 2) { throw "#plus"; }
        if ((new Number(5) == 2) !== true) { throw "#eq"; }
        return 1;
      }
      check();`,
    valueOf: `function sub() { return new Number(1) - 1; }
      function rel() { return new Number(1) < 3; }
      function band() { return new Number(6) & 3; }
      function relStr() { return new String("5") > 3; }
      Number.prototype.valueOf = function () { return 10; };
      String.prototype.valueOf = function () { return "1"; };
      if (sub() !== 9 || rel() !== false || band() !== 2 || relStr() !== false) { throw "#valueOf"; }`,
  };
  for (const target of TARGETS) {
    for (const [name, source] of Object.entries(PROBES)) {
      it(`${name} agrees with node (${lane(target)})`, async () => {
        const result = await compileSource(target, source);
        const claimedFunctions = (result.irOutcomes ?? []).filter(
          (o) => o.unitKind !== "module-init" && o.irBodyEmitted,
        );
        expect(claimedFunctions.length, name).toBeGreaterThan(0);
        await expect(exportsOf(target, result).then((exports) => exports.__module_init?.())).resolves.toBeUndefined();
      });
    }
  }
});
