// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7144 — one spelling of operand / write admissibility. Inside a planned
// function-member closure the selector judges every operator and slot write
// with the predicates of `src/ir/analysis/operand-admissibility.ts`, which are
// the ones `ir/from-ast` lowers with. For a matrix of operand families this
// asserts the two halves agree: a closure the selector claims lowers with no
// post-claim withdrawal (and returns node's result), and a closure the
// predicate refuses is refused AT SELECT (legacy body, no post-claim error) —
// on standalone, wasi and gc native-first.

import { WASI } from "node:wasi";
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import {
  additiveOperandsProvable,
  binaryOperandsAdmissible,
  compoundWriteAdmissible,
  incrementSlotAdmissible,
  nullComparisonFolds,
  nullishLeftAdmissible,
  nullValueAdmissible,
  slotWriteVerdict,
  undefinedCompareOperandAdmissible,
  type AdditiveProof,
  type OperandFamily,
} from "../src/ir/analysis/operand-admissibility.js";
import { ts } from "../src/ts-api.js";

const LANES = { standalone: { target: "standalone" }, wasi: { target: "wasi" }, gc: { target: "gc" } } as const;

/** An operand expression the closure `(m, k)` can name, with its proved family. */
interface Producer {
  readonly expr: string;
  readonly family: OperandFamily;
  readonly additive: AdditiveProof;
}
const PRODUCERS: Record<string, Producer> = {
  number: { expr: "n", family: "number", additive: "number" },
  boolean: { expr: "true", family: "boolean", additive: "unprovable" },
  string: { expr: "s", family: "string", additive: "string" },
  dynamic: { expr: "m", family: "dynamic", additive: "dynamic" },
  vec: { expr: "a", family: "vec<number>", additive: "unprovable" },
};
const LOCALS = `var n = 3; var s = "3"; var a = [1];`;

function source(body: string): string {
  return `/** @returns {number} */ function subject() { return 0; }
subject.f = function (m, k) { if (k === 9) return; ${LOCALS} ${body} };
export function run() { var n = 0; try { subject.f(2, 0); } catch (e) { if (e === 2) n += 1; } return n; }`;
}

interface Outcome {
  readonly claimed: boolean;
  readonly postClaimErrors: readonly string[];
  readonly result: CompileResult;
}

async function outcome(body: string, lane: keyof typeof LANES): Promise<Outcome> {
  const result = await compile(source(body), {
    ...LANES[lane],
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    allowJs: true,
    fileName: "probe.js",
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  const init = (result.irOutcomes ?? []).find((entry) => entry.displayName === "<module-init>");
  return {
    claimed: init?.irBodyEmitted === true,
    postClaimErrors: (result.irPostClaimErrors ?? []).map((error) => `${error.func}: ${error.message}`),
    result,
  };
}

async function runInstance(result: CompileResult, lane: "standalone" | "wasi"): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const wasi = lane === "wasi" ? new WASI({ version: "preview1", args: [], env: {} }) : undefined;
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, (wasi?.getImportObject() ?? {}) as WebAssembly.Imports);
  if (wasi) {
    try {
      wasi.initialize(instance);
    } catch {
      // A module without `_initialize` needs no WASI start-up.
    }
  }
  // wasi runs the deferred initializer from `_initialize`.
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

function node(body: string): number {
  return new Function(`"use strict";\n${source(body).replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

/** Selection agrees with the predicate, and a claim never withdraws. */
async function expectAgreement(body: string, admissible: boolean): Promise<void> {
  for (const lane of Object.keys(LANES) as (keyof typeof LANES)[]) {
    const { claimed, postClaimErrors, result } = await outcome(body, lane);
    expect(postClaimErrors, `${lane}: ${body}`).toEqual([]);
    expect(claimed, `${lane}: ${body}`).toBe(admissible);
    if (lane === "gc") expect(result.success, `${lane}: ${body}`).toBe(true);
    else expect(await runInstance(result, lane), `${lane}: ${body}`).toBe(node(body));
  }
}

const OPERATORS: Record<string, ts.SyntaxKind> = {
  "+": ts.SyntaxKind.PlusToken,
  "-": ts.SyntaxKind.MinusToken,
  "|": ts.SyntaxKind.BarToken,
  "<": ts.SyntaxKind.LessThanToken,
  "===": ts.SyntaxKind.EqualsEqualsEqualsToken,
};

describe("#7144 — binary operands: selector ⇔ from-ast", () => {
  for (const [spelling, op] of Object.entries(OPERATORS)) {
    it(`'${spelling}' over every pair of operand families`, async () => {
      for (const left of Object.values(PRODUCERS)) {
        for (const right of Object.values(PRODUCERS)) {
          const admissible =
            (op !== ts.SyntaxKind.PlusToken || additiveOperandsProvable(left.additive, right.additive)) &&
            binaryOperandsAdmissible(op, left.family, right.family);
          await expectAgreement(`var t = ${left.expr} ${spelling} ${right.expr}; throw m;`, admissible);
        }
      }
    }, 240_000);
  }
});

describe("#7144 — writes, increments, `??` and `null` compares: selector ⇔ from-ast", () => {
  it("compound writes into each slot family", async () => {
    const slots: Record<string, [string, OperandFamily]> = {
      number: ["n", "number"],
      string: ["s", "string"],
      dynamic: ["m", "dynamic"],
    };
    for (const [slot, slotFamily] of Object.values(slots)) {
      for (const [spelling, op] of [
        ["+=", ts.SyntaxKind.PlusEqualsToken],
        ["-=", ts.SyntaxKind.MinusEqualsToken],
        // (#7183) the operators `emitNumberBinary` added to the compound set.
        ["%=", ts.SyntaxKind.PercentEqualsToken],
        ["**=", ts.SyntaxKind.AsteriskAsteriskEqualsToken],
        ["|=", ts.SyntaxKind.BarEqualsToken],
      ] as const) {
        for (const value of [PRODUCERS.number!, PRODUCERS.string!, PRODUCERS.boolean!, PRODUCERS.dynamic!]) {
          // `**=` shares `**`'s exact-exponentiation admission (#4787), which
          // excludes module init, so this harness never claims it.
          await expectAgreement(
            `${slot} ${spelling} ${value.expr}; throw m;`,
            op !== ts.SyntaxKind.AsteriskAsteriskEqualsToken && compoundWriteAdmissible(op, slotFamily, value.family),
          );
        }
      }
    }
  }, 240_000);

  it("plain writes into each slot family (and a chained write through a second slot)", async () => {
    for (const [slot, slotFamily] of [
      ["n", "number"],
      ["s", "string"],
      ["m", "dynamic"],
    ] as const) {
      for (const value of [PRODUCERS.number!, PRODUCERS.string!, PRODUCERS.dynamic!]) {
        await expectAgreement(
          `${slot} = ${value.expr}; throw m;`,
          slotWriteVerdict(slotFamily, value.family) === "admissible",
        );
      }
    }
    await expectAgreement(`var u = 1; n = u = 4; throw m;`, true);
    await expectAgreement(`var u; n = u = 4; throw m;`, slotWriteVerdict("number", "dynamic") === "admissible");
  }, 240_000);

  it("increments of each slot family", async () => {
    for (const [slot, family] of [
      ["n", "number"],
      ["m", "dynamic"],
      ["s", "string"],
      ["b", "boolean"],
    ] as const) {
      await expectAgreement(`var b = true; ${slot}++; throw m;`, incrementSlotAdmissible(family));
    }
  }, 120_000);

  it("`??` is refused at select for every left family a planned closure lowers", async () => {
    for (const left of [PRODUCERS.number!, PRODUCERS.string!, PRODUCERS.dynamic!]) {
      expect(nullishLeftAdmissible(left.family)).toBe(false);
      await expectAgreement(`var t = ${left.expr} ?? 1; throw m;`, false);
    }
  }, 120_000);

  it("`=== null` / `== null` fold exactly where `nullComparisonFolds` says", async () => {
    const cases: [string, OperandFamily, ts.SyntaxKind][] = [
      ["n === null", "number", ts.SyntaxKind.EqualsEqualsEqualsToken],
      ["a == null", "vec<number>", ts.SyntaxKind.EqualsEqualsToken],
      ["m === null", "dynamic", ts.SyntaxKind.EqualsEqualsEqualsToken],
      ["m.x == null", "dynamic", ts.SyntaxKind.EqualsEqualsToken],
      ["s === null", "string", ts.SyntaxKind.EqualsEqualsEqualsToken],
    ];
    for (const [compare, family, op] of cases) {
      await expectAgreement(`if (${compare}) throw "n"; throw m;`, nullComparisonFolds(op, family));
    }
    await expectAgreement(`var o = { a: 1 }; var p = o; if (p === null) throw "n"; throw m;`, false);
  }, 120_000);

  it("a bare `null` lowers exactly where `nullValueAdmissible` admits its consumer", async () => {
    const discarded: OperandFamily = "externref";
    const cases: [string, OperandFamily][] = [
      ["null; throw m;", discarded],
      ["void null; throw m;", discarded],
      ["k ? null : 1; throw m;", discarded],
      ["throw (null, m);", discarded],
      ["var t = null; throw m;", "unknown"],
      ['if (null) throw "n"; throw m;', "unknown"],
      ["throw k ? null : m;", "unknown"],
    ];
    for (const [body, consumer] of cases) await expectAgreement(body, nullValueAdmissible(consumer));
  }, 120_000);
  it("a value `void` (the NaN sentinel for `undefined`) is admitted only where ToNumber reads it", async () => {
    // Observed as a value: refused at select (each was an IR-claimed wrong result before #7144 round 2).
    for (const body of [
      'if ((void 0) === (void 0)) throw "y"; throw "nn";',
      'if (void 0 == null) throw "y"; throw "nn";',
      'if (void 0 != null) throw "y"; throw "nn";',
      'm = void 0; if (m === undefined) throw "y"; throw "nn";',
      "m = void 0; throw m;",
      "m = void 0; throw typeof m;",
      'if (k == void 0) throw "y"; throw "nn";',
      // A consumer with no judgement of its own observes the NaN, or needs a box.
      "var t = void 0; throw m;",
      "throw typeof void 0;",
      "throw void 0;",
      "subject(void 0); throw m;",
      // A parenthesised `void` is not the compare's `undefined` operand but its other side.
      'if ((void 0) === undefined) throw m; throw "y";',
    ]) {
      await expectAgreement(body, false);
    }
    expect(binaryOperandsAdmissible(ts.SyntaxKind.EqualsEqualsEqualsToken, "undefined", "undefined")).toBe(false);
    expect(nullComparisonFolds(ts.SyntaxKind.EqualsEqualsToken, "undefined")).toBe(false);
    expect(slotWriteVerdict("dynamic", "undefined")).toBe("inadmissible");
    expect(undefinedCompareOperandAdmissible("undefined")).toBe(false);
    // Read through ToNumber, or strictly compared with `null`: lowered, = node.
    for (const body of [
      'var t = (void 0) - 1; if (t === t) throw "self"; throw m;',
      'if (k < void 0) throw "y"; throw m;',
      'if (void 0 === null) throw "y"; throw m;',
      'if (n == void 0) throw "y"; throw m;',
      // `=== void 0` is the strict undefined compare (TS / Babel emit it for `=== undefined`).
      'if (k === void 0) throw "y"; throw m;',
      'if (m !== void 0) throw m; throw "y";',
      'if (void 0 === void 0) throw m; throw "y";',
      "var u = (k < 1) | 0; throw m;",
    ]) {
      await expectAgreement(body, true);
    }
  }, 240_000);
});
