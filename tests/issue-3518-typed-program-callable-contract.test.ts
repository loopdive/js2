// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { preparedIrProgramCallableResults } from "../src/ir/program-callable-contract.js";
import { prepareIrProgramAbiEntries, preparedIrCallableSignature } from "../src/ir/program-abi-contracts.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { forEachInstrDeep, irVal } from "../src/ir/nodes.js";
import { sourcePacket, typedOptions } from "./helpers/typed-program-fixtures.js";

describe("canonical callable/body distinction without native resource closure", () => {
  it("preserves regular result identity and shares one frozen Promise carrier for async calls", () => {
    const results = [irVal({ kind: "f64" })];
    expect(preparedIrProgramCallableResults({ funcKind: "regular", resultTypes: results })).toBe(results);
    const async = preparedIrProgramCallableResults({ funcKind: "async", resultTypes: results });
    expect(async).toEqual([irVal({ kind: "externref" })]);
    expect(async).toBe(preparedIrProgramCallableResults({ funcKind: "async", resultTypes: [] }));
    expect(Object.isFrozen(async)).toBe(true);
    expect(Object.isFrozen(async[0])).toBe(true);
    expect(Object.isFrozen(async[0]!.kind === "val" && async[0]!.val)).toBe(true);
    expect(results).toEqual([irVal({ kind: "f64" })]);
  });

  it("builds real async fulfillment bodies and Promise-returning regular callers with exact ABI contracts", () => {
    const { packet } = sourcePacket({
      "./body.ts": "export async function immediate(): Promise<number> { return 3; }",
      "./entry.ts":
        'import { immediate as run } from "./body"; export function forward(): Promise<number> { return run(); }',
    });
    expect(packet.inventory.sources).toHaveLength(2);
    expect(packet.inventory.terminalUnits).toHaveLength(2);
    expect(packet.ir.functions).toHaveLength(2);
    const immediate = packet.ir.functions.find((fn) => fn.name === "immediate")!;
    const forward = packet.ir.functions.find((fn) => fn.name === "forward")!;
    expect(immediate.funcKind).toBe("async");
    expect(immediate.resultTypes).toEqual([irVal({ kind: "f64" })]);
    expect(forward.funcKind).toBeUndefined(); // the existing builder omits the regular default
    expect(forward.resultTypes).toEqual([irVal({ kind: "externref" })]);
    const calls: unknown[] = [];
    for (const block of forward.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call") calls.push(instruction.resultType);
        });
    expect(calls).toEqual([irVal({ kind: "externref" })]);
    const entries = prepareIrProgramAbiEntries(packet);
    for (const fn of [immediate, forward]) {
      const entry = entries.find(
        (entry) => entry.plan.intent.kind === "callable" && entry.plan.intent.unitId === fn.unitId,
      )!;
      expect(entry.contract.kind).toBe("callable");
      if (entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable")
        throw new Error("callable omitted");
      expect(entry.contract.results).toEqual([irVal({ kind: "externref" })]);
      expect(entry.plan.intent.signature).toEqual(preparedIrCallableSignature([], [irVal({ kind: "externref" })]));
    }
  });

  it.each([
    { "./entry.ts": "export async function main(): Promise<number> { return 3; }" },
    {
      "./body.ts": "export async function immediate(): Promise<number> { return 3; }",
      "./entry.ts": 'export { immediate as main } from "./body";',
    },
  ])("retains the unsupported native async owner in the complete source denominator: %j", (files) => {
    const { packet } = sourcePacket(files);
    expect(packet.ir.functions).toHaveLength(1);
    expect(packet.inventory.terminalUnits).toHaveLength(1);
    const owner = packet.inventory.terminalUnits[0]!;
    const result = prepareTypedIrProgram(packet, typedOptions);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("unimplemented native resources were accepted");
    expect(result.unitId).toBe(owner.id);
    expect(result.location.sourceId).toBe(owner.sourceId);
    expect(result.sourceFile).toBe(packet.inventory.sources.find((source) => source.id === owner.sourceId)!.sourceKey);
    expect(result.detail).not.toBe("");
  });
});
