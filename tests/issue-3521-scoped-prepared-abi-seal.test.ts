// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  ProgramAbiSession,
  type ProgramAbiDraft,
  type SealedPreparedProgramAbiScope,
} from "../src/codegen/program-abi-session.js";
import { markLeafStructsFinal } from "../src/codegen/fixups.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiTypeDef,
  canonicalProgramAbiValType,
  type ProgramAbiCallableTypeContract,
} from "../src/codegen/program-abi-signatures.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
  type IrClassId,
  type IrSourceId,
  type IrUnitId,
  type IrUnitInventory,
} from "../src/ir/identity.js";
import {
  ProgramAbiInvariantError,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiInvariantCode,
} from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type GlobalDef,
  type Import,
  type TypeDef,
  type WasmFunction,
  type WasmModule,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({
  params: Object.freeze([]),
  results: Object.freeze([]),
});

interface Fixture {
  readonly inventory: IrUnitInventory;
  readonly sourceId: IrSourceId;
  readonly firstUnitId: IrUnitId;
  readonly secondUnitId: IrUnitId;
  readonly classId: IrClassId;
  readonly firstNestedClassId: IrClassId;
  readonly secondNestedClassId: IrClassId;
  readonly module: WasmModule;
  readonly session: ProgramAbiSession;
}

interface PlannedCallable {
  readonly id: IrBindingId;
  readonly func: WasmFunction;
  readonly referenceKey: string;
}

function fixture(): Fixture {
  const sourceFile = ts.createSourceFile(
    "/repo/scoped-prepared-abi.ts",
    `
      export function first(): void {
        function firstNested(): void {}
        const firstExpression = function (): void {};
        const firstArrow = (): void => {};
        const firstObject = { run(): void {} };
        class FirstNestedClass { run(): void {} }
      }
      function second(): void {
        function secondNested(): void {}
        class SecondNestedClass { run(): void {} }
      }
      class Box {}
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const first = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
  );
  const second = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "second",
  );
  const classRecord = inventory.classes.find((candidate) => candidate.displayName === "Box");
  const firstNestedClass = inventory.classes.find((candidate) => candidate.displayName === "FirstNestedClass");
  const secondNestedClass = inventory.classes.find((candidate) => candidate.displayName === "SecondNestedClass");
  if (!first || !second || !classRecord || !firstNestedClass || !secondNestedClass) {
    throw new Error("invalid scoped ABI fixture");
  }
  const module = createEmptyModule();
  module.types.push({ kind: "func", name: "$void", params: [], results: [] });
  return {
    inventory,
    sourceId: inventory.sources[0]!.id,
    firstUnitId: first.id,
    secondUnitId: second.id,
    classId: classRecord.id,
    firstNestedClassId: firstNestedClass.id,
    secondNestedClassId: secondNestedClass.id,
    module,
    session: new ProgramAbiSession(inventory, module),
  };
}

function callableDraft(
  session: ProgramAbiSession,
  id: IrBindingId,
  unitId: IrUnitId,
  displayName: string,
  referenceKey: string,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: 0,
    }),
    displayName,
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "source",
      signature: VOID_SIGNATURE,
      unitId,
    },
  };
}

function planCallable(f: Fixture, unitId: IrUnitId, role: string, displayName: string): PlannedCallable {
  const id = createIrBindingId({ ownerId: unitId, domain: "callable", role });
  const referenceKey = `unit|${unitId}|${role}`;
  const func: WasmFunction = {
    name: displayName,
    typeIdx: 0,
    locals: [],
    body: [],
    exported: false,
  };
  f.module.functions.push(func);
  f.session.plan(callableDraft(f.session, id, unitId, displayName, referenceKey));
  f.session.registerCallableTypeContract(id, VOID_SIGNATURE);
  f.session.registerStructuralReference(id, referenceKey);
  f.session.attachLocator(id, { kind: "defined-function", value: func });
  return { id, func, referenceKey };
}

function supportDraft(session: ProgramAbiSession, id: IrBindingId, unitId: IrUnitId, roleOrdinal = 0): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "support",
      roleOrdinal,
    }),
    displayName: "prepared-support",
    slotPolicy: "none",
    intent: { kind: "support", role: "prepared-support" },
  };
}

function aliasDraft(f: Fixture, id: IrBindingId, targetId: IrBindingId, roleOrdinal = 0): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "callable",
      roleOrdinal,
    }),
    displayName: "first-alias",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "callable",
      origin: "import",
      signature: VOID_SIGNATURE,
    },
  };
}

function ownedAliasDraft(
  f: Fixture,
  id: IrBindingId,
  targetId: IrBindingId,
  ownerUnitId: IrUnitId,
  signature: ProgramAbiCallableTypeContract = VOID_SIGNATURE,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forUnit(ownerUnitId, {
      domain: "callable",
      roleOrdinal: 9,
    }),
    displayName: "owned-alias",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "callable",
      origin: "import",
      signature: canonicalProgramAbiCallableTypeContract(signature),
    },
  };
}

function classSupportDraft(f: Fixture, id: IrBindingId, classId: IrClassId, roleOrdinal = 0): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forClass(classId, {
      domain: "support",
      roleOrdinal,
    }),
    displayName: "class-support",
    slotPolicy: "none",
    intent: { kind: "support", role: "class-support" },
  };
}

function globalAliasDraft(f: Fixture, id: IrBindingId, targetId: IrBindingId, valueType: string): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "global",
      roleOrdinal: 8,
    }),
    displayName: "global-alias",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "global",
      origin: "import",
      valueType,
      mutable: true,
    },
  };
}

function exportDraft(f: Fixture, id: IrBindingId, targetId: IrBindingId): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "export",
      roleOrdinal: 0,
    }),
    displayName: "first",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "export",
      externalName: "first",
      targetId,
    },
  };
}

function importedCallableDraft(f: Fixture, id: IrBindingId, referenceKey: string, roleOrdinal = 1): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "callable",
      roleOrdinal,
    }),
    displayName: "hostCall",
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "import",
      signature: VOID_SIGNATURE,
    },
  };
}

function importedGlobalDraft(f: Fixture, id: IrBindingId, referenceKey: string): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "global",
      roleOrdinal: 0,
    }),
    displayName: "hostGlobal",
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "import",
      valueType: JSON.stringify({ kind: "i32" }),
      mutable: true,
    },
  };
}

function planSourceGlobal(
  f: Fixture,
  role: string,
  storageOwnerUnitId: IrUnitId,
): { readonly id: IrBindingId; readonly global: GlobalDef } {
  const id = createIrBindingId({ ownerId: f.sourceId, domain: "global", role });
  const referenceKey = `source-global|${f.sourceId}|${role}`;
  const global: GlobalDef = {
    name: role,
    type: { kind: "f64" },
    mutable: true,
    init: [{ op: "f64.const", value: 0 }],
  };
  f.module.globals.push(global);
  f.session.plan({
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "global",
      roleOrdinal: 7,
    }),
    displayName: role,
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "source",
      valueType: canonicalProgramAbiValType(global.type),
      mutable: true,
      sourceId: f.sourceId,
      unitId: storageOwnerUnitId,
    },
  });
  f.session.registerGlobalTypeContract(id, global.type, true);
  f.session.registerStructuralReference(id, referenceKey);
  f.session.attachLocator(id, { kind: "defined-global", value: global });
  return { id, global };
}

function typeDraft(f: Fixture, id: IrBindingId, referenceKey: string): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "type",
      roleOrdinal: 0,
    }),
    displayName: "$PreparedType",
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "type", shapeKey: "pending" },
  };
}

function classDraft(f: Fixture, id: IrBindingId, referenceKey: string): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forClass(f.classId, {
      domain: "class",
      roleOrdinal: 0,
    }),
    displayName: "$PreparedClass",
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "class", classId: f.classId, layoutKey: "pending" },
  };
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

function sealFirst(f: Fixture, dependencies: readonly IrBindingId[] = []): SealedPreparedProgramAbiScope {
  const transaction = f.session.beginPreparedComponentScope("first-component", [f.firstUnitId]);
  for (const id of dependencies) transaction.includeBinding(id);
  return transaction.seal();
}

function planPreparedLayouts(f: Fixture) {
  const typeValue: TypeDef = {
    kind: "struct",
    name: "$PreparedType",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  };
  const classValue: TypeDef = {
    kind: "struct",
    name: "$PreparedClass",
    fields: [{ name: "field", type: { kind: "i32" }, mutable: true }],
  };
  f.module.types.push(typeValue, classValue);
  const typeId = createIrBindingId({ ownerId: f.sourceId, domain: "type", role: "prepared-type" });
  const classId = createIrBindingId({ ownerId: f.classId, domain: "class", role: "prepared-class" });
  const typeKey = `type|${typeId}`;
  const classKey = `class|${classId}`;
  f.session.plan(typeDraft(f, typeId, typeKey));
  f.session.plan(classDraft(f, classId, classKey));
  f.session.registerStructuralReference(typeId, typeKey);
  f.session.registerStructuralReference(classId, classKey);
  const typeCell = f.session.createTypeCell(typeValue);
  const classCell = f.session.createTypeCell(classValue);
  f.session.attachLocator(typeId, { kind: "type-cell", cell: typeCell });
  f.session.attachLocator(classId, { kind: "type-cell", cell: classCell });
  return { typeId, classId, typeValue, classValue, typeCell, classCell };
}

function planImportedDependencies(f: Fixture) {
  const callableId = createIrBindingId({ ownerId: f.sourceId, domain: "callable", role: "host-call" });
  const globalId = createIrBindingId({ ownerId: f.sourceId, domain: "global", role: "host-global" });
  const callableKey = "import|3:env|9:host_call";
  const globalKey = "import-global|3:env|11:host_global";
  const callable: Import = {
    module: "env",
    name: "host_call",
    desc: { kind: "func", typeIdx: 0 },
  };
  const global: Import = {
    module: "env",
    name: "host_global",
    desc: { kind: "global", type: { kind: "i32" }, mutable: true },
  };
  f.module.imports.push(callable, global);
  f.session.plan(importedCallableDraft(f, callableId, callableKey));
  f.session.plan(importedGlobalDraft(f, globalId, globalKey));
  f.session.registerCallableTypeContract(callableId, VOID_SIGNATURE);
  f.session.registerGlobalTypeContract(globalId, { kind: "i32" }, true);
  f.session.registerStructuralReference(callableId, callableKey);
  f.session.registerStructuralReference(globalId, globalKey);
  f.session.attachLocator(callableId, { kind: "import-function", value: callable });
  f.session.attachLocator(globalId, { kind: "import-global", value: global });
  return { callableId, globalId, callable, global };
}

function planLeafReachableCallable(f: Fixture) {
  const baseType: TypeDef = {
    kind: "struct",
    name: "$Base",
    fields: [],
    superTypeIdx: -1,
    final: false,
  };
  const leafType: TypeDef = {
    kind: "struct",
    name: "$Leaf",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
    superTypeIdx: 0,
    final: false,
  };
  const callableType: TypeDef = {
    kind: "func",
    name: "$consumeLeaf",
    params: [{ kind: "ref", typeIdx: 1 }],
    results: [],
  };
  f.module.types = [baseType, leafType, callableType];

  const contract: ProgramAbiCallableTypeContract = Object.freeze({
    params: Object.freeze([{ kind: "ref" as const, typeIdx: 1 }]),
    results: Object.freeze([]),
  });
  const id = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "leaf-body" });
  const referenceKey = `unit|${f.firstUnitId}|leaf-body`;
  const func: WasmFunction = {
    name: "consumeLeaf",
    typeIdx: 2,
    locals: [],
    body: [],
    exported: false,
  };
  f.module.functions.push(func);
  f.session.plan({
    ...callableDraft(f.session, id, f.firstUnitId, "consumeLeaf", referenceKey),
    intent: {
      kind: "callable",
      origin: "source",
      signature: canonicalProgramAbiCallableTypeContract(contract),
      unitId: f.firstUnitId,
    },
  });
  f.session.registerCallableTypeContract(id, contract);
  f.session.registerStructuralReference(id, referenceKey);
  f.session.attachLocator(id, { kind: "defined-function", value: func });
  return { id, leafType };
}

function planExplicitLeafSupportType(f: Fixture) {
  const baseType: TypeDef = {
    kind: "struct",
    name: "$VectorBase",
    fields: [],
    superTypeIdx: -1,
    final: false,
  };
  const leafType: TypeDef = {
    kind: "struct",
    name: "$VectorF64",
    fields: [{ name: "length", type: { kind: "i32" }, mutable: true }],
    superTypeIdx: 1,
    final: false,
  };
  f.module.types.push(baseType, leafType);
  const id = createIrBindingId({ ownerId: f.sourceId, domain: "type", role: "vector-f64" });
  const referenceKey = `type|${id}`;
  f.session.plan(typeDraft(f, id, referenceKey));
  f.session.registerStructuralReference(id, referenceKey);
  f.session.attachLocator(id, { kind: "type-cell", cell: f.session.createTypeCell(leafType) });
  return { id, leafType };
}

describe("#3521 scoped prepared-component ABI seal", () => {
  it("reverse-resolves planned structural references without numeric slot discovery", () => {
    const f = fixture();
    const sharedKey = "import|3:env|11:shared_call";
    const firstId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "shared-call-first",
    });
    const secondId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "shared-call-second",
    });
    f.session.plan(importedCallableDraft(f, secondId, sharedKey, 2));
    f.session.plan(importedCallableDraft(f, firstId, sharedKey, 1));

    expect(f.session.bindingIdsForStructuralReference(sharedKey)).toEqual([firstId, secondId]);
    expect(f.session.bindingIdsForStructuralReference("import|3:env|7:missing")).toEqual([]);
    expect(f.session.bindingIdsForStructuralReference("")).toEqual([]);
  });

  it("pins callable, derived, alias, export, and support closure while unrelated direct planning remains legal", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    const derivedUnitId = createDerivedIrUnitId({
      parentId: f.firstUnitId,
      role: "monomorphized-clone",
      ordinal: 0,
    });
    const derivedRecord: ProgramAbiDerivedUnitRecord = {
      id: derivedUnitId,
      parentId: f.firstUnitId,
      terminalOwnerId: f.firstUnitId,
      sourceId: f.sourceId,
      role: "monomorphized-clone",
      ordinal: 0,
    };
    f.session.registerDerivedUnit(derivedRecord);
    const clone = planCallable(f, derivedUnitId, "body", "first$mono0");
    const aliasId = createIrBindingId({ ownerId: f.sourceId, domain: "callable", role: "first-alias" });
    const exportId = createIrBindingId({ ownerId: f.sourceId, domain: "export", role: "first" });
    const supportId = createIrBindingId({ ownerId: f.firstUnitId, domain: "support", role: "string-table" });
    f.session.plan(aliasDraft(f, aliasId, first.id));
    f.session.plan(exportDraft(f, exportId, first.id));
    f.session.plan(supportDraft(f.session, supportId, f.firstUnitId));

    const scoped = sealFirst(f, [supportId]);
    expect(scoped.planningSealed).toBe(true);
    expect(scoped.terminalUnitIds).toEqual([f.firstUnitId]);
    expect(scoped.derivedUnits).toEqual([derivedRecord]);
    expect(new Set(scoped.bindingIds)).toEqual(new Set([first.id, clone.id, aliasId, exportId, supportId]));
    expect(scoped.canonicalId(aliasId)).toBe(first.id);
    expect(scoped.canonicalId(exportId)).toBe(first.id);
    expect(scoped.entries().map((entry) => entry.id)).toEqual(scoped.bindingIds);

    const second = planCallable(f, f.secondUnitId, "body", "second");
    const unrelatedSupportId = createIrBindingId({
      ownerId: f.secondUnitId,
      domain: "support",
      role: "direct-only",
    });
    f.session.plan(supportDraft(f.session, unrelatedSupportId, f.secondUnitId));

    const publication = f.session.publish(f.module);
    expect(publication.abi.resolveFinalIndex(first.id)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(clone.id)).toEqual({ space: "function", index: 1 });
    expect(publication.abi.resolveFinalIndex(second.id)).toEqual({ space: "function", index: 2 });
    expect(scoped.entries().map((entry) => entry.id)).toEqual(scoped.bindingIds);
  });

  it("rejects a registered executable derived unit without its exact callable reservation", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const liftedUnitId = createDerivedIrUnitId({
      parentId: f.firstUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    f.session.registerDerivedUnit({
      id: liftedUnitId,
      parentId: f.firstUnitId,
      terminalOwnerId: f.firstUnitId,
      sourceId: f.sourceId,
      role: "lifted-closure",
      ordinal: 0,
    });

    const incomplete = f.session.beginPreparedComponentScope("incomplete-derived", [f.firstUnitId]);
    expectInvariant(() => incomplete.seal(), "missing-source-unit");

    const lifted = planCallable(f, liftedUnitId, "body", "first$lifted0");
    const corrected = f.session.beginPreparedComponentScope("complete-derived", [f.firstUnitId]).seal();
    expect(corrected.bindingIds).toContain(lifted.id);
    expect(f.session.publish(f.module).abi.resolveFinalIndex(lifted.id)).toEqual({
      space: "function",
      index: 1,
    });
  });

  it("owns inventoried nested functions, expressions, arrows, and object methods through their terminal root", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    planCallable(f, f.secondUnitId, "body", "second");
    const nestedUnits = f.inventory.allUnits.filter(
      (unit) =>
        unit.terminalOwnerId === f.firstUnitId &&
        (unit.kind === "nested-function" ||
          unit.kind === "function-expression" ||
          unit.kind === "arrow-function" ||
          unit.kind === "object-method"),
    );
    expect(nestedUnits.map((unit) => unit.kind).sort()).toEqual([
      "arrow-function",
      "function-expression",
      "nested-function",
      "object-method",
    ]);
    const nestedCallables = nestedUnits.map((unit) => planCallable(f, unit.id, "body", unit.displayName));

    const scoped = sealFirst(f);
    expect(new Set(scoped.bindingIds)).toEqual(
      new Set([
        createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" }),
        ...nestedCallables.map((entry) => entry.id),
      ]),
    );

    const lateSupportId = createIrBindingId({
      ownerId: nestedUnits[0]!.id,
      domain: "support",
      role: "late-nested-support",
    });
    expectInvariant(
      () => f.session.plan(supportDraft(f.session, lateSupportId, nestedUnits[0]!.id, 7)),
      "planning-sealed",
    );
    const lateCallableId = createIrBindingId({
      ownerId: nestedUnits[1]!.id,
      domain: "callable",
      role: "late-nested-callable",
    });
    expectInvariant(
      () => f.session.plan(callableDraft(f.session, lateCallableId, nestedUnits[1]!.id, "lateNested", "late|nested")),
      "planning-sealed",
    );

    const crossRequest = fixture();
    planCallable(crossRequest, crossRequest.firstUnitId, "body", "first");
    planCallable(crossRequest, crossRequest.secondUnitId, "body", "second");
    const firstNested = crossRequest.inventory.allUnits.find(
      (unit) => unit.kind === "nested-function" && unit.terminalOwnerId === crossRequest.firstUnitId,
    )!;
    const nestedSupportId = createIrBindingId({
      ownerId: firstNested.id,
      domain: "support",
      role: "nested-only",
    });
    crossRequest.session.plan(supportDraft(crossRequest.session, nestedSupportId, firstNested.id, 6));
    const wrongComponent = crossRequest.session.beginPreparedComponentScope("second-cross-request", [
      crossRequest.secondUnitId,
    ]);
    wrongComponent.includeBinding(nestedSupportId);
    expectInvariant(() => wrongComponent.seal(), "invalid-callable-provenance");
  });

  it("retains structural binding and nested-class ownership across closure and disjoint scopes", () => {
    const closure = fixture();
    const first = planCallable(closure, closure.firstUnitId, "body", "first");
    planCallable(closure, closure.secondUnitId, "body", "second");
    const foreignAliasId = createIrBindingId({
      ownerId: closure.secondUnitId,
      domain: "callable",
      role: "foreign-alias",
    });
    closure.session.plan(ownedAliasDraft(closure, foreignAliasId, first.id, closure.secondUnitId));
    expectInvariant(() => sealFirst(closure), "invalid-callable-provenance");

    const exportClosure = fixture();
    const exportFirst = planCallable(exportClosure, exportClosure.firstUnitId, "body", "first");
    planCallable(exportClosure, exportClosure.secondUnitId, "body", "second");
    const foreignExportId = createIrBindingId({
      ownerId: exportClosure.secondUnitId,
      domain: "export",
      role: "foreign-export",
    });
    exportClosure.session.plan({
      ...exportDraft(exportClosure, foreignExportId, exportFirst.id),
      displayName: "foreign-export",
    });
    expectInvariant(() => sealFirst(exportClosure), "invalid-callable-provenance");

    const classRequest = fixture();
    planCallable(classRequest, classRequest.firstUnitId, "body", "first");
    planCallable(classRequest, classRequest.secondUnitId, "body", "second");
    const secondClassSupportId = createIrBindingId({
      ownerId: classRequest.secondNestedClassId,
      domain: "support",
      role: "second-class-support",
    });
    classRequest.session.plan(classSupportDraft(classRequest, secondClassSupportId, classRequest.secondNestedClassId));
    const wrongClassOwner = classRequest.session.beginPreparedComponentScope("first-class-request", [
      classRequest.firstUnitId,
    ]);
    wrongClassOwner.includeBinding(secondClassSupportId);
    expectInvariant(() => wrongClassOwner.seal(), "invalid-callable-provenance");

    const disjoint = fixture();
    planCallable(disjoint, disjoint.firstUnitId, "body", "first");
    planCallable(disjoint, disjoint.secondUnitId, "body", "second");
    const firstClassSupportId = createIrBindingId({
      ownerId: disjoint.firstNestedClassId,
      domain: "support",
      role: "first-class-support",
    });
    const secondDisjointClassSupportId = createIrBindingId({
      ownerId: disjoint.secondNestedClassId,
      domain: "support",
      role: "second-class-support",
    });
    disjoint.session.plan(classSupportDraft(disjoint, firstClassSupportId, disjoint.firstNestedClassId));
    disjoint.session.plan(classSupportDraft(disjoint, secondDisjointClassSupportId, disjoint.secondNestedClassId));
    const firstScope = disjoint.session.beginPreparedComponentScope("first-class", [disjoint.firstUnitId]);
    firstScope.includeBinding(firstClassSupportId);
    firstScope.seal();
    const secondScope = disjoint.session.beginPreparedComponentScope("second-class", [disjoint.secondUnitId]);
    secondScope.includeBinding(secondDisjointClassSupportId);
    secondScope.seal();
    expect(disjoint.session.publish(disjoint.module).abi.entries()).toHaveLength(4);
  });

  it("allows disjoint scopes and shared immutable dependencies but rejects source-callable requests", () => {
    const disjoint = fixture();
    planCallable(disjoint, disjoint.firstUnitId, "body", "first");
    planCallable(disjoint, disjoint.secondUnitId, "body", "second");
    const firstSupport = createIrBindingId({
      ownerId: disjoint.firstUnitId,
      domain: "support",
      role: "first-only",
    });
    const secondSupport = createIrBindingId({
      ownerId: disjoint.secondUnitId,
      domain: "support",
      role: "second-only",
    });
    disjoint.session.plan(supportDraft(disjoint.session, firstSupport, disjoint.firstUnitId));
    disjoint.session.plan(supportDraft(disjoint.session, secondSupport, disjoint.secondUnitId));
    const firstScope = disjoint.session.beginPreparedComponentScope("first", [disjoint.firstUnitId]);
    firstScope.includeBinding(firstSupport);
    firstScope.seal();
    const secondScope = disjoint.session.beginPreparedComponentScope("second", [disjoint.secondUnitId]);
    secondScope.includeBinding(secondSupport);
    secondScope.seal();
    expect(disjoint.session.publish(disjoint.module).abi.entries()).toHaveLength(4);

    const sourceRequest = fixture();
    planCallable(sourceRequest, sourceRequest.firstUnitId, "body", "first");
    const other = planCallable(sourceRequest, sourceRequest.secondUnitId, "body", "second");
    const rejectedSource = sourceRequest.session.beginPreparedComponentScope("source-request", [
      sourceRequest.firstUnitId,
    ]);
    rejectedSource.includeBinding(other.id);
    expectInvariant(() => rejectedSource.seal(), "invalid-callable-provenance");

    const overlap = fixture();
    planCallable(overlap, overlap.firstUnitId, "body", "first");
    planCallable(overlap, overlap.secondUnitId, "body", "second");
    const importedId = createIrBindingId({
      ownerId: overlap.sourceId,
      domain: "callable",
      role: "shared-import",
    });
    const importKey = "import|3:env|6:shared";
    const imported: Import = {
      module: "env",
      name: "shared",
      desc: { kind: "func", typeIdx: 0 },
    };
    overlap.module.imports.push(imported);
    overlap.session.plan(importedCallableDraft(overlap, importedId, importKey));
    overlap.session.registerCallableTypeContract(importedId, VOID_SIGNATURE);
    overlap.session.registerStructuralReference(importedId, importKey);
    overlap.session.attachLocator(importedId, { kind: "import-function", value: imported });
    const owner = overlap.session.beginPreparedComponentScope("import-owner", [overlap.firstUnitId]);
    owner.includeBinding(importedId);
    expect(owner.seal().bindingIds).toContain(importedId);
    const shared = overlap.session.beginPreparedComponentScope("import-overlap", [overlap.secondUnitId]);
    shared.includeBinding(importedId);
    expect(shared.seal().bindingIds).toContain(importedId);
    expect(overlap.session.publish(overlap.module).abi.entries()).toHaveLength(3);
  });

  it("closes source globals through exact storage terminals and rejects foreign storage", () => {
    const owned = fixture();
    planCallable(owned, owned.firstUnitId, "body", "first");
    const firstGlobal = planSourceGlobal(owned, "first-storage", owned.firstUnitId);

    const scoped = sealFirst(owned);
    expect(scoped.bindingIds).toContain(firstGlobal.id);
    expect(scoped.get(firstGlobal.id)?.intent).toEqual(
      expect.objectContaining({
        kind: "global",
        origin: "source",
        sourceId: owned.sourceId,
        unitId: owned.firstUnitId,
      }),
    );

    const foreign = fixture();
    planCallable(foreign, foreign.firstUnitId, "body", "first");
    planCallable(foreign, foreign.secondUnitId, "body", "second");
    const secondGlobal = planSourceGlobal(foreign, "second-storage", foreign.secondUnitId);
    const wrongScope = foreign.session.beginPreparedComponentScope("foreign-source-global", [foreign.firstUnitId]);
    wrongScope.includeBinding(secondGlobal.id);
    expectInvariant(() => wrongScope.seal(), "invalid-callable-provenance");
  });

  it("rejects missing reservations and locators atomically, then permits a corrected scope", () => {
    const missingLocator = fixture();
    const locatorId = createIrBindingId({
      ownerId: missingLocator.firstUnitId,
      domain: "callable",
      role: "body",
    });
    const locatorKey = `unit|${missingLocator.firstUnitId}|body`;
    missingLocator.session.plan(
      callableDraft(missingLocator.session, locatorId, missingLocator.firstUnitId, "first", locatorKey),
    );
    missingLocator.session.registerCallableTypeContract(locatorId, VOID_SIGNATURE);
    missingLocator.session.registerStructuralReference(locatorId, locatorKey);
    const failedLocator = missingLocator.session.beginPreparedComponentScope("missing-locator", [
      missingLocator.firstUnitId,
    ]);
    expectInvariant(() => failedLocator.seal(), "missing-required-locator");
    expectInvariant(() => failedLocator.includeBinding(locatorId), "session-closed");

    const locator: WasmFunction = {
      name: "first",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    };
    missingLocator.module.functions.push(locator);
    missingLocator.session.attachLocator(locatorId, { kind: "defined-function", value: locator });
    const corrected = missingLocator.session.beginPreparedComponentScope("corrected", [missingLocator.firstUnitId]);
    expect(corrected.seal().bindingIds).toEqual([locatorId]);

    const missingReference = fixture();
    const unreservedId = createIrBindingId({
      ownerId: missingReference.firstUnitId,
      domain: "callable",
      role: "body",
    });
    const unreservedKey = `unit|${missingReference.firstUnitId}|body`;
    const unreservedFunc: WasmFunction = {
      name: "first",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    };
    missingReference.module.functions.push(unreservedFunc);
    missingReference.session.plan(
      callableDraft(missingReference.session, unreservedId, missingReference.firstUnitId, "first", unreservedKey),
    );
    missingReference.session.registerCallableTypeContract(unreservedId, VOID_SIGNATURE);
    missingReference.session.attachLocator(unreservedId, {
      kind: "defined-function",
      value: unreservedFunc,
    });
    const failedReference = missingReference.session.beginPreparedComponentScope("missing-reference", [
      missingReference.firstUnitId,
    ]);
    expectInvariant(() => failedReference.seal(), "missing-binding-reference");
  });

  it("rejects prepared-owned late support, derived units, and locator replacement but accepts unrelated support", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    sealFirst(f);

    const lateSupportId = createIrBindingId({
      ownerId: f.firstUnitId,
      domain: "support",
      role: "late-helper",
    });
    expectInvariant(() => f.session.plan(supportDraft(f.session, lateSupportId, f.firstUnitId)), "planning-sealed");
    expectInvariant(
      () =>
        f.session.registerDerivedUnit({
          id: createDerivedIrUnitId({
            parentId: f.firstUnitId,
            role: "lifted-closure",
            ordinal: 0,
          }),
          parentId: f.firstUnitId,
          terminalOwnerId: f.firstUnitId,
          sourceId: f.sourceId,
          role: "lifted-closure",
          ordinal: 0,
        }),
      "planning-sealed",
    );
    expectInvariant(
      () =>
        f.session.replaceDefinedFunctionLocator(first.id, first.func, {
          ...first.func,
          name: "replacement",
        }),
      "locator-remap-mismatch",
    );

    const unrelatedSupportId = createIrBindingId({
      ownerId: f.secondUnitId,
      domain: "support",
      role: "late-direct-helper",
    });
    f.session.plan(supportDraft(f.session, unrelatedSupportId, f.secondUnitId));
    expect(f.session.publish(f.module).abi.resolveFinalIndex(first.id)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("pins imported host module/name, callable signature, and global mutability from exact locators", () => {
    const linkage = fixture();
    planCallable(linkage, linkage.firstUnitId, "body", "first");
    const linked = planImportedDependencies(linkage);
    sealFirst(linkage, [linked.callableId, linked.globalId]);
    linked.callable.module = "forged";
    expectInvariant(() => linkage.session.publish(linkage.module), "binding-reference-mismatch");

    const signature = fixture();
    planCallable(signature, signature.firstUnitId, "body", "first");
    const typed = planImportedDependencies(signature);
    sealFirst(signature, [typed.callableId, typed.globalId]);
    signature.module.types.push({
      kind: "func",
      name: "$forged",
      params: [{ kind: "i32" }],
      results: [],
    });
    if (typed.callable.desc.kind !== "func") throw new Error("invalid callable import fixture");
    typed.callable.desc.typeIdx = 1;
    expectInvariant(() => signature.session.publish(signature.module), "type-remap-mismatch");

    const mutability = fixture();
    planCallable(mutability, mutability.firstUnitId, "body", "first");
    const global = planImportedDependencies(mutability);
    sealFirst(mutability, [global.callableId, global.globalId]);
    if (global.global.desc.kind !== "global") throw new Error("invalid global import fixture");
    global.global.name = "forged_global";
    expectInvariant(() => mutability.session.publish(mutability.module), "binding-reference-mismatch");

    const storage = fixture();
    planCallable(storage, storage.firstUnitId, "body", "first");
    const stored = planImportedDependencies(storage);
    sealFirst(storage, [stored.callableId, stored.globalId]);
    if (stored.global.desc.kind !== "global") throw new Error("invalid global import fixture");
    stored.global.desc.mutable = false;
    expectInvariant(() => storage.session.publish(storage.module), "type-remap-mismatch");
  });

  it("fails closed when the reserved callable contract drifts before final reconciliation", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    sealFirst(f);
    f.module.types.push({ kind: "func", name: "$i32", params: [{ kind: "i32" }], results: [] });
    first.func.typeIdx = 1;

    expectInvariant(() => f.session.publish(f.module), "type-remap-mismatch");
    expectInvariant(() => f.session.publish(f.module), "session-publish-once");
  });

  it("advances pinned structured contracts only through an explicit type-layout remap", () => {
    const f = fixture();
    const previousTypes = [
      { kind: "struct" as const, name: "$Payload", fields: [] },
      {
        kind: "func" as const,
        name: "$consume",
        params: [{ kind: "ref" as const, typeIdx: 0 }],
        results: [],
      },
    ];
    f.module.types = previousTypes;
    const contract = Object.freeze({
      params: Object.freeze([{ kind: "ref" as const, typeIdx: 0 }]),
      results: Object.freeze([]),
    });
    const id = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" });
    const referenceKey = `unit|${f.firstUnitId}|body`;
    const func: WasmFunction = {
      name: "first",
      typeIdx: 1,
      locals: [],
      body: [],
      exported: false,
    };
    f.module.functions.push(func);
    f.session.plan({
      ...callableDraft(f.session, id, f.firstUnitId, "first", referenceKey),
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(contract),
        unitId: f.firstUnitId,
      },
    });
    f.session.registerCallableTypeContract(id, contract);
    f.session.registerStructuralReference(id, referenceKey);
    f.session.attachLocator(id, { kind: "defined-function", value: func });
    sealFirst(f);

    const nextTypes = [
      {
        kind: "func" as const,
        name: "$consume",
        params: [{ kind: "ref" as const, typeIdx: 1 }],
        results: [],
      },
      { kind: "struct" as const, name: "$Payload", fields: [] },
    ];
    f.session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [1, 0],
    });
    f.module.types = nextTypes;
    func.typeIdx = 0;

    expect(f.session.publish(f.module).abi.resolveFinalIndex(id)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("records only the backend's reported leaf finalization in a sealed reachable type graph", () => {
    const accepted = fixture();
    const acceptedLeaf = planLeafReachableCallable(accepted);
    sealFirst(accepted);

    const finalized = markLeafStructsFinal(accepted.module);
    expect(finalized).toEqual([1]);
    accepted.session.recordLeafTypeFinalization(finalized);
    expect(accepted.session.publish(accepted.module).abi.resolveFinalIndex(acceptedLeaf.id)).toEqual({
      space: "function",
      index: 0,
    });

    const drift = fixture();
    const driftLeaf = planLeafReachableCallable(drift);
    sealFirst(drift);
    driftLeaf.leafType.final = true;
    if (driftLeaf.leafType.kind !== "struct") throw new Error("invalid leaf finalization fixture");
    driftLeaf.leafType.fields.push({ name: "late", type: { kind: "i32" }, mutable: false });
    expectInvariant(() => drift.session.recordLeafTypeFinalization([1]), "type-remap-mismatch");
  });

  it("records reported leaf finalization for an explicit prepared support-type root", () => {
    const accepted = fixture();
    planCallable(accepted, accepted.firstUnitId, "body", "first");
    const acceptedLeaf = planExplicitLeafSupportType(accepted);
    const scoped = sealFirst(accepted, [acceptedLeaf.id]);

    const finalized = markLeafStructsFinal(accepted.module);
    expect(finalized).toEqual([2]);
    accepted.session.recordLeafTypeFinalization(finalized);
    expect(scoped.get(acceptedLeaf.id)?.intent).toEqual(
      expect.objectContaining({ kind: "type", shapeKey: expect.stringContaining('"final":true') }),
    );
    expect(accepted.session.publish(accepted.module).abi.resolveFinalIndex(acceptedLeaf.id)).toEqual({
      space: "type",
      index: 2,
    });

    const unreported = fixture();
    planCallable(unreported, unreported.firstUnitId, "body", "first");
    const unreportedLeaf = planExplicitLeafSupportType(unreported);
    sealFirst(unreported, [unreportedLeaf.id]);
    unreportedLeaf.leafType.final = true;
    expectInvariant(() => unreported.session.recordLeafTypeFinalization([1]), "type-remap-mismatch");
  });

  it("refreshes an explicit prepared class draft after reported leaf finalization", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const layouts = planPreparedLayouts(f);
    if (layouts.classValue.kind !== "struct") throw new Error("invalid prepared class fixture");
    layouts.classValue.superTypeIdx = -1;
    layouts.classValue.final = false;
    const scoped = sealFirst(f, [layouts.classId]);

    const finalized = markLeafStructsFinal(f.module);
    expect(finalized).toContain(f.module.types.indexOf(layouts.classValue));
    f.session.recordLeafTypeFinalization(finalized);
    f.session.ensurePlan({
      ...classDraft(f, layouts.classId, `class|${layouts.classId}`),
      intent: {
        kind: "class",
        classId: f.classId,
        layoutKey: canonicalProgramAbiTypeDef(layouts.classValue),
      },
    });
    expect(scoped.get(layouts.classId)?.intent).toEqual(
      expect.objectContaining({ kind: "class", layoutKey: expect.stringContaining('"final":true') }),
    );
  });

  it("refreshes callable and global aliases that inherit canonical contracts during a valid reorder", () => {
    const f = fixture();
    const previousTypes: TypeDef[] = [
      {
        kind: "struct",
        name: "$Payload",
        fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
      },
      {
        kind: "func",
        name: "$consume",
        params: [{ kind: "ref", typeIdx: 0 }],
        results: [],
      },
    ];
    f.module.types = previousTypes;
    const callableContract: ProgramAbiCallableTypeContract = Object.freeze({
      params: Object.freeze([{ kind: "ref" as const, typeIdx: 0 }]),
      results: Object.freeze([]),
    });
    const callableId = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" });
    const callableKey = `unit|${f.firstUnitId}|body`;
    const func: WasmFunction = {
      name: "first",
      typeIdx: 1,
      locals: [],
      body: [],
      exported: false,
    };
    f.module.functions.push(func);
    f.session.plan({
      ...callableDraft(f.session, callableId, f.firstUnitId, "first", callableKey),
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(callableContract),
        unitId: f.firstUnitId,
      },
    });
    f.session.registerCallableTypeContract(callableId, callableContract);
    f.session.registerStructuralReference(callableId, callableKey);
    f.session.attachLocator(callableId, { kind: "defined-function", value: func });

    const callableAliasId = createIrBindingId({
      ownerId: f.firstUnitId,
      domain: "callable",
      role: "inherited-callable-contract",
    });
    f.session.plan(ownedAliasDraft(f, callableAliasId, callableId, f.firstUnitId, callableContract));

    const globalType = { kind: "ref" as const, typeIdx: 0 };
    const globalValueType = canonicalProgramAbiValType(globalType);
    const globalId = createIrBindingId({ ownerId: f.sourceId, domain: "global", role: "canonical-global" });
    const globalKey = "import-global|3:env|13:payload_global";
    const global: Import = {
      module: "env",
      name: "payload_global",
      desc: { kind: "global", type: globalType, mutable: true },
    };
    f.module.imports.push(global);
    f.session.plan({
      ...importedGlobalDraft(f, globalId, globalKey),
      intent: { kind: "global", origin: "import", valueType: globalValueType, mutable: true },
    });
    f.session.registerGlobalTypeContract(globalId, globalType, true);
    f.session.registerStructuralReference(globalId, globalKey);
    f.session.attachLocator(globalId, { kind: "import-global", value: global });
    const globalAliasId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "global",
      role: "inherited-global-contract",
    });
    f.session.plan(globalAliasDraft(f, globalAliasId, globalId, globalValueType));

    const scoped = sealFirst(f, [globalId]);
    expect(scoped.bindingIds).toEqual(expect.arrayContaining([callableId, callableAliasId, globalId, globalAliasId]));

    const nextTypes: TypeDef[] = [
      {
        kind: "func",
        name: "$consume$reordered",
        params: [{ kind: "ref", typeIdx: 1 }],
        results: [],
      },
      {
        kind: "struct",
        name: "$Payload$reordered",
        fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
      },
    ];
    f.session.applyTypeLayoutRemap({ previousTypes, nextTypes, targetsByOldIndex: [1, 0] });
    f.module.types = nextTypes;
    func.typeIdx = 0;
    if (global.desc.kind !== "global") throw new Error("invalid global alias fixture");
    global.desc.type = { kind: "ref", typeIdx: 1 };

    const publication = f.session.publish(f.module);
    expect(publication.abi.canonicalId(callableAliasId)).toBe(callableId);
    expect(publication.abi.canonicalId(globalAliasId)).toBe(globalId);
  });

  it("pins type/class layouts structurally and advances them only through exact DCE layout remaps", () => {
    const drift = fixture();
    planCallable(drift, drift.firstUnitId, "body", "first");
    const driftLayouts = planPreparedLayouts(drift);
    sealFirst(drift, [driftLayouts.typeId, driftLayouts.classId]);
    expectInvariant(
      () =>
        drift.session.remapTypeCell(driftLayouts.typeCell, {
          kind: "struct",
          name: "$Forged",
          fields: [],
        }),
      "type-remap-mismatch",
    );
    if (driftLayouts.classValue.kind !== "struct") throw new Error("invalid class layout fixture");
    driftLayouts.classValue.fields.push({
      name: "late",
      type: { kind: "i32" },
      mutable: false,
    });
    expectInvariant(() => drift.session.publish(drift.module), "type-remap-mismatch");

    const forgedRemap = fixture();
    planCallable(forgedRemap, forgedRemap.firstUnitId, "body", "first");
    const forgedLayouts = planPreparedLayouts(forgedRemap);
    sealFirst(forgedRemap, [forgedLayouts.typeId, forgedLayouts.classId]);
    const forgedPrevious = forgedRemap.module.types;
    const forgedNext: TypeDef[] = [
      forgedPrevious[0]!,
      { kind: "struct", name: "$ForgedClass", fields: [] },
      forgedPrevious[1]!,
    ];
    expectInvariant(
      () =>
        forgedRemap.session.applyTypeLayoutRemap({
          previousTypes: forgedPrevious,
          nextTypes: forgedNext,
          targetsByOldIndex: [0, 2, 1],
        }),
      "type-remap-mismatch",
    );
    expect(forgedRemap.session.publish(forgedRemap.module).abi.resolveFinalIndex(forgedLayouts.classId)).toEqual({
      space: "type",
      index: 2,
    });

    const remapped = fixture();
    planCallable(remapped, remapped.firstUnitId, "body", "first");
    const exactLayouts = planPreparedLayouts(remapped);
    sealFirst(remapped, [exactLayouts.typeId, exactLayouts.classId]);
    const previousTypes = remapped.module.types;
    if (exactLayouts.typeValue.kind !== "struct" || exactLayouts.classValue.kind !== "struct") {
      throw new Error("invalid exact layout fixture");
    }
    const nextClass: TypeDef = {
      ...exactLayouts.classValue,
      name: "$PreparedClass$remapped",
      fields: exactLayouts.classValue.fields.map((field) => ({ ...field, type: { ...field.type } })),
    };
    const nextType: TypeDef = {
      ...exactLayouts.typeValue,
      name: "$PreparedType$remapped",
      fields: exactLayouts.typeValue.fields.map((field) => ({ ...field, type: { ...field.type } })),
    };
    const nextTypes = [previousTypes[0]!, nextClass, nextType];
    remapped.session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [0, 2, 1],
    });
    remapped.module.types = nextTypes;
    const publication = remapped.session.publish(remapped.module);
    expect(publication.abi.resolveFinalIndex(exactLayouts.typeId)).toEqual({
      space: "type",
      index: 2,
    });
    expect(publication.abi.resolveFinalIndex(exactLayouts.classId)).toEqual({
      space: "type",
      index: 1,
    });
  });

  it("rejects payload-shape swaps reachable from class fields and callable parameters", () => {
    const f = fixture();
    const previousTypes: TypeDef[] = [
      {
        kind: "struct",
        name: "$Base",
        fields: [{ name: "base", type: { kind: "i32" }, mutable: false }],
      },
      {
        kind: "struct",
        name: "$ClassPayload",
        superTypeIdx: 0,
        fields: [{ name: "classValue", type: { kind: "i32" }, mutable: false }],
      },
      {
        kind: "struct",
        name: "$CallablePayload",
        fields: [{ name: "callValue", type: { kind: "f64" }, mutable: true }],
      },
      {
        kind: "struct",
        name: "$PreparedClass",
        fields: [{ name: "payload", type: { kind: "ref", typeIdx: 1 }, mutable: true }],
      },
      {
        kind: "func",
        name: "$consume",
        params: [{ kind: "ref", typeIdx: 2 }],
        results: [],
      },
    ];
    f.module.types = previousTypes;
    const callableContract: ProgramAbiCallableTypeContract = Object.freeze({
      params: Object.freeze([{ kind: "ref" as const, typeIdx: 2 }]),
      results: Object.freeze([]),
    });
    const callableId = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" });
    const callableKey = `unit|${f.firstUnitId}|body`;
    const func: WasmFunction = {
      name: "first",
      typeIdx: 4,
      locals: [],
      body: [],
      exported: false,
    };
    f.module.functions.push(func);
    f.session.plan({
      ...callableDraft(f.session, callableId, f.firstUnitId, "first", callableKey),
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(callableContract),
        unitId: f.firstUnitId,
      },
    });
    f.session.registerCallableTypeContract(callableId, callableContract);
    f.session.registerStructuralReference(callableId, callableKey);
    f.session.attachLocator(callableId, { kind: "defined-function", value: func });

    const classId = createIrBindingId({ ownerId: f.classId, domain: "class", role: "prepared-class" });
    const classKey = `class|${classId}`;
    f.session.plan(classDraft(f, classId, classKey));
    f.session.registerStructuralReference(classId, classKey);
    const classCell = f.session.createTypeCell(previousTypes[3]!);
    f.session.attachLocator(classId, { kind: "type-cell", cell: classCell });
    sealFirst(f, [classId]);

    const maliciousPermutation: TypeDef[] = [
      previousTypes[0]!,
      {
        kind: "struct",
        name: "$ClassPayload$wrong-target",
        superTypeIdx: 0,
        fields: [{ name: "classValue", type: { kind: "i32" }, mutable: false }],
      },
      {
        kind: "struct",
        name: "$CallablePayload$wrong-target",
        fields: [{ name: "callValue", type: { kind: "f64" }, mutable: true }],
      },
      {
        kind: "struct",
        name: "$PreparedClass$permuted",
        fields: [{ name: "payload", type: { kind: "ref", typeIdx: 2 }, mutable: true }],
      },
      {
        kind: "func",
        name: "$consume$permuted",
        params: [{ kind: "ref", typeIdx: 1 }],
        results: [],
      },
    ];
    expectInvariant(
      () =>
        f.session.applyTypeLayoutRemap({
          previousTypes,
          nextTypes: maliciousPermutation,
          targetsByOldIndex: [0, 2, 1, 3, 4],
        }),
      "type-remap-mismatch",
    );
    expect(f.session.publish(f.module).abi.resolveFinalIndex(classId)).toEqual({ space: "type", index: 3 });
  });

  it("preserves an open-root struct sentinel through a scoped callable/class type reorder", () => {
    const f = fixture();
    const previousTypes: TypeDef[] = [
      {
        kind: "struct",
        name: "$OpenRoot",
        superTypeIdx: -1,
        fields: [{ name: "rootValue", type: { kind: "i32" }, mutable: false }],
      },
      {
        kind: "struct",
        name: "$PreparedClass",
        superTypeIdx: 0,
        fields: [{ name: "root", type: { kind: "ref", typeIdx: 0 }, mutable: true }],
      },
      {
        kind: "func",
        name: "$consumeOpenRoot",
        params: [{ kind: "ref", typeIdx: 0 }],
        results: [],
      },
    ];
    f.module.types = previousTypes;
    const callableContract: ProgramAbiCallableTypeContract = Object.freeze({
      params: Object.freeze([{ kind: "ref" as const, typeIdx: 0 }]),
      results: Object.freeze([]),
    });
    const callableId = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" });
    const callableKey = `unit|${f.firstUnitId}|body`;
    const func: WasmFunction = {
      name: "first",
      typeIdx: 2,
      locals: [],
      body: [],
      exported: false,
    };
    f.module.functions.push(func);
    f.session.plan({
      ...callableDraft(f.session, callableId, f.firstUnitId, "first", callableKey),
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(callableContract),
        unitId: f.firstUnitId,
      },
    });
    f.session.registerCallableTypeContract(callableId, callableContract);
    f.session.registerStructuralReference(callableId, callableKey);
    f.session.attachLocator(callableId, { kind: "defined-function", value: func });

    const classId = createIrBindingId({ ownerId: f.classId, domain: "class", role: "open-root-class" });
    const classKey = `class|${classId}`;
    f.session.plan(classDraft(f, classId, classKey));
    f.session.registerStructuralReference(classId, classKey);
    const classCell = f.session.createTypeCell(previousTypes[1]!);
    f.session.attachLocator(classId, { kind: "type-cell", cell: classCell });
    sealFirst(f, [classId]);

    const nextTypes: TypeDef[] = [
      {
        kind: "func",
        name: "$consumeOpenRoot$reordered",
        params: [{ kind: "ref", typeIdx: 2 }],
        results: [],
      },
      {
        kind: "struct",
        name: "$PreparedClass$reordered",
        superTypeIdx: 2,
        fields: [{ name: "root", type: { kind: "ref", typeIdx: 2 }, mutable: true }],
      },
      {
        kind: "struct",
        name: "$OpenRoot$reordered",
        superTypeIdx: -1,
        fields: [{ name: "rootValue", type: { kind: "i32" }, mutable: false }],
      },
    ];
    f.session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [2, 1, 0],
    });
    f.module.types = nextTypes;
    func.typeIdx = 0;
    f.session.ensurePlan({
      ...classDraft(f, classId, classKey),
      intent: {
        kind: "class",
        classId: f.classId,
        layoutKey: canonicalProgramAbiTypeDef(nextTypes[1]!),
      },
    });

    const publication = f.session.publish(f.module);
    expect(nextTypes[2]).toMatchObject({ kind: "struct", superTypeIdx: -1 });
    expect(publication.abi.resolveFinalIndex(classId)).toEqual({ space: "type", index: 1 });
    expect(publication.abi.resolveFinalIndex(callableId)).toEqual({ space: "function", index: 0 });
  });

  it("rejects alias cycles, duplicate discovery, custom IDs, and post-seal locator removal", () => {
    const cycle = fixture();
    planCallable(cycle, cycle.firstUnitId, "body", "first");
    const aliasA = createIrBindingId({ ownerId: cycle.sourceId, domain: "callable", role: "cycle-a" });
    const aliasB = createIrBindingId({ ownerId: cycle.sourceId, domain: "callable", role: "cycle-b" });
    cycle.session.plan(aliasDraft(cycle, aliasA, aliasB, 0));
    cycle.session.plan(aliasDraft(cycle, aliasB, aliasA, 1));
    const cyclic = cycle.session.beginPreparedComponentScope("alias-cycle", [cycle.firstUnitId]);
    cyclic.includeBinding(aliasA);
    expectInvariant(() => cyclic.seal(), "alias-cycle");

    const duplicate = fixture();
    planCallable(duplicate, duplicate.firstUnitId, "body", "first");
    const supportId = createIrBindingId({
      ownerId: duplicate.firstUnitId,
      domain: "support",
      role: "duplicate",
    });
    duplicate.session.plan(supportDraft(duplicate.session, supportId, duplicate.firstUnitId));
    const duplicateDiscovery = duplicate.session.beginPreparedComponentScope("duplicate", [duplicate.firstUnitId]);
    duplicateDiscovery.includeBinding(supportId);
    expectInvariant(() => duplicateDiscovery.includeBinding(supportId), "duplicate-session-draft");
    duplicateDiscovery.abort();

    const custom = fixture();
    const customId = "custom-callable-id" as IrBindingId;
    const customKey = `unit|${custom.firstUnitId}|body`;
    const customFunc: WasmFunction = {
      name: "first",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    };
    custom.module.functions.push(customFunc);
    custom.session.plan(callableDraft(custom.session, customId, custom.firstUnitId, "first", customKey));
    custom.session.registerCallableTypeContract(customId, VOID_SIGNATURE);
    custom.session.registerStructuralReference(customId, customKey);
    custom.session.attachLocator(customId, { kind: "defined-function", value: customFunc });
    expectInvariant(
      () => custom.session.beginPreparedComponentScope("custom-id", [custom.firstUnitId]).seal(),
      "invalid-binding-reference",
    );

    const removed = fixture();
    planCallable(removed, removed.firstUnitId, "body", "first");
    sealFirst(removed);
    removed.module.functions.splice(0, 1);
    expectInvariant(() => removed.session.publish(removed.module), "eliminated-required-locator");
  });

  it("aborts discovery without publishing a partial scope or closing unrelated planning", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const unknownSupportId = createIrBindingId({
      ownerId: f.firstUnitId,
      domain: "support",
      role: "not-yet-planned",
    });
    const failed = f.session.beginPreparedComponentScope("failed-discovery", [f.firstUnitId]);
    failed.includeBinding(unknownSupportId);
    expectInvariant(() => failed.seal(), "unknown-binding");
    expectInvariant(() => failed.abort(), "session-closed");

    f.session.plan(supportDraft(f.session, unknownSupportId, f.firstUnitId));
    const retry = f.session.beginPreparedComponentScope("retry", [f.firstUnitId]);
    retry.includeBinding(unknownSupportId);
    expect(retry.seal().bindingIds).toContain(unknownSupportId);
    expect(f.session.publish(f.module).abi.get(unknownSupportId)?.intent).toEqual({
      kind: "support",
      role: "prepared-support",
    });
  });

  it("requires open scope transactions to abort or seal before whole-program sealing", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const transaction = f.session.beginPreparedComponentScope("open", [f.firstUnitId]);
    expectInvariant(() => f.session.sealPlan(f.module), "planning-not-sealed");
    transaction.abort();
    expect(f.session.publish(f.module).abi.entries()).toHaveLength(1);
  });
});
