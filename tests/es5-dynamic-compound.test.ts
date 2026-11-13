// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import ts from "typescript";
import { compoundWriteAdmissible } from "../src/ir/analysis/operand-admissibility.js";
import { compile } from "../src/index.js";
// IR-overlay runtime controls; not whole-program Test262 qualification.
for (const strict of [false, true])
  for (const [op, expected, initial] of [
    ["^=", 4, "5"],
    ["<<=", 10, "5"],
    ["%=", 0, "5"],
    ["-=", 4, "5"],
    ["*=", 5, "5"],
    ["/=", 5, "5"],
    ["|=", 5, "5"],
    ["&=", 1, "5"],
    [">>=", 2, "5"],
    [">>>=", 2, "5"],
    ["-=", 4, '"5"'],
    ["-=", 0, "true"],
    ["-=", "NaN", "undefined"],
    ["-=", "NaN", "void-rhs"],
  ] as const) {
    it(`lowers script dynamic ${initial} ${op} (${strict ? "strict" : "sloppy"})`, async () => {
      const result = await compile(
        `${strict ? '"use strict";' : ""}var x; x = ${initial === "void-rhs" ? "5" : initial}; var calls = 0; function rhs() { calls = calls + 1; x = 100; return 1; } x ${op} ${initial === "void-rhs" ? "void rhs()" : "rhs()"}; if (${expected === "NaN" ? "x === x" : `x !== ${expected}`}) throw "wrong result or LHS read too late"; if (calls !== 1) throw "RHS evaluation count";`,
        {
          fileName: "compound.js",
          allowJs: true,
          target: "standalone",
          trackIrOutcomes: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const init = result.irOutcomes?.find((o) => o.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      (instance.exports.__module_init as () => void)();
    });
  }

it("keeps dynamic exponentiation outside this ES5 admission", () => {
  for (const rhs of ["number", "dynamic", "undefined"] as const)
    expect(compoundWriteAdmissible(ts.SyntaxKind.AsteriskAsteriskEqualsToken, "dynamic", rhs)).toBe(false);
});

// The selector asks the builder's operand rule, so an RHS with no numeric carrier
// is refused at selection instead of claimed and withdrawn.
for (const [op, rhs] of [
  ["-=", '"2"'],
  ["*=", "true"],
  ["-=", "null"],
  ["-=", "fs()"],
  ["<<=", "fs()"],
  ["-=", '"a" + "b"'],
  ["<<=", '"a" + "b"'],
  ["-=", '(0, "2")'],
  ["-=", '"ab".charAt(0)'],
  ["<<=", '"ab".charAt(0)'],
  ["-=", "String(n)"],
] as const)
  it(`refuses script dynamic ${op} ${rhs} at selection`, async () => {
    const result = await compile(`function fs() { return "2"; } var n; n = 3; var y; y = 1; y ${op} ${rhs};`, {
      fileName: "compound-refusal.js",
      allowJs: true,
      target: "standalone",
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irPostClaimErrors).toEqual([]);
    const init = result.irOutcomes?.find((o) => o.displayName === "<module-init>");
    expect(init?.stage, JSON.stringify(init)).toBe("select");
    expect(init?.detail).toContain("rejected by IR selection");
    expect(init?.irBodyEmitted).toBe(false);
  });
