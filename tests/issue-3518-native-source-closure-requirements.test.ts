// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { createDerivedIrUnitId } from "../src/shared/contracts/identity-values.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { forEachInstrDeep, type IrFunction, type IrInstrClosureNew } from "../src/ir/core/nodes.js";
import { irUnitCallableBindingId } from "../src/ir/core/callable-bindings.js";
import { assertPreparedIrProgramPopulation } from "../src/ir/program/population.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { deriveNativeStringOutputRequirements } from "../src/ir/program/native-string-output-requirements.js";
import {
  planNativeSourceClosureRequirements,
  assertNativeSourceClosureRequirementsCurrent,
} from "../src/ir/program/native-source-closure-requirements.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

const source = `
function make(seed: number): (value: number) => number {
  const captured = seed * 2 + 3;
  return function add(value: number): number { return captured + value; };
}
export function run(seed: number): number {
  const first = make(seed);
  const second = make(seed + 100);
  return first(7) + second(9) + first(-2);
}`;
let original: PreparedIrProgram;
let nested: PreparedIrProgram;
beforeAll(() => {
  original = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
  nested = requireProgram(
    prepareWholeIrProgram(
      sourceInput({
        "./entry.ts": `export function outer(seed: number): number {
      function add(value: number): number { return seed + value; }
      return add(3);
    }`,
      }),
    ),
  );
});
afterEach(async () => new Promise<void>((resolve) => setImmediate(resolve)));

function requirements(program: PreparedIrProgram) {
  const result = planNativeSourceClosureRequirements(program, program.runtime[0]!);
  if (!result) throw new Error("real capturing source lost its closure requirements");
  assertNativeSourceClosureRequirementsCurrent(result);
  return result;
}
function output(program: PreparedIrProgram) {
  return deriveNativeStringOutputRequirements(collectNativeStringValueDemands(program, program.runtime[0]!), {
    emptyIdentity: false,
  });
}
function expectCompleteAllocations(program: PreparedIrProgram, plan: ReturnType<typeof requirements>) {
  const expected: { view: string; owner: string; block: number; instruction: IrInstrClosureNew }[] = [];
  for (const [ownerIndex, owner] of program.ir.functions.entries())
    for (const [view, fn] of [
      ["program", owner],
      ["projection", program.runtime[0]!.prepared.functions[ownerIndex]!],
    ] as const) {
      expect(fn.unitId).toBe(owner.unitId);
      fn.blocks.forEach((block, index) => {
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "closure.new")
              expected.push({ view, owner: fn.unitId, block: index, instruction });
          });
      });
    }
  expect(expected.length).toBeGreaterThan(0);
  const actual = plan.allocations.map((row) => {
    const occurrence = plan.demands.occurrences[row.occurrence]!;
    const buffer = plan.demands.buffers[occurrence.bufferIndex]!;
    expect(buffer.root.kind).toBe("block");
    expect(row.ownerUnitId).toBe(buffer.ownerUnitId);
    expect(row.rawAllocationId).toBe(occurrence.instruction.alloc);
    return {
      view: buffer.view,
      owner: buffer.ownerUnitId,
      block: buffer.root.index,
      instruction: occurrence.instruction,
    };
  });
  expect(actual).toEqual(expected);
  actual.forEach((row, index) => expect(row.instruction).toBe(expected[index]!.instruction));
}
function editable() {
  const projection = {
    ...original.runtime[0]!,
    prepared: { ...original.runtime[0]!.prepared, functions: structuredClone(original.runtime[0]!.prepared.functions) },
  };
  const program = {
    ...original,
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    allocations: structuredClone(original.allocations),
    runtime: [projection],
  };
  assertPreparedIrProgram(program);
  const positive = requirements(program);
  expect(output(program)).toMatchObject({ uses: [], binaryConcat: false, stdout: false });
  return { program, projection, positive };
}
function allocation(fn: IrFunction): IrInstrClosureNew {
  const found: IrInstrClosureNew[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (instruction) => {
        if (instruction.kind === "closure.new") found.push(instruction);
      });
  if (found.length !== 1) throw new Error(`expected one actual allocation in ${fn.name}, found ${found.length}`);
  return found[0]!;
}
function makeFunctions(data: ReturnType<typeof editable>) {
  const before = data.program.ir.functions.find((fn) => fn.name === "make")!;
  const projected = data.projection.prepared.functions.find((fn) => fn.unitId === before.unitId)!;
  return [before, projected] as const;
}

describe("complete source closure requirements and output owner reconciliation", () => {
  it.each([false, true])("admits the actual lifted original source owner, decoded=%s", (decoded) => {
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const plan = requirements(program);
    expect(plan.units).toHaveLength(1);
    expectCompleteAllocations(program, plan);
    expect(plan.gaps).toEqual([]);
    const unitId = plan.units[0]!.unitId;
    expect(program.inventory.allUnits.find((unit) => unit.id === unitId)?.terminal).toBe(false);
    expect(program.derivedUnits.some((unit) => unit.id === unitId)).toBe(false);
    const unit = program.inventory.allUnits.find((row) => row.id === unitId)!;
    for (const functions of [program.ir.functions, program.runtime[0]!.prepared.functions])
      expect(functions.find((fn) => fn.unitId === unitId)).toMatchObject({
        sourceUnit: true,
        role: "lifted-closure",
        parentId: unit.lexicalOwnerId,
        ordinal: unit.ordinal,
      });
    expect(output(program)).toMatchObject({ uses: [], binaryConcat: false, stdout: false });
  });

  it.each([false, true])(
    "retains a genuine named nested source body without a closure subtype, decoded=%s",
    (decoded) => {
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(nested)) : nested;
      const unit = program.inventory.allUnits.find((row) => row.kind === "nested-function")!;
      expect(unit.terminal).toBe(false);
      for (const functions of [program.ir.functions, program.runtime[0]!.prepared.functions]) {
        const fn = functions.find((row) => row.unitId === unit.id)!;
        expect(fn).toMatchObject({
          sourceUnit: true,
          role: "lifted-closure",
          parentId: unit.lexicalOwnerId,
          ordinal: unit.ordinal,
        });
        expect(fn.closureSubtype).toBeUndefined();
        expect(() => assertPreparedIrProgramPopulation({ ...program, ir: { functions } }, program.abi)).not.toThrow();
      }
      expect(output(program)).toMatchObject({ uses: [], binaryConcat: false, stdout: false });
    },
  );

  it.each(["sourceUnit", "role", "parentId", "ordinal"] as const)(
    "rejects changed lifted-source %s in both views after the genuine positive",
    (field) => {
      const data = editable();
      const unitId = data.positive.units[0]!.unitId;
      const wrongParent = data.program.inventory.terminalUnits.find((unit) => unit.displayName === "run")!.id;
      for (const module of [data.program.ir, data.projection.prepared]) {
        const fn = module.functions.find((row) => row.unitId === unitId)!;
        if (field === "sourceUnit") Object.assign(fn, { sourceUnit: undefined });
        if (field === "role") Object.assign(fn, { role: "ir-async-state" });
        if (field === "parentId") Object.assign(fn, { parentId: wrongParent });
        if (field === "ordinal") Object.assign(fn, { ordinal: fn.ordinal! + 1 });
      }
      expect(() => assertPreparedIrProgramPopulation(data.program)).toThrow(
        `body ${unitId} lacks its exact original source provenance`,
      );
      expect(() => output(data.program)).toThrow("exact original source provenance");
    },
  );

  it("rejects a copied terminal body with forged matching source provenance and subtype", () => {
    const data = editable();
    const unitId = data.positive.units[0]!.unitId;
    for (const module of [data.program.ir, data.projection.prepared]) {
      const lifted = module.functions.find((fn) => fn.unitId === unitId)!;
      const borrowed = module.functions.find((fn) => fn.name === "make")!;
      Object.assign(module, {
        functions: module.functions.map((fn) =>
          fn.unitId !== unitId
            ? fn
            : {
                ...borrowed,
                unitId,
                sourceUnit: lifted.sourceUnit,
                role: lifted.role,
                parentId: lifted.parentId,
                ordinal: lifted.ordinal,
                closureSubtype: lifted.closureSubtype,
              },
        ),
      });
    }
    // Provenance fields alone do not certify a body's actual prepared callable contract.
    expect(() => output(data.program)).toThrow(`body ${unitId} lacks its exact declared source ABI`);
  });

  it.each(["missing", "duplicate", "intent-owner", "reference-owner", "signature", "slot"] as const)(
    "rejects the %s prepared ABI association for a genuine source body",
    (mutation) => {
      const data = editable();
      const unitId = data.positive.units[0]!.unitId;
      const id = irUnitCallableBindingId(unitId);
      const entries = structuredClone(data.program.abi.entries);
      const own = entries.find((entry) => entry.plan.id === id)!;
      expect(own.contract.kind).toBe("callable");
      if (own.contract.kind !== "callable") throw new Error("genuine callable contract missing");
      const other = data.program.ir.functions.find((fn) => fn.name === "make")!.unitId;
      if (mutation === "intent-owner") Object.assign(own.plan.intent, { unitId: other });
      if (mutation === "reference-owner") Object.assign(own.contract.ref.binding, { unitId: other });
      if (mutation === "signature") Object.assign(own.contract, { params: [] });
      if (mutation === "slot") Object.assign(own.plan, { slotPolicy: "none" });
      Object.assign(data.program, {
        abi: {
          entries:
            mutation === "missing"
              ? entries.filter((entry) => entry !== own)
              : mutation === "duplicate"
                ? [...entries, own]
                : entries,
        },
      });
      expect(() => output(data.program)).toThrow(`body ${unitId} lacks its exact declared source ABI`);
    },
  );

  it.each(["missing-terminal", "missing-lifted", "unknown", "duplicate"] as const)(
    "rejects a matching-view %s population after the genuine positive",
    (mutation) => {
      const data = editable();
      const lifted = data.positive.units[0]!.unitId;
      const terminal = data.program.inventory.terminalUnits.find((unit) => unit.displayName === "run")!;
      const unknown = createDerivedIrUnitId({ parentId: terminal.id, role: "lifted-closure", ordinal: 912 });
      for (const module of [data.program.ir, data.projection.prepared]) {
        let functions = [...module.functions];
        if (mutation === "missing-terminal") functions = functions.filter((fn) => fn.unitId !== terminal.id);
        if (mutation === "missing-lifted") functions = functions.filter((fn) => fn.unitId !== lifted);
        if (mutation === "unknown") functions.push({ ...functions[0]!, unitId: unknown });
        if (mutation === "duplicate") functions.push(functions.find((fn) => fn.unitId === lifted)!);
        Object.assign(module, { functions });
      }
      expect(() => output(data.program)).toThrow(/missing body|no original owner|duplicate/);
    },
  );

  it("keeps the canonical declared-derived-body obligation in the output census", () => {
    const data = editable();
    const parent = data.program.inventory.terminalUnits.find((unit) => unit.displayName === "run")!;
    const record = {
      id: createDerivedIrUnitId({ parentId: parent.id, role: "ir-async-state", ordinal: 0 }),
      parentId: parent.id,
      terminalOwnerId: parent.id,
      sourceId: parent.sourceId,
      role: "ir-async-state" as const,
      ordinal: 0,
    };
    // A canonical population-model extension, not a claim that this source created an async body.
    Object.assign(data.program, { derivedUnits: [record] });
    for (const module of [data.program.ir, data.projection.prepared]) {
      const body = module.functions.find((fn) => fn.unitId === parent.id)!;
      Object.assign(module, { functions: [...module.functions, { ...body, unitId: record.id }] });
    }
    expect(output(data.program)).toMatchObject({ uses: [] });
    for (const module of [data.program.ir, data.projection.prepared])
      Object.assign(module, { functions: module.functions.filter((fn) => fn.unitId !== record.id) });
    expect(() => output(data.program)).toThrow("missing body");
  });

  it("preserves valid allocation aliases while retaining raw and canonical identities", () => {
    const data = editable();
    const [fn] = makeFunctions(data),
      instruction = allocation(fn);
    const registry = AllocSiteRegistry.fromSnapshot(data.program.allocations);
    const canonical = instruction.alloc!;
    const alias = registry.fresh("closure", instruction.resultType!);
    registry.alias(alias, canonical);
    Object.assign(data.program, { allocations: registry.captureSnapshot() });
    for (const body of makeFunctions(data)) Object.assign(allocation(body), { alloc: alias });
    const plan = requirements(data.program);
    expectCompleteAllocations(data.program, plan);
    const before = data.positive.allocations.filter((row) => row.rawAllocationId === canonical);
    const aliased = plan.allocations.filter((row) => row.rawAllocationId === alias);
    expect(before.length).toBeGreaterThan(0);
    expect(aliased).toEqual(before.map((row) => ({ ...row, rawAllocationId: alias })));
    expect(plan.allocations.filter((row) => row.rawAllocationId !== alias)).toEqual(
      data.positive.allocations.filter((row) => row.rawAllocationId !== canonical),
    );
  });

  it("rejects two distinct executable allocation sites sharing one canonical ID", () => {
    const data = editable(),
      [fn] = makeFunctions(data);
    const instruction = allocation(fn);
    const block = fn.blocks.find((row) => row.instrs.includes(instruction))!;
    Object.assign(block, { instrs: [...block.instrs, { ...instruction }] });
    expect(() => planNativeSourceClosureRequirements(data.program, data.projection)).toThrow("distinct executable");
  });

  it("rejects an allocation identity borrowed by a different executable owner", () => {
    const data = editable(),
      [fn] = makeFunctions(data);
    const run = data.program.ir.functions.find((row) => row.name === "run")!;
    const block = run.blocks[0]!;
    Object.assign(block, { instrs: [...block.instrs, { ...allocation(fn) }] });
    expect(() => planNativeSourceClosureRequirements(data.program, data.projection)).toThrow(
      "another executable owner",
    );
  });

  it("requires an explicit mapping when equal-typed capture operands differ between views", () => {
    const data = editable(),
      [, projected] = makeFunctions(data);
    const instruction = allocation(projected);
    expect(instruction.captures).toHaveLength(1);
    expect(instruction.captures[0]).not.toBe(projected.params[0]!.value);
    Object.assign(instruction, { captures: [projected.params[0]!.value] });
    const plan = requirements(data.program);
    expect(plan.gaps).toEqual([
      {
        unitId: projected.unitId,
        detail: "closure capture operands across representations need an authenticated transformation mapping",
      },
    ]);
  });

  it.each(["copied-requirements", "changed-nonclosure", "removed-nonclosure", "removed-buffer"] as const)(
    "rejects %s after issuing a current real source plan",
    (mutation) => {
      const data = editable(),
        [fn] = makeFunctions(data);
      if (mutation === "copied-requirements") {
        expect(() => assertNativeSourceClosureRequirementsCurrent({ ...data.positive })).toThrow("unissued");
        return;
      }
      const block = fn.blocks[0]!;
      const index = block.instrs.findIndex((instruction) => instruction.kind === "binary");
      expect(index).toBeGreaterThanOrEqual(0);
      if (mutation === "changed-nonclosure") Object.assign(block.instrs[index]!, { op: "f64.div" });
      if (mutation === "removed-nonclosure")
        Object.assign(block, { instrs: block.instrs.filter((_, i) => i !== index) });
      if (mutation === "removed-buffer") Object.assign(fn, { blocks: fn.blocks.slice(1) });
      expect(() => assertNativeSourceClosureRequirementsCurrent(data.positive)).toThrow(
        /changed after selection|identities changed/,
      );
    },
  );
});
