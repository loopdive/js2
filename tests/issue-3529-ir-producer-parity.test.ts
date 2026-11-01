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
    // The *identity* claim this test exists for is unchanged and still asserted
    // below: the inferred boolean survives the externref console boundary as a
    // boxed boolean, not a number. What rotted is the routing pin. Since
    // `100543f4e7` (refactor(#4514), 2026-08-16, "directional reverse-callers
    // edge restores compile-once for ABI-certified callees") the untyped
    // `isEven`/`isOdd` pair demotes at IR *selection* with
    // `operand-coercion-unsupported`, which cascades `call-graph-closure` onto
    // `<module-init>`; the legacy body carries the program instead. Pin that
    // truthfully — `legacyBodyEmitted: true` still fails if nothing is emitted
    // at all, and a return to IR emission will fail here and be re-examined.
    // (2026-11-01, re-pinned in #7066) On main `<module-init>` now stops first on
    // its host `console.log` surface (`host-surface-unavailable`), still at
    // selection and still on the legacy body.
    expect(terminal(result).find((outcome) => outcome.displayName === "<module-init>")).toMatchObject({
      kind: "unsupported",
      code: "host-surface-unavailable",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    for (const name of ["isEven", "isOdd"]) {
      expect(terminal(result).find((outcome) => outcome.displayName === name)).toMatchObject({
        kind: "unsupported",
        code: "operand-coercion-unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    expect(result.wat).toContain("__box_boolean");
  });

  // #7024 decomposes a fresh array literal (`literal-pattern-plan.ts`), so this
  // source no longer reaches the vec reader that refused the widened literal.
  it("lowers a destructured array literal through the literal pattern plan", async () => {
    const result = await compile(
      `export function test(): number {
        const [a, b, c] = [1, 2, 3];
        return a + b + c;
      }`,
      { fileName: "array-representation.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // `22a72e500a` (feat(3523) R4 gap 4, 2026-08-31, "record a truthful
    // non-executable module-init outcome row") stopped leaving a source with an
    // empty module-init population silent, so the ledger now carries a second
    // row. Keep the exhaustive `toEqual`, so an unexpected third outcome shows.
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "test",
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      }),
      expect.objectContaining({
        displayName: "<module-init>",
        unitKind: "module-init",
        kind: "non-executable",
        stage: "select",
        legacyBodyEmitted: false,
        irBodyEmitted: false,
      }),
    ]);
  });

  it("lowers mixed string/boolean addition as a concatenation (#7066)", async () => {
    const result = await compile(
      `export function test(): string {
        return "result: " + (2 > 1);
      }`,
      { fileName: "operand-coercion.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(terminal(result).find((outcome) => outcome.displayName === "test")).toMatchObject({
      irBodyEmitted: true,
    });
  });
});
