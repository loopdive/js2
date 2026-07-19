// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3373 — Annex B.3.9 Runtime Errors for Function Call Assignment Targets.
 *
 * AssignmentTargetType classifies a CallExpression in non-strict code as
 * web-compat. Evaluation must call the target and then throw ReferenceError
 * before GetValue/ToNumeric, RHS evaluation, or PutValue. For-in/of evaluate
 * the target only after producing the first key/value.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runNumber(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-3373.js", allowJs: true });
  if (!result.success) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  const imports: any = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  return (instance.exports.test as () => number)();
}

function runtimeProbe(expression: string): string {
  return `
    let calls = 0;
    let coercions = 0;
    let rhsCalls = 0;
    function target() {
      calls++;
      return { valueOf() { coercions++; return 1; } };
    }
    function rhs() { rhsCalls++; return 1; }
    export function test() {
      let isReferenceError = false;
      try { ${expression} } catch (error) {
        isReferenceError = error instanceof ReferenceError;
      }
      return (isReferenceError ? 1000 : 0) + calls * 100 + coercions * 10 + rhsCalls;
    }
  `;
}

describe("#3373 Annex B call-expression assignment targets", () => {
  it("simple assignment evaluates only the call target before ReferenceError", async () => {
    expect(await runNumber(runtimeProbe("target() = rhs();"))).toBe(1100);
  });

  it("compound assignment throws before GetValue and the RHS", async () => {
    expect(await runNumber(runtimeProbe("target() += rhs();"))).toBe(1100);
  });

  it("postfix update throws before ToNumeric", async () => {
    expect(await runNumber(runtimeProbe("target()++;"))).toBe(1100);
  });

  it("prefix update throws before ToNumeric", async () => {
    expect(await runNumber(runtimeProbe("++target();"))).toBe(1100);
  });

  it("for-in evaluates the call target after producing the first key", async () => {
    expect(await runNumber(runtimeProbe("for (target() in [1]) {}"))).toBe(1100);
  });

  it("for-of evaluates the call target after producing the first value", async () => {
    expect(await runNumber(runtimeProbe("for (target() of [1]) {}"))).toBe(1100);
  });

  it("the CoverCallExpressionAndAsyncArrowHead spelling uses the same path", async () => {
    expect(
      await runNumber(`
        let calls = 0;
        function async() { calls++; }
        export function test() {
          let caught = false;
          try { async() = 1; } catch (error) { caught = error instanceof ReferenceError; }
          return (caught ? 10 : 0) + calls;
        }
      `),
    ).toBe(11);
  });

  it("strict-mode call targets remain early SyntaxErrors", async () => {
    const result = await compile(
      `
      function target() {}
      function strict() { "use strict"; target() = 1; }
      export function test() { return 1; }
    `,
      { fileName: "issue-3373.js", allowJs: true },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Invalid left-hand side"))).toBe(true);
  });

  it("logical assignments are not covered by Annex B.3.9", async () => {
    const result = await compile(
      `
      function target() {}
      export function test() { target() ||= 1; return 1; }
    `,
      { fileName: "issue-3373.js", allowJs: true },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Invalid left-hand side"))).toBe(true);
  });
});
