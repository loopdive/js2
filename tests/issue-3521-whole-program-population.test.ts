// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory, createDerivedIrUnitId } from "../src/ir/identity.js";
import { assertPreparedIrProgramPopulation } from "../src/ir/program-population.js";
import type { IrFunction } from "../src/ir/nodes.js";
import type { ProgramAbiDerivedUnitRecord } from "../src/ir/program-abi.js";

function fixture() {
  const source = ts.createSourceFile(
    "/repo/program.ts",
    "let x = 1; export function read() { return x; }",
    ts.ScriptTarget.Latest,
    true,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const functions: IrFunction[] = inventory.terminalUnits.map((unit) => ({
    unitId: unit.id,
    name: unit.displayName,
    params: [],
    resultTypes: [],
    blocks: [],
    exported: false,
    valueCount: 0,
  }));
  return { inventory, ir: { functions }, derivedUnits: [] as ProgramAbiDerivedUnitRecord[] };
}

describe("whole-program population authority", () => {
  it("counts every original initializer and function exactly once", () => {
    const input = fixture();
    expect(input.inventory.terminalUnits).toHaveLength(2);
    expect(() => assertPreparedIrProgramPopulation(input)).not.toThrow();
    expect(() => assertPreparedIrProgramPopulation({ ...input, ir: { functions: [] } })).toThrow("missing body");
    expect(() =>
      assertPreparedIrProgramPopulation({ ...input, ir: { functions: input.ir.functions.slice(1) } }),
    ).toThrow("missing body");
    expect(() =>
      assertPreparedIrProgramPopulation({
        ...input,
        ir: { functions: [...input.ir.functions, input.ir.functions[0]!] },
      }),
    ).toThrow("duplicated");
  });

  it("requires derived provenance to join both its original owner and its typed body", () => {
    const input = fixture();
    const owner = input.inventory.terminalUnits[0]!;
    const provenance: ProgramAbiDerivedUnitRecord = {
      id: createDerivedIrUnitId({ parentId: owner.id, role: "ir-async-state", ordinal: 0 }),
      parentId: owner.id,
      terminalOwnerId: owner.id,
      sourceId: owner.sourceId,
      role: "ir-async-state",
      ordinal: 0,
    };
    const derived = { ...input.ir.functions[0]!, unitId: provenance.id };
    const complete = { ...input, derivedUnits: [provenance], ir: { functions: [...input.ir.functions, derived] } };
    expect(() => assertPreparedIrProgramPopulation(complete)).not.toThrow();
    expect(() => assertPreparedIrProgramPopulation({ ...complete, derivedUnits: [] })).toThrow("no original owner");
    expect(() => assertPreparedIrProgramPopulation({ ...complete, ir: input.ir })).toThrow("missing body");
    expect(() =>
      assertPreparedIrProgramPopulation({
        ...complete,
        derivedUnits: [{ ...provenance, terminalOwnerId: input.inventory.terminalUnits[1]!.id }],
      }),
    ).toThrow("contradictory parent");
  });
});
