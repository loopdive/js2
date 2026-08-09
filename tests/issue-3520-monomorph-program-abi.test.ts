// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

const { injectedParentIds, observedCloneIds } = vi.hoisted(() => ({
  injectedParentIds: new Set<string>(),
  observedCloneIds: vi.fn<(ids: readonly string[]) => void>(),
}));

// Production source lowering currently normalizes direct-call tuples before
// monomorphization, so this wrapper is deliberately an integration-contract
// seam: it runs the real pass, then supplies contract-shaped clone output for
// the production integration/Program ABI path. Natural clone discovery and
// call-site rewriting remain covered by the pass-level monomorphization tests.
vi.mock("../src/ir/passes/monomorphize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/passes/monomorphize.js")>();
  const { createDerivedIrUnitId } = await import("../src/ir/identity.js");
  return {
    ...actual,
    monomorphize(...args: Parameters<typeof actual.monomorphize>) {
      const result = actual.monomorphize(...args);
      const cloneSignatures = new Map(result.cloneSignatures);
      const cloneOrigins = new Map(result.cloneOrigins);
      const cloneUnitProvenance = new Map(result.cloneUnitProvenance);
      const injectedClones: Array<(typeof result.module.functions)[number]> = [];
      for (const parent of result.module.functions) {
        if (!injectedParentIds.has(parent.unitId)) continue;
        const returnType = parent.resultTypes[0];
        if (!returnType || parent.resultTypes.length !== 1) {
          throw new Error(`test monomorph injection requires one result from ${parent.unitId}`);
        }
        const cloneUnitId = createDerivedIrUnitId({
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
        const cloneName = `${parent.name}$abi_test_0`;
        injectedClones.push({
          ...structuredClone(parent),
          unitId: cloneUnitId,
          name: cloneName,
          exported: false,
        });
        cloneSignatures.set(cloneUnitId, {
          name: cloneName,
          params: parent.params.map((param) => param.type),
          returnType,
        });
        cloneOrigins.set(cloneUnitId, parent.unitId);
        cloneUnitProvenance.set(cloneUnitId, {
          id: cloneUnitId,
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
      }
      // Put children before their parents and reverse sibling placement. The
      // integration must register the full derived graph parent-first rather
      // than inheriting monomorphizer/module insertion order.
      const reversedClones = injectedClones.reverse();
      observedCloneIds(reversedClones.map((clone) => clone.unitId));
      return {
        ...result,
        module: { functions: [...reversedClones, ...result.module.functions] },
        cloneSignatures,
        cloneOrigins,
        cloneUnitProvenance,
      };
    },
  };
});

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createDerivedIrUnitId, type IrBindingId, type IrUnitId } from "../src/ir/identity.js";
import type { ValType } from "../src/ir/types.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function canonicalValType(type: ValType): string {
  switch (type.kind) {
    case "i32":
      return JSON.stringify({
        kind: type.kind,
        ...(type.boolean === true ? { boolean: true as const } : {}),
        ...(type.symbol === true ? { symbol: true as const } : {}),
      });
    case "i64":
      return JSON.stringify({
        kind: type.kind,
        ...(type.bigint === true ? { bigint: true as const } : {}),
      });
    case "ref":
    case "ref_null":
      return JSON.stringify({ kind: type.kind, typeIdx: type.typeIdx });
    default:
      return JSON.stringify({ kind: type.kind });
  }
}

describe("#3520 production monomorphized-callable Program ABI planning", () => {
  it("publishes clone ordinal zero beneath two real lifted parents in provenance order", () => {
    const ast = analyzeSource(
      `
        export function owner(value: number, flag: boolean): number {
          const firstIdentity = (input: number): number => input;
          const secondIdentity = (input: boolean): boolean => input;
          return firstIdentity(value) + (secondIdentity(flag) ? 1 : 0);
        }
      `,
      "/repo/issue-3520-monomorph-production.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile });
    const owner = inventory.allUnits.find(
      (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "owner",
    );
    if (!owner) throw new Error("missing exact source owner");
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
    const firstCloneUnitId = createDerivedIrUnitId({
      parentId: firstLiftedUnitId,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    const secondCloneUnitId = createDerivedIrUnitId({
      parentId: secondLiftedUnitId,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    const firstLiftedBindingId = irUnitCallableBindingId(firstLiftedUnitId);
    const secondLiftedBindingId = irUnitCallableBindingId(secondLiftedUnitId);
    const firstCloneBindingId = irUnitCallableBindingId(firstCloneUnitId);
    const secondCloneBindingId = irUnitCallableBindingId(secondCloneUnitId);

    injectedParentIds.clear();
    observedCloneIds.mockClear();
    injectedParentIds.add(firstLiftedUnitId);
    injectedParentIds.add(secondLiftedUnitId);
    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(observedCloneIds).toHaveBeenCalledTimes(1);
    expect(observedCloneIds.mock.calls[0]?.[0]).toEqual([secondCloneUnitId, firstCloneUnitId]);
    expect(result.irCompiledFuncs).toEqual(
      expect.arrayContaining([
        "owner",
        "owner__closure_0",
        "owner__closure_1",
        "owner__closure_0$abi_test_0",
        "owner__closure_1$abi_test_0",
      ]),
    );
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entriesById = new Map(publication.abi.entries().map((entry) => [entry.id, entry] as const));
    const derivedBindingIds = new Set([
      firstLiftedBindingId,
      firstCloneBindingId,
      secondLiftedBindingId,
      secondCloneBindingId,
    ]);
    expect(
      publication.abi
        .entries()
        .filter((entry) => derivedBindingIds.has(entry.id))
        .map((entry) => entry.id),
    ).toEqual([firstLiftedBindingId, firstCloneBindingId, secondLiftedBindingId, secondCloneBindingId]);
    const functionImportCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const resolveDefinedSlot = (bindingId: IrBindingId) => {
      const finalIndex = publication.abi.resolveFinalIndex(bindingId);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
      if (!finalIndex || finalIndex.space !== "function") {
        throw new Error(`missing function slot for ${bindingId}`);
      }
      const func = result.module.functions[finalIndex.index - functionImportCount];
      expect(func, `missing defined function for ${bindingId}`).toBeDefined();
      return { finalIndex, func: func! };
    };
    const assertClone = (unitId: IrUnitId, expectedName: string, expectedType: ValType) => {
      const bindingId = irUnitCallableBindingId(unitId);
      const entry = entriesById.get(bindingId);
      expect(entry).toMatchObject({
        id: bindingId,
        displayName: expectedName,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "source",
          unitId,
        },
      });
      if (!entry || entry.intent.kind !== "callable") {
        throw new Error(`missing callable ABI entry for ${unitId}`);
      }

      const slot = resolveDefinedSlot(bindingId);
      expect(slot.func.name).toBe(expectedName);
      const signature = result.module.types[slot.func.typeIdx];
      expect(signature).toEqual(expect.objectContaining({ kind: "func" }));
      if (!signature || signature.kind !== "func") {
        throw new Error(`missing function signature for ${unitId}`);
      }
      // Lifted callables carry a leading capture-environment ref. Its typeIdx
      // is compacted by final dead-type elimination after this R1 callable
      // intent was planned; notifying callable intentions about that type/DCE
      // remap is a later Program ABI slice. Bind every stable non-capture
      // position here so swapping these f64/boolean clone locators still fails.
      expect({
        params: signature.params.slice(1).map(canonicalValType),
        results: signature.results.map(canonicalValType),
      }).toEqual({
        params: entry.intent.signature.params.slice(1),
        results: entry.intent.signature.results,
      });
      expect({
        params: signature.params.slice(1),
        results: signature.results,
      }).toEqual({
        params: [expectedType],
        results: [expectedType],
      });
      expect({
        params: entry.intent.signature.params.slice(1),
        results: entry.intent.signature.results,
      }).toEqual({
        params: [JSON.stringify(expectedType)],
        results: [JSON.stringify(expectedType)],
      });
      return slot;
    };

    const firstClone = assertClone(firstCloneUnitId, "owner__closure_0$abi_test_0", { kind: "f64" });
    const secondClone = assertClone(secondCloneUnitId, "owner__closure_1$abi_test_0", {
      kind: "i32",
      boolean: true,
    });
    expect(firstClone.finalIndex.index).not.toBe(secondClone.finalIndex.index);
    expect(firstClone.func.typeIdx).not.toBe(secondClone.func.typeIdx);
  });
});
