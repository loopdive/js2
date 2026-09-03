// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { inventoryBuilds, planningContextBuilds } = vi.hoisted(() => ({
  inventoryBuilds: vi.fn<(sourceFiles: readonly string[], inventory: unknown) => void>(),
  planningContextBuilds: vi.fn<(inventory: unknown) => void>(),
}));

vi.mock("../src/ir/identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/identity.js")>();
  return {
    ...actual,
    buildIrUnitInventory(
      sourceFiles: Parameters<typeof actual.buildIrUnitInventory>[0],
      options?: Parameters<typeof actual.buildIrUnitInventory>[1],
    ) {
      const inventory = actual.buildIrUnitInventory(sourceFiles, options);
      inventoryBuilds(
        sourceFiles.map((sourceFile) => sourceFile.fileName),
        inventory,
      );
      return inventory;
    },
  };
});

vi.mock("../src/ir/planning-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/planning-identity.js")>();
  return {
    ...actual,
    buildIrPlanningIdentityContext(inventory: Parameters<typeof actual.buildIrPlanningIdentityContext>[0]) {
      planningContextBuilds(inventory);
      return actual.buildIrPlanningIdentityContext(inventory);
    },
  };
});

import { compile, compileMulti } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { type IrObservedOutcome, nonExecutableOutcomeDefect } from "../src/ir/outcomes.js";

/**
 * (#3523 R4 gap 4) The ownership projection of an outcome ledger. A
 * `non-executable` row is OBSERVATIONAL: it records that a source's module init
 * has nothing to compile, carries `sourceId` and deliberately no `unitId`, and
 * mints no terminal unit. `scripts/check-ir-only.ts:403-416` draws the same
 * partition; these helpers let the ledger expectations below keep their
 * original shape while stating the observational rows separately.
 */
function ownershipOutcomes(outcomes: readonly IrObservedOutcome[] | undefined): readonly IrObservedOutcome[] {
  return (outcomes ?? []).filter((outcome) => outcome.kind !== "non-executable");
}

function observationalOutcomes(outcomes: readonly IrObservedOutcome[] | undefined): readonly IrObservedOutcome[] {
  return (outcomes ?? []).filter((outcome) => outcome.kind === "non-executable");
}

/**
 * The positive half of the filter: a row excluded from an ownership expectation
 * must still be restricted by construction, so that the widening cannot be
 * satisfied by a malformed observational row.
 */
function expectWellFormedObservationalRows(outcomes: readonly IrObservedOutcome[] | undefined): void {
  for (const outcome of observationalOutcomes(outcomes)) {
    expect(outcome.unitId, `${outcome.key} observational unit id`).toBeUndefined();
    expect(outcome.unitKind, `${outcome.key} observational unit kind`).toBe("module-init");
    expect(nonExecutableOutcomeDefect(outcome), outcome.key).toBeUndefined();
  }
}

function expectOneInventory(...expectedFiles: readonly string[]): void {
  expect(inventoryBuilds).toHaveBeenCalledTimes(1);
  const sourceFiles = inventoryBuilds.mock.calls[0]?.[0] ?? [];
  expect(sourceFiles).toHaveLength(expectedFiles.length);
  for (const expectedFile of expectedFiles) {
    expect(sourceFiles.some((sourceFile) => sourceFile.endsWith(expectedFile))).toBe(true);
  }
  expect(planningContextBuilds).toHaveBeenCalledTimes(1);
  expect(planningContextBuilds.mock.calls[0]?.[0]).toBe(inventoryBuilds.mock.calls[0]?.[1]);
}

beforeEach(() => {
  inventoryBuilds.mockClear();
  planningContextBuilds.mockClear();
});

describe("#3520 authoritative production planning context", () => {
  it("preserves tracking-only inventory behavior when the overlay is disabled", async () => {
    const source = `export function direct(value: number): number { return value + 1; }`;
    const untracked = await compile(source, {
      fileName: "issue-3520-tracking-only.ts",
      experimentalIR: false,
    });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(inventoryBuilds).not.toHaveBeenCalled();
    expect(planningContextBuilds).not.toHaveBeenCalled();

    inventoryBuilds.mockClear();
    planningContextBuilds.mockClear();
    const tracked = await compile(source, {
      fileName: "issue-3520-tracking-only.ts",
      experimentalIR: false,
      trackIrOutcomes: true,
    });

    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
    expect(tracked.irOutcomes).toEqual([]);
    expectOneInventory("issue-3520-tracking-only.ts");
  });

  it("builds one inventory for a tracked single-source overlay and its outcome ledger", async () => {
    const result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      fileName: "issue-3520-single-context.ts",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // (#3523 R4 gap 4) The ledger carries the ownership row for `add` AND an
    // observational `<module-init>` row for the source's empty, non-executable
    // module init. Assert the ownership projection unchanged, then the
    // observational row explicitly — same partition as
    // `scripts/check-ir-only.ts:403-416`.
    expect(ownershipOutcomes(result.irOutcomes)).toEqual([
      expect.objectContaining({ displayName: "add", kind: "emitted", irBodyEmitted: true }),
    ]);
    const observational = observationalOutcomes(result.irOutcomes);
    expect(observational).toEqual([
      expect.objectContaining({
        displayName: "<module-init>",
        kind: "non-executable",
        unitKind: "module-init",
        stage: "select",
      }),
    ]);
    // Asserted with `toBeUndefined` rather than inside `objectContaining`: the
    // row omits the key entirely, and `objectContaining` requires the property
    // to be PRESENT even when the expected value is `undefined`.
    expect(observational[0]?.unitId).toBeUndefined();
    expectWellFormedObservationalRows(result.irOutcomes);
    expectOneInventory("issue-3520-single-context.ts");
  });

  it("builds one whole-program inventory shared by every multi-source overlay", async () => {
    const result = await compileMulti(
      {
        "dependency.ts": `export function twice(value: number): number { return value * 2; }`,
        "entry.ts": `
          import { twice } from "./dependency";
          export function main(): number { return twice(21); }
        `,
      },
      "entry.ts",
      { trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // Same partition as above: each of the two sources contributes an
    // observational `<module-init>` row that owns no terminal unit.
    expect(
      ownershipOutcomes(result.irOutcomes)
        .map((outcome) => outcome.displayName)
        .sort(),
    ).toEqual(["main", "twice"]);
    expect(
      observationalOutcomes(result.irOutcomes)
        .map((outcome) => outcome.file)
        .sort(),
    ).toEqual(["dependency.ts", "entry.ts"]);
    expectWellFormedObservationalRows(result.irOutcomes);
    expectOneInventory("dependency.ts", "entry.ts");
  });

  it("shares one linear inventory across propagation and recursive evidence", async () => {
    const result = await compile(
      `
        function even(value) {
          if (value === 0) return true;
          return odd(value - 1);
        }
        function odd(value) {
          if (value === 0) return false;
          return even(value - 1);
        }
        /** @param {number} value @returns {boolean} */
        export function run(value) { return even(value); }
      `,
      {
        target: "linear",
        allocator: "analysis-stack",
        fileName: "issue-3520-linear-context.js",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(getLastLinearIrReport()?.compiled).toEqual(["even", "odd", "run"]);
    expectOneInventory("issue-3520-linear-context.js");
  });
});
