// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildIrLegacyUnitProjection,
  createIrSourceId,
  createIrUnitId,
  IrLegacyUnitProjectionInvariantError,
  type IrLegacyUnitProjectionEntry,
  type IrLegacyUnitProjectionInvariantCode,
  type IrUnitId,
} from "../src/ir/index.js";

const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "entry.ts" });
const unitId = (ordinal: number): IrUnitId =>
  createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal });

function expectProjectionInvariant(
  run: () => unknown,
  code: IrLegacyUnitProjectionInvariantCode,
  message: string,
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrLegacyUnitProjectionInvariantError);
  expect(caught).toMatchObject({ code, message });
}

function projectionError(run: () => unknown): IrLegacyUnitProjectionInvariantError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IrLegacyUnitProjectionInvariantError);
    return error as IrLegacyUnitProjectionInvariantError;
  }
  throw new Error("expected an IR legacy unit projection invariant");
}

describe("#3520 legacy unit compatibility projection", () => {
  it("round-trips exact unit/name pairs without normalizing legacy labels", () => {
    const first = unitId(0);
    const second = unitId(1);
    const projection = buildIrLegacyUnitProjection([
      { unitId: second, legacyName: " runtime/property::x " },
      { unitId: first, legacyName: "<module-init>" },
    ]);

    expect(projection.entries).toEqual([
      { unitId: first, legacyName: "<module-init>" },
      { unitId: second, legacyName: " runtime/property::x " },
    ]);

    const firstPair = projection.requireUnit(first);
    expect(firstPair).toEqual({ unitId: first, legacyName: "<module-init>" });
    expect(projection.getByUnitId(first)).toBe(firstPair);
    expect(projection.getByLegacyName("<module-init>")).toBe(firstPair);
    expect(projection.requireLegacyName("<module-init>")).toBe(firstPair);
    expect(projection.requirePair(firstPair)).toBe(firstPair);
  });

  it("canonicalizes projection and map iteration independently of input order", () => {
    const entries: IrLegacyUnitProjectionEntry[] = [
      { unitId: unitId(2), legacyName: "third" },
      { unitId: unitId(0), legacyName: "first" },
      { unitId: unitId(1), legacyName: "second" },
    ];
    const forward = buildIrLegacyUnitProjection(entries);
    const reversed = buildIrLegacyUnitProjection([...entries].reverse());

    expect(reversed.entries).toEqual(forward.entries);
    expect(forward.entries.map((entry) => entry.unitId)).toEqual([unitId(0), unitId(1), unitId(2)]);
    for (const entry of forward.entries) {
      expect(reversed.getByUnitId(entry.unitId)).toEqual(entry);
      expect(reversed.getByLegacyName(entry.legacyName)).toEqual(entry);
    }
  });

  it("keeps entries, projections, and completed result maps runtime immutable", () => {
    const first = unitId(0);
    const projection = buildIrLegacyUnitProjection([{ unitId: first, legacyName: "first" }]);

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.entries)).toBe(true);
    expect(Object.isFrozen(projection.entries[0])).toBe(true);
    expect(() =>
      (projection.entries as IrLegacyUnitProjectionEntry[]).push({ unitId: unitId(1), legacyName: "second" }),
    ).toThrow(TypeError);
    expect(() => {
      (projection.entries[0] as { legacyName: string }).legacyName = "changed";
    }).toThrow(TypeError);
    expect("legacyNameByUnitId" in projection).toBe(false);
    expect("unitIdByLegacyName" in projection).toBe(false);

    const correlation = projection.startResultCorrelation<number>();
    const result = correlation.consume({ unitId: first, legacyName: "first", result: 1 });
    const completed = correlation.complete();
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => (completed as Map<IrUnitId, typeof result>).set(first, result)).toThrow(TypeError);
  });

  it("rejects duplicate unit IDs before constructing either direction", () => {
    const first = unitId(0);
    expectProjectionInvariant(
      () =>
        buildIrLegacyUnitProjection([
          { unitId: first, legacyName: "alpha" },
          { unitId: first, legacyName: "beta" },
        ]),
      "duplicate-unit-id",
      `unit ${first} occurs more than once in the legacy unit projection`,
    );
  });

  it("rejects a same-name collision across distinct structural units without first/last wins", () => {
    const first = unitId(0);
    const second = unitId(1);
    const entries = [
      { unitId: second, legacyName: "same" },
      { unitId: first, legacyName: "same" },
    ] as const;
    const expected = `legacy name "same" maps to both ${first} and ${second}`;

    expectProjectionInvariant(() => buildIrLegacyUnitProjection(entries), "duplicate-legacy-name", expected);
    expectProjectionInvariant(
      () => buildIrLegacyUnitProjection([...entries].reverse()),
      "duplicate-legacy-name",
      expected,
    );
  });

  it("rejects empty and non-string legacy labels while preserving non-empty whitespace", () => {
    const first = unitId(0);
    const invalidMessage = "legacy unit projection names must be non-empty strings";
    expectProjectionInvariant(
      () => buildIrLegacyUnitProjection([{ unitId: first, legacyName: "" }]),
      "invalid-legacy-name",
      invalidMessage,
    );
    expectProjectionInvariant(
      () => buildIrLegacyUnitProjection([{ unitId: first, legacyName: 42 as unknown as string }]),
      "invalid-legacy-name",
      invalidMessage,
    );
    expect(buildIrLegacyUnitProjection([{ unitId: first, legacyName: "   " }]).requireUnit(first).legacyName).toBe(
      "   ",
    );
  });

  it("returns complete optional membership pairs and distinguishes exact lookup failures", () => {
    const first = unitId(0);
    const second = unitId(1);
    const foreign = unitId(2);
    const projection = buildIrLegacyUnitProjection([
      { unitId: first, legacyName: "first" },
      { unitId: second, legacyName: "second" },
    ]);

    expect(projection.getByUnitId(foreign)).toBeUndefined();
    expect(projection.getByLegacyName("foreign")).toBeUndefined();

    expectProjectionInvariant(
      () => projection.requireUnit(foreign),
      "missing-unit",
      `unit ${foreign} has no legacy unit projection`,
    );
    expectProjectionInvariant(
      () => projection.requireLegacyName("foreign"),
      "missing-legacy-name",
      'legacy name "foreign" has no structural unit projection',
    );
    expectProjectionInvariant(
      () => projection.requirePair({ unitId: first, legacyName: "foreign" }),
      "missing-legacy-name",
      'legacy name "foreign" has no structural unit projection',
    );
    expectProjectionInvariant(
      () => projection.requirePair({ unitId: foreign, legacyName: "first" }),
      "missing-unit",
      `unit ${foreign} has no legacy unit projection`,
    );
    expectProjectionInvariant(
      () => projection.requirePair({ unitId: first, legacyName: "second" }),
      "mismatched-pair",
      `unit ${first} and legacy name "second" are not one projection pair`,
    );
  });

  it("consumes typed named results exactly once and completes in structural order", () => {
    const first = unitId(0);
    const second = unitId(1);
    const projection = buildIrLegacyUnitProjection([
      { unitId: second, legacyName: "second" },
      { unitId: first, legacyName: "first" },
    ]);
    const correlation = projection.startResultCorrelation<{ status: string }>();

    expect(correlation.consume({ unitId: second, legacyName: "second", result: { status: "two" } })).toEqual({
      unitId: second,
      legacyName: "second",
      result: { status: "two" },
    });
    expect(correlation.consume({ unitId: first, legacyName: "first", result: { status: "one" } })).toEqual({
      unitId: first,
      legacyName: "first",
      result: { status: "one" },
    });

    const completed = correlation.complete();
    expect([...completed].map(([id, event]) => [id, event.legacyName, event.result.status])).toEqual([
      [first, "first", "one"],
      [second, "second", "two"],
    ]);
    expect(correlation.complete()).toBe(completed);
  });

  it("rejects duplicate and foreign named-result evidence", () => {
    const first = unitId(0);
    const foreign = unitId(1);
    const projection = buildIrLegacyUnitProjection([{ unitId: first, legacyName: "first" }]);
    const duplicate = projection.startResultCorrelation<number>();
    duplicate.consume({ unitId: first, legacyName: "first", result: 1 });

    expectProjectionInvariant(
      () => duplicate.consume({ unitId: first, legacyName: "first", result: 2 }),
      "duplicate-result-correlation",
      `legacy result "first" was correlated more than once for unit ${first}`,
    );

    const foreignCorrelation = projection.startResultCorrelation<number>();
    expectProjectionInvariant(
      () => foreignCorrelation.consume({ unitId: foreign, legacyName: "first", result: 1 }),
      "foreign-result-correlation",
      `legacy result ${foreign} / "first" does not belong to this projection`,
    );
    expectProjectionInvariant(
      () => foreignCorrelation.consume({ unitId: first, legacyName: "foreign", result: 1 }),
      "foreign-result-correlation",
      `legacy result ${first} / "foreign" does not belong to this projection`,
    );
  });

  it("reports every unconsumed result pair in deterministic structural order", () => {
    const first = unitId(0);
    const second = unitId(1);
    const third = unitId(2);
    const entries = [
      { unitId: third, legacyName: "third" },
      { unitId: first, legacyName: "first" },
      { unitId: second, legacyName: "second" },
    ] as const;
    const expected = `legacy results were not correlated for ${first} / "first", ` + `${third} / "third"`;
    const incompleteMessage = (input: readonly IrLegacyUnitProjectionEntry[]): string => {
      const correlation = buildIrLegacyUnitProjection(input).startResultCorrelation<number>();
      correlation.consume({ unitId: second, legacyName: "second", result: 2 });
      const error = projectionError(() => correlation.complete());
      expect(error.code).toBe("unconsumed-result-correlation");
      return error.message;
    };

    expect(incompleteMessage(entries)).toBe(expected);
    expect(incompleteMessage([...entries].reverse())).toBe(expected);
  });
});
