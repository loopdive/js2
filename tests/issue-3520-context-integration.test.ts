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
    expect(result.irOutcomes).toEqual([
      expect.objectContaining({ displayName: "add", kind: "emitted", irBodyEmitted: true }),
    ]);
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
    expect(result.irOutcomes?.map((outcome) => outcome.displayName).sort()).toEqual(["main", "twice"]);
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
