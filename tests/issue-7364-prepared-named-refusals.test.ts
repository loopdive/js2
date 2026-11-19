// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7364 — constructs the Prepared path has no provider for refuse by name at the build stage instead of throwing
// an invariant out of `compile()`. The Prepared producer has no selector, so the builder meets the selector's own
// rule where the value is built: a RegExp literal on a lane with neither the host constructor nor its in-module
// engine, and an `Object.defineProperty` the `Object` statics table did not admit.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeSource } from "../src/checker/index.js";
import { compile as compileOrdinary } from "../src/index.js";
import { lowerFunctionAstToIr, planIrCompilation } from "../src/ir/index.js";
import { IrInvariantError, IrUnsupportedError } from "../src/ir/outcomes.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

describe("#7364 — Prepared-path refusals instead of invariant crashes", () => {
  it.each([
    ["a literal's .exec", 'var m = /a/.exec("a");'],
    ["a literal's .test in a function", 'function f() { return /a/.test("a"); }\nf();'],
    ["a literal's .source", "var s = /a/.source;"],
    ["a discarded literal", "/a/;"],
    ["a literal bound to a var", "var r = /a/;"],
  ])("refuses a RegExp literal without a provider: %s", async (_label, source) => {
    const result = await compile(source, options());
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([
      ["regexp-constructor-unsupported", expect.stringContaining("RegExp literal has no provider")],
    ]);
  });

  it("refuses an unadmitted Object.defineProperty by the selector's code", async () => {
    // (#7368) The table admits an inline descriptor on the Prepared path; one held in a variable it refuses.
    const source = 'function f() { var o = {}; var d = { value: 1 }; Object.defineProperty(o, "x", d); }\nf();';
    const result = await compile(source, options());
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([
      [
        "call-resolution-unsupported",
        expect.stringContaining("Object.defineProperty is not an admitted Object static"),
      ],
    ]);
  });
});

// The selector and from-ast ask one rule (`regexp-literal-admission.ts`), so no ordinary lane claims a RegExp unit and
// then withdraws it: the host-free lanes build it in-module, and the linear lane, which answers no RegExp capability,
// never claims it.
describe("#7364 — the ordinary pipeline claims no RegExp unit it then withdraws", () => {
  const source = "export function f(s: string): boolean { return /a/.test(s); }";

  it.each([
    ["default", {}],
    ["standalone", { target: "standalone" as const }],
  ])("%s: the unit is emitted by the IR", async (_label, target) => {
    const result = await compileOrdinary(source, { fileName: "t.ts", trackIrOutcomes: true, ...target });
    expect(result.success).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "f")?.stage).toBe("patch");
  });

  // The linear lane answers no RegExp capability. Under the old reading (an absent answer is "host available") the
  // selector claimed `f` and from-ast then threw or withdrew it; now the refusal is at select, by name.
  it("linear: the selector refuses it at select, by name", () => {
    const ast = analyzeSource(source);
    const selection = planIrCompilation(ast.sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      backendTargetProfile: { backend: "linear" },
    });
    expect([...selection.funcs]).toEqual([]);
    expect(selection.fallbacks).toEqual([{ name: "f", reason: "regexp-constructor-unsupported" }]);
  });

  it("linear: no IR build error is reported", async () => {
    const result = await compileOrdinary(source, { fileName: "t.ts", target: "linear", trackIrOutcomes: true });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.errors.map((error) => error.message).join("\n")).not.toContain("linear-ir: IR build");
  });
});

// After a selector's claim an unadmitted define reaching the builder is a drift; without a selector it is refused.
describe("#7364 — an unadmitted Object.defineProperty at the builder", () => {
  const lower = (unselected: boolean) => {
    const ast = analyzeSource('function f(n: number): void { Object.defineProperty(n, "x", { value: 1 }); }');
    const fn = ast.sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const identities = createTestIrFunctionIdentityFactory();
    return () =>
      lowerFunctionAstToIr(fn, {
        ownerUnitId: identities.next("f").unitId,
        ...(unselected ? { unselected: true } : {}),
      });
  };

  it("is an invariant after a selector's claim", () => {
    expect(lower(false)).toThrow(IrInvariantError);
  });

  it("is a named refusal on a producer without a selector", () => {
    expect(lower(true)).toThrow(IrUnsupportedError);
    expect(lower(true)).toThrow("Object.defineProperty is not an admitted Object static");
  });
});
