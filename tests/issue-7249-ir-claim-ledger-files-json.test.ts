// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7249 — `scripts/ir-claim-ledger.mts --wrapped` records one row per compiled
 * file (its legacy units, by origin) and a legacy-unit histogram over the
 * compiled files; raw mode carries none of it.
 */
import { beforeAll, describe, expect, it } from "vitest";

type Ledger = typeof import("../scripts/ir-claim-ledger.mts");
let ledger: Ledger;

// Read once at module load by the compiler and the ledger: set before import.
beforeAll(async () => {
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  ledger = await import("../scripts/ir-claim-ledger.mts");
}, 120_000);

const PATH = "test262/test/issue-7249-probe.js";
const probe = (flags: string, body: string): string => `/*---
description: issue 7249 probe
flags: [${flags}]
---*/
${body}
`;
/** Every unit ships an IR body today (measured 2026-11-05). */
const CLEAN = probe("", "function f() { return 1; }\nassert.sameValue(f(), 1);");
/** `with` is a deferred IR feature: `g` and the `<module-init>` that calls it stay legacy. */
const WITH = probe("noStrict", "function g(o) { with (o) { return x; } }\ng({ x: 1 });");

type Population = Awaited<ReturnType<Ledger["measureSource"]>>;
const wrappedRow = async (source: string): Promise<Population> =>
  ledger.measureSource(PATH, source, "standalone", await ledger.loadWrappedCompiler());

function expectReconciled(population: Population): void {
  expect(population.files).toBe(1);
  expect(population.fileRows).toHaveLength(1);
  const [row] = population.fileRows!;
  expect(row.file).toBe(PATH);
  expect(row.compileOk).toBe(true);
  expect(row.units).toBe(row.legacyUnits.length + row.irUnits + row.bothUnits);
  expect(row.units).toBe(population.units);
  const histogram = population.legacyUnitHistogram!;
  expect(Object.keys(histogram)).toEqual(["0", "1", "2", "3", "4+"]);
  expect(Object.values(histogram).reduce((sum, count) => sum + count, 0)).toBe(population.files);
  expect(population.zeroLegacyFiles).toBe(histogram["0"]);
}

describe("#7249 ir-claim-ledger per-file rows", () => {
  it("a fully-IR file is a zero-legacy row", async () => {
    const population = await wrappedRow(CLEAN);
    expectReconciled(population);
    expect(population.fileRows![0].legacyUnits).toEqual([]);
    expect(population.zeroLegacyFiles).toBe(1);
  }, 120_000);

  it("a legacy unit is named with its origin, kind and first refusal", async () => {
    const population = await wrappedRow(WITH);
    expectReconciled(population);
    const { legacyUnits } = population.fileRows![0];
    expect(legacyUnits.map(({ name, origin, kind }) => ({ name, origin, kind }))).toEqual([
      { name: "g", origin: "test", kind: "function" },
      { name: "<module-init>", origin: "test", kind: "module-init" },
    ]);
    expect(legacyUnits[0].firstRefusal).toContain("WithStatement");
    expect(population.legacyUnitHistogram).toEqual({ "0": 0, "1": 0, "2": 1, "3": 0, "4+": 0 });
  }, 120_000);

  it("raw mode has no rows and no histogram", async () => {
    const raw = await ledger.measureSource(PATH, CLEAN, "standalone");
    expect(raw.fileRows).toBeUndefined();
    expect(raw.legacyUnitHistogram).toBeUndefined();
    expect(raw.zeroLegacyFiles).toBeUndefined();
  }, 120_000);
});
