// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7375 — a numeric compound assignment whose right-hand side is a boolean or a string reads it with ToNumber, as
// the binary form does (`x *= "1"` is `x = x * "1"`). The lane says so through the backend capability
// `native-dynamic-to-number` (host-free standalone only), which the one table `compoundWriteAdmissible`, the
// ordinary selector and the Prepared resolver all ask; the JS environment's output does not move.
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile as compileOrdinary } from "../src/index.js";
import { compoundWriteAdmissible } from "../src/ir/analysis/operand-admissibility.js";
import { supportsIrBackendTargetCapability, type IrBackendTargetProfile } from "../src/ir/backend/legality.js";
import { runPreparedScript } from "./helpers/prepared-script-run.js";

afterEach(() => vi.restoreAllMocks());

function nodeVerdict(source: string): "returned" | "threw" {
  try {
    runInNewContext(source);
    return "returned";
  } catch {
    return "threw";
  }
}

/** Each operator with node's answer for a string and a boolean right-hand side, from `x = 7`. */
const OPERATORS: readonly (readonly [string, number, number])[] = [
  ["*=", 21, 7],
  ["/=", 7 / 3, 7],
  ["%=", 1, 0],
  ["-=", 4, 6],
  ["<<=", 56, 14],
  [">>=", 0, 3],
  [">>>=", 0, 3],
  ["&=", 3, 1],
  ["^=", 4, 6],
  ["|=", 7, 7],
];

describe("#7375 — a numeric compound reads a boolean or string right-hand side with ToNumber", () => {
  it.each(
    OPERATORS.flatMap(([op, withString, withTrue]) => [
      [`${op} "3" into a dynamic var`, `var x; x = 7; x ${op} "3";`, `x !== ${withString}`, `x === ${withString}`],
      [`${op} true into a dynamic var`, `var x; x = 7; x ${op} true;`, `x !== ${withTrue}`, `x === ${withTrue}`],
      [
        `${op} "3" in a function`,
        `function f() { var x; x = 7; x ${op} "3"; return x; } var r = f();`,
        `r !== ${withString}`,
        `r === ${withString}`,
      ],
    ]),
  )("%s", async (_, program, holds, fails) => {
    for (const [check, verdict] of [
      [holds, "returned"],
      [fails, "threw"],
    ] as const) {
      const source = `${program} if (${check}) throw 1;`;
      expect(nodeVerdict(source), source).toBe(verdict);
      expect(await runPreparedScript(source), source).toBe(verdict);
    }
  });

  it.each([
    ["a string beside a boolean slot", 'var x; x = true; x *= "1";', "x !== 1", "x !== 0"],
    ["a non-numeric string (NaN)", 'var x; x = 5; x -= "abc";', "x === x", "x !== x"],
    ["the issue's boolean probe", "var x; x = true; x *= true;", "x !== 1", "x !== 0"],
    ["the issue's string probe", 'var x; x = "1"; x *= "1";', "x !== 1", "x !== 0"],
  ])("%s", async (_, program, holds, fails) => {
    expect(await runPreparedScript(`${program} if (${holds}) throw 1;`)).toBe("returned");
    expect(await runPreparedScript(`${program} if (${fails}) throw 1;`)).toBe("threw");
  });

  // Main carries this since the plan was written: a typed number slot now has a dynamic carrier to box the string into.
  it.each([["a string into a typed number slot", 'var x = 2; x *= "3";', "x !== 6", "x !== 7"]])(
    "%s",
    async (_, program, holds, fails) => {
      for (const [check, verdict] of [
        [holds, "returned"],
        [fails, "threw"],
      ] as const) {
        const source = `${program} if (${check}) throw 1;`;
        expect(nodeVerdict(source), source).toBe(verdict);
        expect(await runPreparedScript(source), source).toBe(verdict);
      }
    },
  );

  it("asks the lane's capability in the one table", () => {
    const op = ts.SyntaxKind.AsteriskEqualsToken;
    for (const value of ["string", "boolean"] as const) {
      expect(compoundWriteAdmissible(op, "dynamic", value, false)).toBe(false);
      expect(compoundWriteAdmissible(op, "dynamic", value, true)).toBe(true);
      expect(compoundWriteAdmissible(op, "number", value, true)).toBe(true);
      expect(compoundWriteAdmissible(ts.SyntaxKind.AsteriskAsteriskEqualsToken, "dynamic", value, true)).toBe(false);
    }
    // `n += "3"` concatenates: a string right-hand side of `+=` is never read with ToNumber.
    expect(compoundWriteAdmissible(ts.SyntaxKind.PlusEqualsToken, "number", "string", true)).toBe(false);
  });

  it("holds the capability on host-free standalone only", () => {
    const profile = (overrides: Partial<IrBackendTargetProfile>): IrBackendTargetProfile => ({
      backend: "wasmgc",
      target: "standalone",
      allowHostImports: false,
      ...overrides,
    });
    expect(supportsIrBackendTargetCapability(profile({}), "native-dynamic-to-number")).toBe(true);
    expect(supportsIrBackendTargetCapability(profile({ nativeRegimeInJs: true }), "native-dynamic-to-number")).toBe(
      false,
    );
    expect(
      supportsIrBackendTargetCapability(profile({ target: "gc", allowHostImports: true }), "native-dynamic-to-number"),
    ).toBe(false);
  });

  // The ordinary selector asks the same table: standalone claims the module-init, the JS environment does not.
  it.each([
    ["standalone", true],
    ["the JS environment", false],
  ] as const)('the ordinary pipeline on %s claims `x *= "1"`: %s', async (target, claims) => {
    const result = await compileOrdinary('var x; x = "1"; x *= "1"; if (x !== 1) throw "bad";', {
      fileName: "test.js",
      allowJs: true,
      trackIrOutcomes: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
    expect(result.success).toBe(true);
    expect(result.irOutcomes?.some((outcome) => outcome.irBodyEmitted)).toBe(claims);
  });
});
