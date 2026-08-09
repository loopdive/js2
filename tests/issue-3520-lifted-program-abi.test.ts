// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createDerivedIrUnitId, type IrBindingId } from "../src/ir/identity.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

describe("#3520 production lifted-callable Program ABI planning", () => {
  it("publishes two lifted closures by exact provenance despite a same-labelled source function", () => {
    const ast = analyzeSource(
      `
        export function owner(value: number): number {
          const first = (input: number): number => input + 1;
          const second = (input: number): number => input * 2;
          return first(value) + second(value);
        }

        export function owner__closure_0(): number {
          return 100;
        }
      `,
      "/repo/issue-3520-lifted-production.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "owner");
    const sameLabelSource = inventory.allUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "owner__closure_0",
    );
    if (!owner || !sameLabelSource) throw new Error("missing exact source-unit fixtures");

    const firstLiftedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const secondLiftedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 1,
    });
    const ownerBindingId = irUnitCallableBindingId(owner.id);
    const firstLiftedBindingId = irUnitCallableBindingId(firstLiftedUnitId);
    const secondLiftedBindingId = irUnitCallableBindingId(secondLiftedUnitId);
    const sameLabelSourceBindingId = irUnitCallableBindingId(sameLabelSource.id);

    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["owner", "owner__closure_0", "owner__closure_1"]));
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entriesById = new Map(publication.abi.entries().map((entry) => [entry.id, entry] as const));
    for (const [bindingId, unitId, displayName] of [
      [ownerBindingId, owner.id, "owner"],
      [firstLiftedBindingId, firstLiftedUnitId, "owner__closure_0"],
      [secondLiftedBindingId, secondLiftedUnitId, "owner__closure_1"],
    ] as const) {
      expect(entriesById.get(bindingId)).toMatchObject({
        id: bindingId,
        displayName,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "source",
          unitId,
        },
      });
    }

    // The compatibility label is intentionally ambiguous. Structural IDs must
    // still identify separate source and lifted slots without choosing by name.
    expect(entriesById.get(sameLabelSourceBindingId)?.displayName).toBe("owner__closure_0");
    expect(entriesById.get(firstLiftedBindingId)?.displayName).toBe("owner__closure_0");
    expect(() => publication.legacy.resolveFinalIndex("function", "owner__closure_0")).toThrow(
      /matches 2 canonical structural owners/,
    );

    const functionImportCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const resolveDefinedSlot = (bindingId: IrBindingId) => {
      const finalIndex = publication.abi.resolveFinalIndex(bindingId);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
      if (!finalIndex || finalIndex.space !== "function") {
        throw new Error(`missing function slot for ${bindingId}`);
      }
      const localIndex = finalIndex.index - functionImportCount;
      const func = result.module.functions[localIndex];
      expect(func, `missing defined function ${localIndex} for ${bindingId}`).toBeDefined();
      return { finalIndex, func: func! };
    };

    const ownerSlot = resolveDefinedSlot(ownerBindingId);
    const firstLiftedSlot = resolveDefinedSlot(firstLiftedBindingId);
    const secondLiftedSlot = resolveDefinedSlot(secondLiftedBindingId);
    const sameLabelSourceSlot = resolveDefinedSlot(sameLabelSourceBindingId);

    expect(ownerSlot.func.name).toBe("owner");
    expect(firstLiftedSlot.func.name).toBe("owner__closure_0");
    expect(secondLiftedSlot.func.name).toBe("owner__closure_1");
    expect(sameLabelSourceSlot.func.name).toBe("owner__closure_0");
    expect(
      new Set([
        ownerSlot.finalIndex.index,
        firstLiftedSlot.finalIndex.index,
        secondLiftedSlot.finalIndex.index,
        sameLabelSourceSlot.finalIndex.index,
      ]).size,
    ).toBe(4);
    expect(firstLiftedSlot.func.typeIdx).not.toBe(sameLabelSourceSlot.func.typeIdx);
  });

  it("does not reuse an empty same-labelled source slot for a lifted artifact", () => {
    const ast = analyzeSource(
      `
        export function owner(value: number): number {
          const callback = (): number => value + 1;
          return callback();
        }

        export function owner__closure_0(): void {}
      `,
      "/repo/issue-3520-lifted-empty-collision.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "owner");
    const emptySource = inventory.allUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "owner__closure_0",
    );
    if (!owner || !emptySource) throw new Error("missing empty-slot collision fixtures");
    const liftedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });

    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const liftedIndex = result.programAbi!.abi.resolveFinalIndex(irUnitCallableBindingId(liftedUnitId));
    const sourceIndex = result.programAbi!.abi.resolveFinalIndex(irUnitCallableBindingId(emptySource.id));
    expect(liftedIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(sourceIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(liftedIndex).not.toEqual(sourceIndex);
  });
});
