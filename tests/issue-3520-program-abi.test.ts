// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import {
  buildIrUnitInventory,
  createIrBindingId,
  type IrBindingId,
  type IrClassId,
  type IrSourceId,
  type IrUnitId,
  type IrUnitInventory,
} from "../src/ir/identity.js";
import {
  LegacyAbiAdapter,
  ProgramAbiInvariantError,
  ProgramAbiMap,
  type ProgramAbiCallableSignature,
  type ProgramAbiInvariantCode,
  type ProgramAbiOrderKey,
  type ProgramAbiPlanEntry,
} from "../src/ir/program-abi.js";

const F64_TO_F64 = Object.freeze({
  params: Object.freeze(["f64"]),
  results: Object.freeze(["f64"]),
}) satisfies ProgramAbiCallableSignature;

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function expectInvariant(action: () => unknown, code: ProgramAbiInvariantCode): ProgramAbiInvariantError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
  return caught as ProgramAbiInvariantError;
}

interface AbiFixture {
  readonly inventory: IrUnitInventory;
  readonly sourceId: IrSourceId;
  readonly sourceOrder: number;
  readonly firstUnitId: IrUnitId;
  readonly secondUnitId: IrUnitId;
  readonly firstClassId: IrClassId;
  readonly secondClassId: IrClassId;
}

function abiFixture(fileName = "/repo/abi.ts"): AbiFixture {
  const file = source(
    fileName,
    `
      function first(value: number) { return value; }
      function second(value: number) { return value; }
      class First {}
      class Second {}
    `,
  );
  const inventory = buildIrUnitInventory([file], { entrySource: file });
  const sourceRecord = inventory.sources[0]!;
  const firstUnit = inventory.allUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
  );
  const secondUnit = inventory.allUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "second",
  );
  const firstClass = inventory.classes.find((classRecord) => classRecord.displayName === "First");
  const secondClass = inventory.classes.find((classRecord) => classRecord.displayName === "Second");
  if (!firstUnit || !secondUnit || !firstClass || !secondClass) throw new Error("invalid ABI test fixture");
  return {
    inventory,
    sourceId: sourceRecord.id,
    sourceOrder: sourceRecord.order,
    firstUnitId: firstUnit.id,
    secondUnitId: secondUnit.id,
    firstClassId: firstClass.id,
    secondClassId: secondClass.id,
  };
}

function order(fixture: AbiFixture, declarationOrder: number): ProgramAbiOrderKey {
  return { sourceOrder: fixture.sourceOrder, declarationOrder };
}

function binding(
  fixture: AbiFixture,
  domain: "callable" | "global" | "type" | "export" | "class" | "support",
  role: string,
  ownerId: IrSourceId | IrUnitId | IrClassId = fixture.sourceId,
): IrBindingId {
  return createIrBindingId({ ownerId, domain, role });
}

function requiredCallable(
  fixture: AbiFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrder: number,
  unitId: IrUnitId = fixture.firstUnitId,
  signature: ProgramAbiCallableSignature = F64_TO_F64,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "source", signature, unitId },
  };
}

function callableAlias(
  fixture: AbiFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrder: number,
  signature: ProgramAbiCallableSignature = F64_TO_F64,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: { kind: "callable", origin: "import", signature },
  };
}

function requiredGlobal(
  fixture: AbiFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrder: number,
  valueType = "f64",
  mutable = true,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "required",
    slotSpace: "global",
    intent: { kind: "global", origin: "source", valueType, mutable },
  };
}

function globalAlias(
  fixture: AbiFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrder: number,
  valueType = "f64",
  mutable = true,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: { kind: "global", origin: "import", valueType, mutable },
  };
}

function requiredType(
  fixture: AbiFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrder: number,
  shapeKey = "struct:x=f64",
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "type", shapeKey },
  };
}

function typeAlias(
  fixture: AbiFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrder: number,
  shapeKey = "struct:x=f64",
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: { kind: "type", shapeKey },
  };
}

function requiredClass(
  fixture: AbiFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrder: number,
  classId: IrClassId = fixture.firstClassId,
  layoutKey = "class:x=f64",
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "class", classId, layoutKey },
  };
}

function classAlias(
  fixture: AbiFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrder: number,
  classId: IrClassId = fixture.firstClassId,
  layoutKey = "class:x=f64",
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: { kind: "class", classId, layoutKey },
  };
}

function exportAlias(
  fixture: AbiFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  externalName: string,
  declarationOrder: number,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName: externalName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: { kind: "export", externalName, targetId },
  };
}

function supportPlan(
  fixture: AbiFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrder: number,
): ProgramAbiPlanEntry {
  return {
    id,
    order: order(fixture, declarationOrder),
    displayName,
    slotPolicy: "none",
    intent: { kind: "support", role: "inventory-marker" },
  };
}

function planAll(abi: ProgramAbiMap, entries: readonly ProgramAbiPlanEntry[]): void {
  for (const entry of entries) abi.plan(entry);
}

describe("#3520 ProgramAbiMap invariants", () => {
  it("uses dependency-first numeric source/declaration order, including ordinals >= 10", () => {
    const dependency = source(
      "/repo/z.ts",
      Array.from({ length: 12 }, (_, index) => `export function z${index}(x: number) { return x; }`).join("\n"),
    );
    const entry = source("/repo/a.ts", `import { z0 } from "./z"; export function a(x: number) { return z0(x); }`);
    const inventory = buildIrUnitInventory([entry, dependency], { entrySource: entry });
    expect(inventory.sources.map((record) => record.sourceKey)).toEqual(["z.ts", "a.ts"]);
    const sourceOrderById = new Map(inventory.sources.map((record) => [record.id, record.order]));
    const units = inventory.allUnits.filter((unit) => unit.kind === "top-level-function");
    const plans = units.map(
      (unit): ProgramAbiPlanEntry => ({
        id: createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" }),
        order: { sourceOrder: sourceOrderById.get(unit.sourceId)!, declarationOrder: unit.ordinal },
        displayName: unit.displayName,
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "source", signature: F64_TO_F64, unitId: unit.id },
      }),
    );
    const forward = new ProgramAbiMap(inventory);
    const reversed = new ProgramAbiMap(inventory);
    planAll(forward, plans);
    planAll(reversed, [...plans].reverse());

    const expectedNames = [...Array.from({ length: 12 }, (_, index) => `z${index}`), "a"];
    expect(forward.entries().map((plan) => plan.displayName)).toEqual(expectedNames);
    expect(reversed.entries().map((plan) => plan.id)).toEqual(forward.entries().map((plan) => plan.id));
    expect(
      forward
        .entries()
        .slice(8, 12)
        .map((plan) => plan.order.declarationOrder),
    ).toEqual([8, 9, 10, 11]);

    const duplicateOrder = new ProgramAbiMap(inventory);
    duplicateOrder.plan(plans[0]!);
    expectInvariant(() => duplicateOrder.plan({ ...plans[1]!, order: plans[0]!.order }), "duplicate-plan-order");
  });

  it("validates structural order, slot space, duplicate IDs, and inventory membership", () => {
    const fixture = abiFixture();
    const callableId = binding(fixture, "callable", "body", fixture.firstUnitId);
    const secondId = binding(fixture, "callable", "second-body", fixture.secondUnitId);

    const duplicate = new ProgramAbiMap(fixture.inventory);
    duplicate.plan(requiredCallable(fixture, callableId, "first", 0));
    expectInvariant(
      () => duplicate.plan(requiredCallable(fixture, callableId, "first-again", 1)),
      "duplicate-binding-plan",
    );

    const invalidOrder = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        invalidOrder.plan({
          ...requiredCallable(fixture, callableId, "first", 0),
          order: { sourceOrder: fixture.sourceOrder, declarationOrder: 0.5 },
        }),
      "invalid-plan-order",
    );

    const wrongSpace = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        wrongSpace.plan({
          ...requiredCallable(fixture, callableId, "first", 0),
          slotSpace: "global",
        } as ProgramAbiPlanEntry),
      "intent-slot-space-mismatch",
    );

    const missingUnit = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        missingUnit.plan({
          ...requiredCallable(fixture, callableId, "first", 0),
          intent: { kind: "callable", origin: "source", signature: F64_TO_F64 },
        }),
      "missing-source-unit",
    );

    const sourceWithClass = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        sourceWithClass.plan({
          ...requiredCallable(fixture, callableId, "first", 0),
          intent: {
            kind: "callable",
            origin: "source",
            signature: F64_TO_F64,
            unitId: fixture.firstUnitId,
            classId: fixture.firstClassId,
          },
        }),
      "invalid-callable-provenance",
    );

    const supportWithoutOwner = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        supportWithoutOwner.plan({
          ...requiredCallable(fixture, binding(fixture, "support", "ownerless"), "ownerless", 0),
          intent: { kind: "callable", origin: "support", signature: F64_TO_F64 },
        }),
      "invalid-callable-provenance",
    );

    const supportWithTwoOwners = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        supportWithTwoOwners.plan({
          ...requiredCallable(fixture, binding(fixture, "support", "ambiguous"), "ambiguous", 0),
          intent: {
            kind: "callable",
            origin: "support",
            signature: F64_TO_F64,
            unitId: fixture.firstUnitId,
            classId: fixture.firstClassId,
          },
        }),
      "invalid-callable-provenance",
    );

    for (const origin of ["import", "runtime"] as const) {
      const externalWithOwner = new ProgramAbiMap(fixture.inventory);
      expectInvariant(
        () =>
          externalWithOwner.plan({
            ...requiredCallable(fixture, binding(fixture, "callable", `${origin}-with-owner`), origin, 0),
            intent: {
              kind: "callable",
              origin,
              signature: F64_TO_F64,
              classId: fixture.firstClassId,
            },
          }),
        "invalid-callable-provenance",
      );
    }

    const foreign = abiFixture("/other/foreign.ts");
    const foreignUnit = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () => foreignUnit.plan(requiredCallable(fixture, callableId, "first", 0, foreign.firstUnitId)),
      "unknown-inventory-unit",
    );

    const foreignClass = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        foreignClass.plan(
          requiredClass(fixture, binding(fixture, "class", "foreign"), "Foreign", 0, foreign.firstClassId),
        ),
      "unknown-inventory-class",
    );

    const foreignSupportClass = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        foreignSupportClass.plan({
          ...requiredCallable(
            fixture,
            binding(fixture, "support", "foreign-class", foreign.firstClassId),
            "foreignSupport",
            0,
          ),
          intent: {
            kind: "callable",
            origin: "support",
            signature: F64_TO_F64,
            classId: foreign.firstClassId,
          },
        }),
      "unknown-inventory-class",
    );

    const wrongSourceOrder = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        wrongSourceOrder.plan({
          ...requiredCallable(fixture, secondId, "second", 0, fixture.secondUnitId),
          order: { sourceOrder: fixture.sourceOrder + 1, declarationOrder: 0 },
        }),
      "inventory-source-order-mismatch",
    );

    const wrongClassSourceOrder = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        wrongClassSourceOrder.plan({
          ...requiredCallable(
            fixture,
            binding(fixture, "support", "class-init", fixture.firstClassId),
            "First_init",
            0,
          ),
          order: { sourceOrder: fixture.sourceOrder + 1, declarationOrder: 0 },
          intent: {
            kind: "callable",
            origin: "support",
            signature: F64_TO_F64,
            classId: fixture.firstClassId,
          },
        }),
      "inventory-source-order-mismatch",
    );
  });

  it("resolves exact callable, global, type, class, and export aliases", () => {
    const fixture = abiFixture();
    const callableId = binding(fixture, "callable", "body", fixture.firstUnitId);
    const callableAliasId = binding(fixture, "callable", "renamed-import");
    const globalId = binding(fixture, "global", "state");
    const globalAliasId = binding(fixture, "global", "renamed-state");
    const typeId = binding(fixture, "type", "record");
    const typeAliasId = binding(fixture, "type", "record-alias");
    const classId = binding(fixture, "class", "layout", fixture.firstClassId);
    const classAliasId = binding(fixture, "class", "layout-alias", fixture.firstClassId);
    const callableExportId = binding(fixture, "export", "run");
    const globalExportId = binding(fixture, "export", "state");
    const abi = new ProgramAbiMap(fixture.inventory);
    planAll(abi, [
      requiredCallable(fixture, callableId, "first", 0),
      callableAlias(fixture, callableAliasId, callableId, "renamed", 1),
      requiredGlobal(fixture, globalId, "state", 2),
      globalAlias(fixture, globalAliasId, globalId, "renamedState", 3),
      requiredType(fixture, typeId, "Record", 4),
      typeAlias(fixture, typeAliasId, typeId, "RecordAlias", 5),
      requiredClass(fixture, classId, "First", 6),
      classAlias(fixture, classAliasId, classId, "FirstAlias", 7),
      exportAlias(fixture, callableExportId, callableAliasId, "run", 8),
      exportAlias(fixture, globalExportId, globalAliasId, "exportedState", 9),
    ]);
    abi.sealPlan();

    abi.bindFinalIndex(callableId, { space: "function", index: 7 });
    abi.bindFinalIndex(globalId, { space: "global", index: 7 });
    abi.bindFinalIndex(typeId, { space: "type", index: 10 });
    abi.bindFinalIndex(classId, { space: "type", index: 11 });
    abi.finishBinding();

    expect(abi.canonicalId(callableAliasId)).toBe(callableId);
    expect(abi.canonicalId(callableExportId)).toBe(callableId);
    expect(abi.canonicalId(globalAliasId)).toBe(globalId);
    expect(abi.canonicalId(globalExportId)).toBe(globalId);
    expect(abi.canonicalId(typeAliasId)).toBe(typeId);
    expect(abi.canonicalId(classAliasId)).toBe(classId);
    expect(abi.resolveFinalIndex(callableExportId)).toEqual({ space: "function", index: 7 });
    expect(abi.resolveFinalIndex(globalExportId)).toEqual({ space: "global", index: 7 });
    expect(abi.resolveFinalIndex(typeAliasId)).toEqual({ space: "type", index: 10 });
    expect(abi.resolveFinalIndex(classAliasId)).toEqual({ space: "type", index: 11 });

    const adapter = new LegacyAbiAdapter(abi);
    expect(adapter.resolveUniqueLegacyName("function", "renamed")).toBe(callableId);
    expect(adapter.resolveUniqueLegacyName("global", "renamedState")).toBe(globalId);
    expect(adapter.resolveUniqueLegacyName("export", "run")).toBe(callableId);
    expect(adapter.resolveFinalIndex("export", "exportedState")).toEqual({ space: "global", index: 7 });
  });

  it("rejects alias cycles and missing targets", () => {
    const fixture = abiFixture();
    const firstAlias = binding(fixture, "callable", "cycle-a");
    const secondAlias = binding(fixture, "callable", "cycle-b");
    const cycle = new ProgramAbiMap(fixture.inventory);
    cycle.plan(callableAlias(fixture, firstAlias, secondAlias, "a", 0));
    cycle.plan(callableAlias(fixture, secondAlias, firstAlias, "b", 1));
    expectInvariant(() => cycle.sealPlan(), "alias-cycle");

    const missingId = binding(fixture, "callable", "missing");
    const missing = new ProgramAbiMap(fixture.inventory);
    missing.plan(callableAlias(fixture, firstAlias, missingId, "missing", 0));
    expectInvariant(() => missing.sealPlan(), "missing-alias-target");

    const callableId = binding(fixture, "callable", "body", fixture.firstUnitId);
    const missingExport = new ProgramAbiMap(fixture.inventory);
    missingExport.plan(requiredCallable(fixture, callableId, "first", 0));
    missingExport.plan({
      ...exportAlias(fixture, binding(fixture, "export", "missing"), callableId, "missing", 1),
      intent: { kind: "export", externalName: "missing", targetId: missingId },
    });
    expectInvariant(() => missingExport.sealPlan(), "missing-alias-target");
  });

  it("rejects cross-kind and non-exact callable/global/type/class aliases", () => {
    const fixture = abiFixture();
    const globalId = binding(fixture, "global", "state");
    const callableAliasId = binding(fixture, "callable", "state-as-callable");
    const crossKind = new ProgramAbiMap(fixture.inventory);
    crossKind.plan(requiredGlobal(fixture, globalId, "state", 0));
    crossKind.plan(callableAlias(fixture, callableAliasId, globalId, "stateFn", 1));
    expectInvariant(() => crossKind.sealPlan(), "alias-intent-kind-mismatch");

    const callableId = binding(fixture, "callable", "body", fixture.firstUnitId);
    const wrongSignature = new ProgramAbiMap(fixture.inventory);
    wrongSignature.plan(requiredCallable(fixture, callableId, "first", 0));
    wrongSignature.plan(
      callableAlias(fixture, binding(fixture, "callable", "bad-signature"), callableId, "badSignature", 1, {
        params: [],
        results: [],
      }),
    );
    expectInvariant(() => wrongSignature.sealPlan(), "alias-signature-mismatch");

    const multiResultSignature = { params: ["i32"], results: ["i32", "f64"] };
    const exactMultiResult = new ProgramAbiMap(fixture.inventory);
    exactMultiResult.plan(requiredCallable(fixture, callableId, "first", 0, fixture.firstUnitId, multiResultSignature));
    exactMultiResult.plan(
      callableAlias(
        fixture,
        binding(fixture, "callable", "multi-result"),
        callableId,
        "multiResult",
        1,
        multiResultSignature,
      ),
    );
    exactMultiResult.sealPlan();

    const reorderedMultiResult = new ProgramAbiMap(fixture.inventory);
    reorderedMultiResult.plan(
      requiredCallable(fixture, callableId, "first", 0, fixture.firstUnitId, multiResultSignature),
    );
    reorderedMultiResult.plan(
      callableAlias(fixture, binding(fixture, "callable", "reordered-result"), callableId, "reorderedResult", 1, {
        params: ["i32"],
        results: ["f64", "i32"],
      }),
    );
    expectInvariant(() => reorderedMultiResult.sealPlan(), "alias-signature-mismatch");

    const wrongGlobal = new ProgramAbiMap(fixture.inventory);
    wrongGlobal.plan(requiredGlobal(fixture, globalId, "state", 0));
    wrongGlobal.plan(
      globalAlias(fixture, binding(fixture, "global", "bad-state"), globalId, "badState", 1, "i32", false),
    );
    expectInvariant(() => wrongGlobal.sealPlan(), "alias-contract-mismatch");

    const typeId = binding(fixture, "type", "record");
    const wrongType = new ProgramAbiMap(fixture.inventory);
    wrongType.plan(requiredType(fixture, typeId, "Record", 0));
    wrongType.plan(typeAlias(fixture, binding(fixture, "type", "bad-record"), typeId, "BadRecord", 1, "struct:x=i32"));
    expectInvariant(() => wrongType.sealPlan(), "alias-contract-mismatch");

    const classId = binding(fixture, "class", "layout", fixture.firstClassId);
    const wrongClassIdentity = new ProgramAbiMap(fixture.inventory);
    wrongClassIdentity.plan(requiredClass(fixture, classId, "First", 0));
    wrongClassIdentity.plan(
      classAlias(
        fixture,
        binding(fixture, "class", "second-layout", fixture.secondClassId),
        classId,
        "SecondAlias",
        1,
        fixture.secondClassId,
      ),
    );
    expectInvariant(() => wrongClassIdentity.sealPlan(), "alias-contract-mismatch");

    const wrongClassLayout = new ProgramAbiMap(fixture.inventory);
    wrongClassLayout.plan(requiredClass(fixture, classId, "First", 0));
    wrongClassLayout.plan(
      classAlias(
        fixture,
        binding(fixture, "class", "bad-layout", fixture.firstClassId),
        classId,
        "BadLayout",
        1,
        fixture.firstClassId,
        "class:x=i32",
      ),
    );
    expectInvariant(() => wrongClassLayout.sealPlan(), "alias-contract-mismatch");
  });

  it("enforces export target agreement, target kind, uniqueness, and zero allocator space", () => {
    const fixture = abiFixture();
    const firstId = binding(fixture, "callable", "first", fixture.firstUnitId);
    const secondId = binding(fixture, "callable", "second", fixture.secondUnitId);
    const firstExportId = binding(fixture, "export", "first-export");
    const secondExportId = binding(fixture, "export", "second-export");
    const duplicate = new ProgramAbiMap(fixture.inventory);
    planAll(duplicate, [
      requiredCallable(fixture, firstId, "first", 0),
      requiredCallable(fixture, secondId, "second", 1, fixture.secondUnitId),
      exportAlias(fixture, firstExportId, firstId, "same", 2),
      exportAlias(fixture, secondExportId, secondId, "same", 3),
    ]);
    expectInvariant(() => duplicate.sealPlan(), "duplicate-export-name");

    const disagreement = new ProgramAbiMap(fixture.inventory);
    planAll(disagreement, [
      requiredCallable(fixture, firstId, "first", 0),
      requiredCallable(fixture, secondId, "second", 1, fixture.secondUnitId),
      {
        ...exportAlias(fixture, firstExportId, firstId, "run", 2),
        intent: { kind: "export", externalName: "run", targetId: secondId },
      },
    ]);
    expectInvariant(() => disagreement.sealPlan(), "export-target-mismatch");

    const typeId = binding(fixture, "type", "record");
    const invalidTarget = new ProgramAbiMap(fixture.inventory);
    invalidTarget.plan(requiredType(fixture, typeId, "Record", 0));
    invalidTarget.plan(exportAlias(fixture, firstExportId, typeId, "record", 1));
    expectInvariant(() => invalidTarget.sealPlan(), "invalid-export-target");

    const allocatingExport = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        allocatingExport.plan({
          ...exportAlias(fixture, firstExportId, firstId, "run", 0),
          slotSpace: "function",
        } as ProgramAbiPlanEntry),
      "invalid-slot-policy",
    );
  });

  it("keeps generic support slotless and rejects support allocation", () => {
    const fixture = abiFixture();
    const supportId = binding(fixture, "support", "marker");
    const abi = new ProgramAbiMap(fixture.inventory);
    abi.plan(supportPlan(fixture, supportId, "shared", 0));
    abi.sealPlan();
    expect(abi.resolveFinalIndex(supportId)).toBeUndefined();
    expectInvariant(() => abi.bindFinalIndex(supportId, { space: "type", index: 0 }), "slotless-final-binding");
    abi.finishBinding();
    expectInvariant(() => new LegacyAbiAdapter(abi).internalWasmName(supportId), "no-internal-wasm-name");

    const allocating = new ProgramAbiMap(fixture.inventory);
    expectInvariant(
      () =>
        allocating.plan({
          ...supportPlan(fixture, supportId, "shared", 0),
          slotPolicy: "required",
          slotSpace: "type",
        } as ProgramAbiPlanEntry),
      "invalid-slot-policy",
    );
  });

  it("collapses same-name aliases to one canonical owner but rejects two canonical owners", () => {
    const fixture = abiFixture();
    const callableId = binding(fixture, "callable", "same-owner", fixture.firstUnitId);
    const aliasId = binding(fixture, "callable", "same-alias");
    const globalId = binding(fixture, "global", "same-owner");
    const exportId = binding(fixture, "export", "same-owner");
    const oneOwner = new ProgramAbiMap(fixture.inventory);
    planAll(oneOwner, [
      requiredCallable(fixture, callableId, "same", 0),
      callableAlias(fixture, aliasId, callableId, "same", 1),
      requiredGlobal(fixture, globalId, "same", 2),
      exportAlias(fixture, exportId, aliasId, "same", 3),
    ]);
    oneOwner.sealPlan();
    oneOwner.bindFinalIndex(callableId, { space: "function", index: 4 });
    oneOwner.bindFinalIndex(globalId, { space: "global", index: 4 });
    oneOwner.finishBinding();

    const oneOwnerAdapter = new LegacyAbiAdapter(oneOwner);
    expect(oneOwnerAdapter.resolveUniqueLegacyName("function", "same")).toBe(callableId);
    expect(oneOwnerAdapter.resolveUniqueLegacyName("global", "same")).toBe(globalId);
    expect(oneOwnerAdapter.resolveUniqueLegacyName("export", "same")).toBe(callableId);
    expect(oneOwnerAdapter.resolveFinalIndex("function", "same")).toEqual({ space: "function", index: 4 });
    expect(oneOwnerAdapter.internalWasmName(callableId)).toBe("same");

    const secondCallableId = binding(fixture, "callable", "other-owner", fixture.secondUnitId);
    const twoOwners = new ProgramAbiMap(fixture.inventory);
    planAll(twoOwners, [
      requiredCallable(fixture, callableId, "same", 0),
      callableAlias(fixture, aliasId, callableId, "same", 1),
      requiredCallable(fixture, secondCallableId, "same", 2, fixture.secondUnitId),
    ]);
    twoOwners.sealPlan();
    expectInvariant(
      () => new LegacyAbiAdapter(twoOwners).resolveUniqueLegacyName("function", "same"),
      "ambiguous-legacy-name",
    );
  });

  it("requires a sealed plan and separates legacy namespaces from internal-name allocation", () => {
    const fixture = abiFixture();
    const firstId = binding(fixture, "callable", "first", fixture.firstUnitId);
    const secondId = binding(fixture, "callable", "second", fixture.secondUnitId);
    const globalId = binding(fixture, "global", "shared");
    const typeId = binding(fixture, "type", "shared");
    const slotlessTypeId = binding(fixture, "type", "semantic-only");
    const supportId = binding(fixture, "support", "shared");
    const exportId = binding(fixture, "export", "shared");
    const plans: ProgramAbiPlanEntry[] = [
      requiredCallable(fixture, firstId, "shared", 0),
      requiredCallable(fixture, secondId, "shared", 1, fixture.secondUnitId),
      requiredGlobal(fixture, globalId, "shared", 2),
      requiredType(fixture, typeId, "shared", 3),
      {
        id: slotlessTypeId,
        order: order(fixture, 4),
        displayName: "shared",
        slotPolicy: "none",
        intent: { kind: "type", shapeKey: "semantic-only" },
      },
      supportPlan(fixture, supportId, "shared", 5),
      exportAlias(fixture, exportId, firstId, "shared", 6),
    ];
    const preSeal = new ProgramAbiMap(fixture.inventory);
    planAll(preSeal, plans);
    expectInvariant(() => new LegacyAbiAdapter(preSeal), "planning-not-sealed");
    preSeal.sealPlan();

    const adapter = new LegacyAbiAdapter(preSeal);
    expectInvariant(() => adapter.resolveUniqueLegacyName("function", "shared"), "ambiguous-legacy-name");
    expect(adapter.resolveUniqueLegacyName("global", "shared")).toBe(globalId);
    expectInvariant(() => adapter.resolveUniqueLegacyName("type", "shared"), "ambiguous-legacy-name");
    expect(adapter.resolveUniqueLegacyName("export", "shared")).toBe(firstId);
    expectInvariant(() => adapter.resolveUniqueLegacyName("global", "missing"), "missing-legacy-name");

    expect(adapter.internalWasmName(firstId)).not.toBe(adapter.internalWasmName(secondId));
    expect(adapter.internalWasmName(firstId)).toContain("shared__ir_");
    expect(adapter.internalWasmName(globalId)).toBe("shared");
    expect(adapter.internalWasmName(typeId)).toBe("shared");
    expect(adapter.internalWasmName(exportId)).toBe(adapter.internalWasmName(firstId));
    expectInvariant(() => adapter.internalWasmName(slotlessTypeId), "no-internal-wasm-name");
    expectInvariant(() => adapter.internalWasmName(supportId), "no-internal-wasm-name");

    const reverseInsertion = new ProgramAbiMap(fixture.inventory);
    planAll(reverseInsertion, [...plans].reverse());
    reverseInsertion.sealPlan();
    const reverseAdapter = new LegacyAbiAdapter(reverseInsertion);
    expect(reverseAdapter.internalWasmName(firstId)).toBe(adapter.internalWasmName(firstId));
    expect(reverseAdapter.internalWasmName(secondId)).toBe(adapter.internalWasmName(secondId));
  });

  it("binds only allocator-final raw indices and rejects duplicate/colliding/incomplete binding", () => {
    const fixture = abiFixture();
    const firstId = binding(fixture, "callable", "first", fixture.firstUnitId);
    const secondId = binding(fixture, "callable", "second", fixture.secondUnitId);
    const aliasId = binding(fixture, "callable", "first-alias");
    const supportId = binding(fixture, "support", "marker");
    const abi = new ProgramAbiMap(fixture.inventory);
    planAll(abi, [
      requiredCallable(fixture, firstId, "first", 0),
      requiredCallable(fixture, secondId, "second", 1, fixture.secondUnitId),
      callableAlias(fixture, aliasId, firstId, "alias", 2),
      supportPlan(fixture, supportId, "marker", 3),
    ]);

    expect(abi.resolveFinalIndex(firstId)).toBeUndefined();
    expectInvariant(() => abi.bindFinalIndex(firstId, { space: "function", index: 0 }), "planning-not-sealed");
    abi.sealPlan();
    expectInvariant(() => abi.bindFinalIndex(aliasId, { space: "function", index: 0 }), "alias-final-binding");
    expectInvariant(() => abi.bindFinalIndex(supportId, { space: "function", index: 0 }), "slotless-final-binding");
    expectInvariant(() => abi.bindFinalIndex(firstId, { space: "global", index: 0 }), "final-index-space-mismatch");
    expectInvariant(() => abi.bindFinalIndex(firstId, { space: "function", index: -1 }), "final-index-space-mismatch");

    abi.bindFinalIndex(firstId, { space: "function", index: 0 });
    expectInvariant(() => abi.bindFinalIndex(firstId, { space: "function", index: 1 }), "duplicate-final-binding");
    expectInvariant(() => abi.bindFinalIndex(secondId, { space: "function", index: 0 }), "final-index-collision");
    expectInvariant(() => abi.finishBinding(), "unresolved-required-binding");
    abi.bindFinalIndex(secondId, { space: "function", index: 1 });
    abi.finishBinding();

    expect(abi.resolveFinalIndex(aliasId)).toEqual({ space: "function", index: 0 });
    expectInvariant(() => abi.bindFinalIndex(secondId, { space: "function", index: 2 }), "binding-complete");
    expectInvariant(
      () => abi.plan(requiredGlobal(fixture, binding(fixture, "global", "late"), "late", 4)),
      "planning-sealed",
    );
  });
});
