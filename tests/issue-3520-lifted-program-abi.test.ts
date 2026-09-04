// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrBindingId } from "../src/ir/identity.js";
import { liftedArrowUnit } from "./helpers/ir-identities.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

// A prepared derived callable whose compatibility label is already taken in the
// legacy function map is given this deterministic physical name instead
// (`src/ir/prepared-closure-support.ts`, `prepareDerivedCallableSlots`). It is a
// physical-slot label, not a source name: the SOURCE function keeps the label.
const RELABELLED_DERIVED_0 = "__\u0000js2_ir_prepared_derived_0";

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

    // Exact provenance: enclosing terminal owner plus declaration ordinal. See
    // `liftedArrowUnit` for why this is not `createDerivedIrUnitId(…)`.
    const firstLifted = liftedArrowUnit(inventory.allUnits, owner.id, 0);
    const secondLifted = liftedArrowUnit(inventory.allUnits, owner.id, 1);
    expect([firstLifted.displayName, secondLifted.displayName]).toEqual(["first", "second"]);
    const firstLiftedUnitId = firstLifted.id;
    const secondLiftedUnitId = secondLifted.id;

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
      // The first arrow wants the compatibility label `owner__closure_0`, which
      // the source function already holds, so its row carries the relabelled
      // physical name. The second arrow's label is free and is kept.
      [firstLiftedBindingId, firstLiftedUnitId, RELABELLED_DERIVED_0],
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

    // The compatibility label is intentionally ambiguous at the source level.
    // Production resolves that by relabelling the LIFTED slot, so structural
    // IDs address separate source and lifted slots without choosing by name,
    // and the legacy name map keeps exactly one owner for the label.
    expect(entriesById.get(sameLabelSourceBindingId)?.displayName).toBe("owner__closure_0");
    expect(entriesById.get(firstLiftedBindingId)?.displayName).toBe(RELABELLED_DERIVED_0);

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
    expect(firstLiftedSlot.func.name).toBe(RELABELLED_DERIVED_0);
    expect(secondLiftedSlot.func.name).toBe("owner__closure_1");
    expect(sameLabelSourceSlot.func.name).toBe("owner__closure_0");
    // Row and slot are relabelled together: every published row displays the
    // name of the physical slot it resolves to.
    for (const [bindingId, slot] of [
      [ownerBindingId, ownerSlot],
      [firstLiftedBindingId, firstLiftedSlot],
      [secondLiftedBindingId, secondLiftedSlot],
      [sameLabelSourceBindingId, sameLabelSourceSlot],
    ] as const) {
      expect(entriesById.get(bindingId)?.displayName).toBe(slot.func.name);
    }
    // The legacy compatibility lookup therefore resolves `owner__closure_0` to
    // the SOURCE slot — not to the lifted arrow that wanted the same label.
    const legacyClosureZero = publication.legacy.resolveFinalIndex("function", "owner__closure_0");
    expect(legacyClosureZero).toEqual({ space: "function", index: sameLabelSourceSlot.finalIndex.index });
    expect(legacyClosureZero?.index).not.toBe(firstLiftedSlot.finalIndex.index);

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
    const lifted = liftedArrowUnit(inventory.allUnits, owner.id, 0);
    expect(lifted.displayName).toBe("callback");

    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const liftedIndex = result.programAbi!.abi.resolveFinalIndex(irUnitCallableBindingId(lifted.id));
    const sourceIndex = result.programAbi!.abi.resolveFinalIndex(irUnitCallableBindingId(emptySource.id));
    expect(liftedIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(sourceIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(liftedIndex).not.toEqual(sourceIndex);

    // Name both slots so "two different indices" cannot pass by accident: the
    // lifted artifact took a fresh relabelled slot and the empty source
    // function kept its own, rather than the artifact reusing the empty one.
    const functionImportCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const definedNameAt = (finalIndex: typeof liftedIndex, label: string) => {
      if (!finalIndex || finalIndex.space !== "function") throw new Error(`missing function slot for ${label}`);
      const func = result.module.functions[finalIndex.index - functionImportCount];
      expect(func, `missing defined function for ${label}`).toBeDefined();
      return func!.name;
    };
    expect(definedNameAt(liftedIndex, "lifted artifact")).toBe(RELABELLED_DERIVED_0);
    expect(definedNameAt(sourceIndex, "empty source function")).toBe("owner__closure_0");
  });
});
