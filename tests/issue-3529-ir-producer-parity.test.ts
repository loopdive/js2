// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";

function terminal(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

describe("#3529 — typed AST-to-IR producer capability gaps", () => {
  it("preserves inferred boolean identity across an externref console boundary", async () => {
    const result = await compile(
      `function isEven(n) {
        return n === 0 ? true : isOdd(n - 1);
      }
      function isOdd(n) {
        return n === 0 ? false : isEven(n - 1);
      }
      console.log(isEven(10));
      console.log(isOdd(7));`,
      {
        fileName: "mutual-recursion.js",
        experimentalIR: true,
        trackIrOutcomes: true,
        deferTopLevelInit: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result).find((outcome) => outcome.displayName === "<module-init>")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(result.wat).toContain("__box_boolean");
  });

  it("types array-literal widening as an unsupported representation", async () => {
    const result = await compile(
      `export function test(): number {
        const [a, b, c] = [1, 2, 3];
        return a + b + c;
      }`,
      { fileName: "array-representation.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "test",
        kind: "unsupported",
        code: "array-representation-unsupported",
        stage: "build",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      }),
    ]);
  });

  it("types mixed string/boolean addition as unsupported operand coercion", async () => {
    const result = await compile(
      `export function test(): string {
        return "result: " + (2 > 1);
      }`,
      { fileName: "operand-coercion.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result).find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "unsupported",
      code: "operand-coercion-unsupported",
      stage: "build",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });
});
