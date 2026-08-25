// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4681) Exponentiation must evaluate both operand expressions before applying
// ToNumeric to either saved value (§13.15.2).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4681.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#4681 — exponentiation operand evaluation order", () => {
  it("evaluates the right expression before the left valueOf", async () => {
    expect(
      await runStandalone(`
        var trace = 0;
        function left() {
          trace = trace * 10 + 1;
          return { valueOf() { trace = trace * 10 + 3; return 1; } };
        }
        function right() {
          trace = trace * 10 + 2;
          return { valueOf() { trace = trace * 10 + 4; return 1; } };
        }
        export function test() {
          try { left() ** right(); } catch (error) {}
          return trace;
        }
      `),
    ).toBe(1234);
  });

  it("keeps unary RHS evaluation ahead of left ToNumeric", async () => {
    expect(
      await runStandalone(`
        var trace = 0;
        var leftValue = { valueOf() { trace = trace * 10 + 4; return 3; } };
        var rightValue = { valueOf() { trace = trace * 10 + 3; return 2; } };
        export function test() {
          (trace = trace * 10 + 1, leftValue) ** +(trace = trace * 10 + 2, rightValue);
          return trace;
        }
      `),
    ).toBe(1234);
  });

  it("preserves ordinary numeric exponentiation", async () => {
    expect(
      await runStandalone(`
        var base = 2;
        var exponent = 3;
        export function test() { return base ** exponent; }
      `),
    ).toBe(8);
  });
});
