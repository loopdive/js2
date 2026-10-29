// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7143 B1 — pins the blocker census in `scripts/legacy-reach-blockers.mjs`.
 *
 * The fixture relies on the selector rejecting a bare `{ }` statement
 * (`nontail-unhandled-stmt:Block`) and accepting `0;`. If the IR learns to
 * claim an empty block, `one`/`two` claim on the first compile and the
 * expectations below drop — rewrite the fixture around another rejected shape.
 */
import { describe, expect, it } from "vitest";

// The reject-arm detail is latched when `src/ir/select.ts` loads.
process.env.JS2WASM_IR_SHAPE_DIAG = "1";
const { measureEntry } = await import("../scripts/measure-legacy-reach.mjs");
const { blockerLabel, peelBlocker, rankBlockers } = await import("../scripts/legacy-reach-blockers.mjs");
const { ts } = await import("../src/ts-api.js");

const SOURCE = `export function one(a: number): number {
  let x = a;
  { }
  return x;
}
export function two(a: number): number {
  let x = a;
  { }
  x = x + 1;
  { }
  return x;
}
export function ok(a: number): number {
  return a + 1;
}
`;
const entry = { id: "inline:blockers.ts", family: "files", fileName: "blockers.ts", source: SOURCE };

describe("#7143 legacy-reach blocker census", () => {
  it("peels each blocker until the unit claims and ranks the labels", async () => {
    const { rows, failures } = await measureEntry(entry, ["standalone"], 4);
    expect(failures).toEqual([]);
    const demoted = rows.filter((r) => r.demoted).map((r) => [r.unit, r.reason, r.blockers, r.peel]);
    expect(demoted).toEqual([
      ["function:one@1", "body-shape-rejected", ["nontail-unhandled-stmt:Block"], "claimed"],
      [
        "function:two@6",
        "body-shape-rejected",
        ["nontail-unhandled-stmt:Block", "nontail-unhandled-stmt:Block"],
        "claimed",
      ],
    ]);
    const census = rankBlockers(rows);
    expect(census.multiplicity).toEqual({ one: 1, two: 1, threePlus: 0, open: 0 });
    expect(census.ranked).toEqual([{ label: "nontail-unhandled-stmt:Block", first: 2, only: 2, anywhere: 2 }]);
  });

  it("does not peel without the diagnostic detail, through a declaration, or a returning tail", () => {
    const sf = ts.createSourceFile("t.ts", SOURCE, ts.ScriptTarget.Latest, true);
    const one = sf.statements[0] as import("typescript").FunctionDeclaration;
    const row = (detail: string) => ({ reason: "body-shape-rejected", stage: "select", detail });
    expect(peelBlocker(SOURCE, sf, [one], { reason: "body-shape-rejected", stage: "build", detail: "x" })).toEqual({
      refused: "no-arm-build",
    });
    expect(peelBlocker(SOURCE, sf, [one], row("arm:VariableStatement «let x = a;»"))).toEqual({
      refused: "declaration:VariableStatement",
    });
    expect(peelBlocker(SOURCE, sf, [one], row("arm:ReturnStatement «return x;»"))).toEqual({
      refused: "tail:ReturnStatement",
    });
    const peeled = peelBlocker(SOURCE, sf, [one], row("nontail-unhandled-stmt:Block «{ }»"));
    expect(peeled.source).toHaveLength(SOURCE.length);
    expect(peeled.source.split("\n")[2]).toBe("  0; ");
  });

  it("labels build-stage details without unit-specific names", () => {
    expect(
      blockerLabel({
        reason: "body-shape-rejected",
        stage: "build",
        detail: "ir/from-ast: delete has no IR lowering in f",
      }),
    ).toBe("build:delete has no IR lowering");
    expect(blockerLabel({ reason: "class-member-unsupported", detail: "C_m rejected by IR selection (x)" })).toBe(
      "class-member-unsupported:no-detail",
    );
  });
});
