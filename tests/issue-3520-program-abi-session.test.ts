// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  ProgramAbiSession,
  programAbiDomainOrdinal,
  type ProgramAbiDraft,
} from "../src/codegen/program-abi-session.js";
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
  ProgramAbiMap,
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

interface SessionFixture {
  readonly inventory: IrUnitInventory;
  readonly sourceId: IrSourceId;
  readonly sourceOrder: number;
  readonly firstUnitId: IrUnitId;
  readonly secondUnitId: IrUnitId;
}

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sessionFixture(fileName = "/repo/session.ts"): SessionFixture {
  const file = source(
    fileName,
    `
      function first() {}
      function second() {}
    `,
  );
  const inventory = buildIrUnitInventory([file], { entrySource: file });
  const first = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "first");
  const second = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "second");
  if (!first || !second) throw new Error("invalid ABI session fixture");
  return {
    inventory,
    sourceId: inventory.sources[0]!.id,
    sourceOrder: inventory.sources[0]!.order,
    firstUnitId: first.id,
    secondUnitId: second.id,
  };
}

function binding(
  fixture: SessionFixture,
  domain: "callable" | "global" | "type" | "export" | "support",
  role: string,
  ownerId: IrSourceId | IrUnitId = fixture.sourceId,
): IrBindingId {
  return createIrBindingId({ ownerId, domain, role });
}

function structuralOrder(
  fixture: SessionFixture,
  domain: ProgramAbiDraft["intent"]["kind"],
  declarationOrdinal: number,
  roleOrdinal = 0,
  derivedOrdinal = 0,
) {
  return {
    sourceId: fixture.sourceId,
    declarationOrdinal,
    domainOrdinal: programAbiDomainOrdinal(domain),
    roleOrdinal,
    derivedOrdinal,
  };
}

function callableDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  unitId: IrUnitId,
  displayName: string,
  declarationOrdinal: number,
  roleOrdinal = 0,
  derivedOrdinal = 0,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "callable", declarationOrdinal, roleOrdinal, derivedOrdinal),
    displayName,
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

function globalDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "global", declarationOrdinal),
    displayName,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "source",
      valueType: "i32",
      mutable: true,
    },
  };
}

function typeDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "type", declarationOrdinal),
    displayName,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "type", shapeKey: "struct:x=i32" },
  };
}

function callableAliasDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "callable", declarationOrdinal),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "callable",
      origin: "import",
      signature: VOID_SIGNATURE,
    },
  };
}

function supportDraft(fixture: SessionFixture, id: IrBindingId, declarationOrdinal: number): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "support", declarationOrdinal),
    displayName: "support",
    slotPolicy: "none",
    intent: { kind: "support", role: "session-marker" },
  };
}

function wasmFunction(name: string, typeIdx = 0): WasmFunction {
  return { name, typeIdx, locals: [], body: [], exported: false };
}

function wasmGlobal(name: string): GlobalDef {
  return {
    name,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
}

function functionType(name: string): TypeDef {
  return { kind: "func", name, params: [], results: [] };
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

interface DeterministicSession {
  readonly publication: ReturnType<ProgramAbiSession["publish"]>;
  readonly ids: {
    readonly first: IrBindingId;
    readonly second: IrBindingId;
    readonly global: IrBindingId;
    readonly type: IrBindingId;
    readonly alias: IrBindingId;
  };
}

function buildDeterministicSession(reverse: boolean): DeterministicSession {
  const fixture = sessionFixture();
  const module = createEmptyModule();
  const fnType = functionType("$void");
  const recordType: TypeDef = { kind: "struct", name: "$Record", fields: [] };
  const firstFn = wasmFunction("same");
  const secondFn = wasmFunction("same");
  const global = wasmGlobal("same");
  module.types.push(fnType, recordType);
  module.functions.push(firstFn, secondFn);
  module.globals.push(global);

  const first = binding(fixture, "callable", "body", fixture.firstUnitId);
  const second = binding(fixture, "callable", "body", fixture.secondUnitId);
  const globalId = binding(fixture, "global", "state");
  const typeId = binding(fixture, "type", "record");
  const alias = binding(fixture, "callable", "alias");
  const support = binding(fixture, "support", "marker");
  const drafts = [
    callableDraft(fixture, first, fixture.firstUnitId, "same", 0),
    callableDraft(fixture, second, fixture.secondUnitId, "same", 1),
    globalDraft(fixture, globalId, "same", 2),
    typeDraft(fixture, typeId, "same", 3),
    callableAliasDraft(fixture, alias, first, "same-alias", 4),
    supportDraft(fixture, support, 5),
  ];

  const session = new ProgramAbiSession(fixture.inventory, module);
  for (const draft of reverse ? [...drafts].reverse() : drafts) session.plan(draft);
  const typeCell = session.createTypeCell(recordType);
  session.attachLocator(first, { kind: "defined-function", value: firstFn });
  session.attachLocator(second, { kind: "defined-function", value: secondFn });
  session.attachLocator(globalId, { kind: "defined-global", value: global });
  session.attachLocator(typeId, { kind: "type-cell", cell: typeCell });
  return {
    publication: session.publish(module),
    ids: { first, second, global: globalId, type: typeId, alias },
  };
}

describe("#3520 ProgramAbiSession", () => {
  it("publishes deterministic dense plans from structural order, not registration order", () => {
    const forward = buildDeterministicSession(false);
    const reversed = buildDeterministicSession(true);

    expect(reversed.publication.abi.entries().map((entry) => entry.id)).toEqual(
      forward.publication.abi.entries().map((entry) => entry.id),
    );
    expect(forward.publication.abi.entries().map((entry) => entry.order.declarationOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.first)).toEqual({
      space: "function",
      index: 0,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.second)).toEqual({
      space: "function",
      index: 1,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.global)).toEqual({
      space: "global",
      index: 0,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.type)).toEqual({
      space: "type",
      index: 1,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.alias)).toEqual({
      space: "function",
      index: 0,
    });

    const required = forward.publication.abi.entries().filter((entry) => entry.slotPolicy === "required");
    const finalKeys = required.map((entry) => {
      const final = forward.publication.abi.resolveFinalIndex(entry.id)!;
      return `${final.space}:${final.index}`;
    });
    expect(finalKeys).toHaveLength(4);
    expect(new Set(finalKeys)).toHaveLength(4);
    expectInvariant(
      () => forward.publication.legacy.resolveUniqueLegacyName("function", "same"),
      "ambiguous-legacy-name",
    );
    expect(forward.publication.legacy.internalWasmName(forward.ids.first)).not.toBe(
      forward.publication.legacy.internalWasmName(forward.ids.second),
    );
  });

  it("tracks derived lifted and clone units through explicit parent provenance in any queue order", () => {
    const fixture = sessionFixture();
    const firstRecord = fixture.inventory.allUnits.find((unit) => unit.id === fixture.firstUnitId)!;
    const secondRecord = fixture.inventory.allUnits.find((unit) => unit.id === fixture.secondUnitId)!;
    const liftedFirst = createDerivedIrUnitId({
      parentId: fixture.firstUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const liftedSecond = createDerivedIrUnitId({
      parentId: fixture.secondUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const cloneFirst = createDerivedIrUnitId({
      parentId: liftedFirst,
      role: "monomorphization-clone",
      ordinal: 2,
    });
    const records: ProgramAbiDerivedUnitRecord[] = [
      {
        id: liftedFirst,
        parentId: fixture.firstUnitId,
        terminalOwnerId: firstRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: liftedSecond,
        parentId: fixture.secondUnitId,
        terminalOwnerId: secondRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: cloneFirst,
        parentId: liftedFirst,
        terminalOwnerId: firstRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "monomorphization-clone",
        ordinal: 2,
      },
    ];
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const functions = [wasmFunction("lifted"), wasmFunction("lifted"), wasmFunction("clone")];
    module.functions.push(...functions);
    const ids = [
      binding(fixture, "callable", "body", liftedFirst),
      binding(fixture, "callable", "body", liftedSecond),
      binding(fixture, "callable", "body", cloneFirst),
    ];
    const session = new ProgramAbiSession(fixture.inventory, module);
    for (const record of [...records].reverse()) session.registerDerivedUnit(record);
    session.plan(callableDraft(fixture, ids[2]!, cloneFirst, "clone", 0, 0, 2));
    session.plan(callableDraft(fixture, ids[1]!, liftedSecond, "lifted", 0, 0, 1));
    session.plan(callableDraft(fixture, ids[0]!, liftedFirst, "lifted", 0, 0, 0));
    ids.forEach((id, index) => session.attachLocator(id, { kind: "defined-function", value: functions[index]! }));

    const { abi } = session.publish(module);
    expect(ids.map((id) => abi.resolveFinalIndex(id)?.index)).toEqual([0, 1, 2]);
    expect(abi.entries().map((entry) => entry.id)).toEqual(ids);
  });

  it("orders colliding derived ordinals by their complete provenance paths", () => {
    const fixture = sessionFixture();
    const owner = fixture.inventory.allUnits.find((unit) => unit.id === fixture.firstUnitId)!;
    const liftedFirst = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const liftedSecond = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 1,
    });
    const cloneOfFirst = createDerivedIrUnitId({
      parentId: liftedFirst,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    const cloneOfSecond = createDerivedIrUnitId({
      parentId: liftedSecond,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    const unitIds = [owner.id, liftedFirst, cloneOfFirst, liftedSecond, cloneOfSecond];
    const records: ProgramAbiDerivedUnitRecord[] = [
      {
        id: liftedFirst,
        parentId: owner.id,
        terminalOwnerId: owner.terminalOwnerId,
        sourceId: owner.sourceId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: liftedSecond,
        parentId: owner.id,
        terminalOwnerId: owner.terminalOwnerId,
        sourceId: owner.sourceId,
        role: "lifted-closure",
        ordinal: 1,
      },
      {
        id: cloneOfFirst,
        parentId: liftedFirst,
        terminalOwnerId: owner.terminalOwnerId,
        sourceId: owner.sourceId,
        role: "monomorphization-clone",
        ordinal: 0,
      },
      {
        id: cloneOfSecond,
        parentId: liftedSecond,
        terminalOwnerId: owner.terminalOwnerId,
        sourceId: owner.sourceId,
        role: "monomorphization-clone",
        ordinal: 0,
      },
    ];
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const functions = ["owner", "lifted-0", "clone-of-lifted-0", "lifted-1", "clone-of-lifted-1"].map((name) =>
      wasmFunction(name),
    );
    module.functions.push(...functions);

    const session = new ProgramAbiSession(fixture.inventory, module);
    // Register children before parents to prove ordering comes from the
    // complete structural records rather than queue order.
    for (const record of [...records].reverse()) session.registerDerivedUnit(record);

    const ids = unitIds.map((unitId) => binding(fixture, "callable", "body", unitId));
    const drafts = unitIds.map(
      (unitId, index): ProgramAbiDraft => ({
        id: ids[index]!,
        structuralOrder: session.structuralOrder.forUnit(unitId, {
          domain: "callable",
          roleOrdinal: 0,
        }),
        displayName: functions[index]!.name,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "source",
          signature: VOID_SIGNATURE,
          unitId,
        },
      }),
    );
    expect(drafts.map((draft) => draft.structuralOrder.derivedOrdinal)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(drafts.map((draft) => JSON.stringify(draft.structuralOrder))).size).toBe(drafts.length);
    const lateLift = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 2,
    });
    expectInvariant(
      () =>
        session.registerDerivedUnit({
          id: lateLift,
          parentId: owner.id,
          terminalOwnerId: owner.terminalOwnerId,
          sourceId: owner.sourceId,
          role: "lifted-closure",
          ordinal: 2,
        }),
      "planning-sealed",
    );
    const independentOwner = fixture.inventory.allUnits.find((unit) => unit.id === fixture.secondUnitId)!;
    const independentLift = createDerivedIrUnitId({
      parentId: independentOwner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const independentClone = createDerivedIrUnitId({
      parentId: independentLift,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    // A sealed source root must not prevent a distinct root from accepting
    // child-first provenance.
    session.registerDerivedUnit({
      id: independentClone,
      parentId: independentLift,
      terminalOwnerId: independentOwner.terminalOwnerId,
      sourceId: independentOwner.sourceId,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    session.registerDerivedUnit({
      id: independentLift,
      parentId: independentOwner.id,
      terminalOwnerId: independentOwner.terminalOwnerId,
      sourceId: independentOwner.sourceId,
      role: "lifted-closure",
      ordinal: 0,
    });
    expect(
      session.structuralOrder.forUnit(independentLift, {
        domain: "callable",
        roleOrdinal: 0,
      }).derivedOrdinal,
    ).toBe(1);
    expect(
      session.structuralOrder.forUnit(independentClone, {
        domain: "callable",
        roleOrdinal: 0,
      }).derivedOrdinal,
    ).toBe(2);

    // Planning is reversed as well. Publication must recover owner-first,
    // depth-first provenance order, with each parent preceding its clone.
    for (const draft of [...drafts].reverse()) session.plan(draft);
    ids.forEach((id, index) => session.attachLocator(id, { kind: "defined-function", value: functions[index]! }));

    const { abi } = session.publish(module);
    expect(
      abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable")
        .map((entry) => entry.id),
    ).toEqual(ids);
    expect(ids.map((id) => abi.resolveFinalIndex(id)?.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("resolves imported and defined slots after late function/global import shifts", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const definedFn = wasmFunction("same");
    const definedGlobal = wasmGlobal("same");
    module.functions.push(definedFn);
    module.globals.push(definedGlobal);

    const definedFnId = binding(fixture, "callable", "defined", fixture.firstUnitId);
    const importFnId = binding(fixture, "callable", "import");
    const definedGlobalId = binding(fixture, "global", "defined");
    const importGlobalId = binding(fixture, "global", "import");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(callableDraft(fixture, definedFnId, fixture.firstUnitId, "same", 0));
    session.plan({
      id: importFnId,
      structuralOrder: structuralOrder(fixture, "callable", 1),
      displayName: "same",
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "import", signature: VOID_SIGNATURE },
    });
    session.plan(globalDraft(fixture, definedGlobalId, "same", 2));
    session.plan({
      id: importGlobalId,
      structuralOrder: structuralOrder(fixture, "global", 3),
      displayName: "same",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "import",
        valueType: "i32",
        mutable: true,
      },
    });
    session.attachLocator(definedFnId, { kind: "defined-function", value: definedFn });
    session.attachLocator(definedGlobalId, { kind: "defined-global", value: definedGlobal });

    const globalImport: Import = {
      module: "env",
      name: "same",
      desc: { kind: "global", type: { kind: "i32" }, mutable: true },
    };
    const functionImport: Import = {
      module: "env",
      name: "same",
      desc: { kind: "func", typeIdx: 0 },
    };
    module.imports.push(globalImport, functionImport);
    session.attachLocator(importFnId, { kind: "import-function", value: functionImport });
    session.attachLocator(importGlobalId, { kind: "import-global", value: globalImport });

    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(importFnId)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(definedFnId)).toEqual({ space: "function", index: 1 });
    expect(abi.resolveFinalIndex(importGlobalId)).toEqual({ space: "global", index: 0 });
    expect(abi.resolveFinalIndex(definedGlobalId)).toEqual({ space: "global", index: 1 });
  });

  it("follows an explicit type-cell remap through type compaction", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const original: TypeDef = { kind: "struct", name: "$Record", fields: [] };
    module.types.push(removed, original);
    const id = binding(fixture, "type", "record");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(typeDraft(fixture, id, "Record", 0));
    const cell = session.createTypeCell(original);
    session.attachLocator(id, { kind: "type-cell", cell });

    const compacted: TypeDef = { ...original, fields: [] };
    module.types.splice(0, module.types.length, compacted);
    session.remapTypeCell(cell, compacted);
    expect(session.publish(module).abi.resolveFinalIndex(id)).toEqual({ space: "type", index: 0 });
  });

  it("rejects duplicate/invalid drafts and structural-order ties before publish", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const session = new ProgramAbiSession(fixture.inventory, module);
    const first = binding(fixture, "callable", "first", fixture.firstUnitId);
    const second = binding(fixture, "callable", "second", fixture.secondUnitId);
    const draft = callableDraft(fixture, first, fixture.firstUnitId, "first", 0);
    session.plan(draft);
    expectInvariant(() => session.plan(draft), "duplicate-session-draft");
    expectInvariant(
      () => session.plan(callableDraft(fixture, second, fixture.secondUnitId, "second", 0)),
      "duplicate-draft-order",
    );

    const badOrder = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(
      () =>
        badOrder.plan({
          ...draft,
          structuralOrder: { ...draft.structuralOrder, domainOrdinal: 99 },
        }),
      "invalid-draft-order",
    );

    const foreign = sessionFixture("/other/foreign.ts");
    const unknownSource = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(
      () =>
        unknownSource.plan({
          ...draft,
          structuralOrder: { ...draft.structuralOrder, sourceId: foreign.sourceId },
        }),
      "unknown-draft-source",
    );
  });

  it("rejects unknown, duplicate, non-required, reused, foreign, and wrong-space locators", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const fn = wasmFunction("same");
    const global = wasmGlobal("same");
    const first = binding(fixture, "callable", "first", fixture.firstUnitId);
    const second = binding(fixture, "callable", "second", fixture.secondUnitId);
    const alias = binding(fixture, "callable", "alias");
    const unknown = binding(fixture, "callable", "unknown");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(callableDraft(fixture, first, fixture.firstUnitId, "first", 0));
    session.plan(callableDraft(fixture, second, fixture.secondUnitId, "second", 1));
    session.plan(callableAliasDraft(fixture, alias, first, "alias", 2));

    expectInvariant(
      () => session.attachLocator(unknown, { kind: "defined-function", value: fn }),
      "unknown-locator-binding",
    );
    expectInvariant(
      () => session.attachLocator(alias, { kind: "defined-function", value: fn }),
      "locator-not-required",
    );
    expectInvariant(
      () => session.attachLocator(first, { kind: "defined-global", value: global }),
      "slot-locator-space-mismatch",
    );
    session.attachLocator(first, { kind: "defined-function", value: fn });
    expectInvariant(
      () => session.attachLocator(first, { kind: "defined-function", value: wasmFunction("other") }),
      "duplicate-slot-locator",
    );
    expectInvariant(
      () => session.attachLocator(second, { kind: "defined-function", value: fn }),
      "duplicate-slot-locator",
    );

    const typeId = binding(fixture, "type", "record");
    const otherTypeId = binding(fixture, "type", "other");
    const typeSession = new ProgramAbiSession(fixture.inventory, module);
    const otherSession = new ProgramAbiSession(fixture.inventory, module);
    typeSession.plan(typeDraft(fixture, typeId, "Record", 0));
    typeSession.plan({
      ...typeDraft(fixture, otherTypeId, "Other", 1),
      structuralOrder: structuralOrder(fixture, "type", 1),
    });
    const foreignCell = otherSession.createTypeCell({ kind: "struct", name: "$Foreign", fields: [] });
    expectInvariant(
      () => typeSession.attachLocator(typeId, { kind: "type-cell", cell: foreignCell }),
      "foreign-type-cell",
    );
    expectInvariant(() => typeSession.remapTypeCell(foreignCell, null), "foreign-type-cell");
  });

  it("rejects missing and eliminated required locators without a second publish attempt", () => {
    const fixture = sessionFixture();
    const missingModule = createEmptyModule();
    const missingId = binding(fixture, "callable", "missing", fixture.firstUnitId);
    const missing = new ProgramAbiSession(fixture.inventory, missingModule);
    missing.plan(callableDraft(fixture, missingId, fixture.firstUnitId, "missing", 0));
    expectInvariant(() => missing.publish(missingModule), "missing-required-locator");
    expectInvariant(() => missing.publish(missingModule), "session-publish-once");

    const removedModule = createEmptyModule();
    const removedFn = wasmFunction("removed");
    const removedId = binding(fixture, "callable", "removed", fixture.firstUnitId);
    const removed = new ProgramAbiSession(fixture.inventory, removedModule);
    removed.plan(callableDraft(fixture, removedId, fixture.firstUnitId, "removed", 0));
    removed.attachLocator(removedId, { kind: "defined-function", value: removedFn });
    expectInvariant(() => removed.publish(removedModule), "eliminated-required-locator");

    const typeModule = createEmptyModule();
    const typeId = binding(fixture, "type", "removed");
    const eliminatedType = new ProgramAbiSession(fixture.inventory, typeModule);
    eliminatedType.plan(typeDraft(fixture, typeId, "Removed", 0));
    const cell = eliminatedType.createTypeCell({ kind: "struct", name: "$Removed", fields: [] });
    eliminatedType.attachLocator(typeId, { kind: "type-cell", cell });
    eliminatedType.remapTypeCell(cell, null);
    expectInvariant(() => eliminatedType.publish(typeModule), "eliminated-required-locator");
  });

  it("resolves provisional exact slots and re-resolves final indices after a late import shift", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const defined = wasmFunction("legacy-label");
    module.functions.push(defined);
    const canonicalId = binding(fixture, "callable", "current", fixture.firstUnitId);
    const aliasId = binding(fixture, "callable", "current-alias");
    const canonicalKey = `unit|${canonicalId}|${fixture.firstUnitId}`;
    const aliasKey = `import|${aliasId}|3:env|3:run`;
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.ensurePlan({
      ...callableDraft(fixture, canonicalId, fixture.firstUnitId, "legacy-label", 0),
      structuralReferenceKey: canonicalKey,
    });
    session.ensurePlan({
      ...callableAliasDraft(fixture, aliasId, canonicalId, "renamed", 1),
      structuralReferenceKey: aliasKey,
    });
    session.attachLocator(canonicalId, { kind: "defined-function", value: defined });

    expect(session.resolveCurrentIndex(canonicalId, "function", canonicalKey)).toBe(0);
    expect(session.resolveCurrentIndex(aliasId, "function", aliasKey)).toBe(0);

    module.imports.push({
      module: "env",
      name: "late",
      desc: { kind: "func", typeIdx: 0 },
    });
    expect(session.resolveCurrentIndex(canonicalId, "function", canonicalKey)).toBe(1);
    expect(session.resolveCurrentIndex(aliasId, "function", aliasKey)).toBe(1);

    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(canonicalId)).toEqual({ space: "function", index: 1 });
    expect(session.resolveCurrentIndex(aliasId, "function", aliasKey)).toBe(1);
    expectInvariant(
      () => session.resolveCurrentIndex(aliasId, "function", aliasKey, createEmptyModule()),
      "context-session-mismatch",
    );
  });

  it("replaces exact defined allocators while preserving one binding owner", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const oldFirst = wasmFunction("same");
    const oldSecond = wasmFunction("same");
    const oldGlobal = wasmGlobal("same");
    module.functions.push(oldFirst, oldSecond);
    module.globals.push(oldGlobal);
    const firstId = binding(fixture, "callable", "replace", fixture.firstUnitId);
    const secondId = binding(fixture, "callable", "other", fixture.secondUnitId);
    const globalId = binding(fixture, "global", "replace");
    const firstKey = `unit|${firstId}|${fixture.firstUnitId}`;
    const globalKey = `runtime|${globalId}|7:counter`;
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan({
      ...callableDraft(fixture, firstId, fixture.firstUnitId, "same", 0),
      structuralReferenceKey: firstKey,
    });
    session.plan(callableDraft(fixture, secondId, fixture.secondUnitId, "same", 1));
    session.plan({
      ...globalDraft(fixture, globalId, "same", 2),
      structuralReferenceKey: globalKey,
    });
    session.attachLocator(firstId, { kind: "defined-function", value: oldFirst });
    session.attachLocator(secondId, { kind: "defined-function", value: oldSecond });
    session.attachLocator(globalId, { kind: "defined-global", value: oldGlobal });

    expectInvariant(
      () => session.replaceDefinedFunctionLocator(firstId, oldFirst, oldSecond),
      "duplicate-slot-locator",
    );
    expectInvariant(
      () => session.replaceDefinedFunctionLocator(firstId, wasmFunction("foreign"), wasmFunction("new")),
      "locator-remap-mismatch",
    );

    const newFirst = wasmFunction("same");
    const newGlobal = wasmGlobal("same");
    module.functions[0] = newFirst;
    module.globals[0] = newGlobal;
    session.replaceDefinedFunctionLocator(firstId, oldFirst, newFirst);
    session.replaceDefinedGlobalLocator(globalId, oldGlobal, newGlobal);
    expect(session.hasLocator(firstId, newFirst)).toBe(true);
    expect(session.hasLocator(firstId, oldFirst)).toBe(false);
    expect(session.resolveCurrentIndex(firstId, "function", firstKey)).toBe(0);
    expect(session.resolveCurrentIndex(globalId, "global", globalKey)).toBe(0);

    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(firstId)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(globalId)).toEqual({ space: "global", index: 0 });
  });

  it("tracks old TypeDef objects through survivor and elimination remaps", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const oldFirst: TypeDef = { kind: "struct", name: "$First", fields: [] };
    const oldSecond: TypeDef = { kind: "struct", name: "$Second", fields: [] };
    const replacement: TypeDef = { kind: "struct", name: "$First", fields: [] };
    module.types.push(oldFirst, oldSecond);
    const session = new ProgramAbiSession(fixture.inventory, module);
    const firstCell = session.createTypeCell(oldFirst);
    const secondCell = session.createTypeCell(oldSecond);
    expect(session.typeCellFor(oldFirst)).toBe(firstCell);
    expectInvariant(() => session.createTypeCell(oldFirst), "duplicate-type-cell");
    expectInvariant(
      () => session.remapTypeObject({ kind: "struct", name: "$Foreign", fields: [] }, null),
      "foreign-type-object",
    );

    session.remapTypeObject(oldFirst, replacement);
    expect(firstCell.current).toBe(replacement);
    expect(session.typeCellFor(oldFirst)).toBe(firstCell);
    expect(session.typeCellFor(replacement)).toBe(firstCell);
    expectInvariant(() => session.remapTypeObject(oldFirst, null), "type-remap-mismatch");
    expectInvariant(() => session.remapTypeObject(oldSecond, replacement), "ambiguous-type-remap");

    session.remapTypeObjects([[oldSecond, null]]);
    expect(secondCell.current).toBeNull();
    expectInvariant(() => session.remapTypeObject(oldSecond, null), "type-remap-mismatch");
  });

  it("derives whole-source unit/class/source order from exact inventory anchors", () => {
    const file = source(
      "/repo/nested-order.ts",
      `
        function first() { function nested() {} }
        function second() { function nested() {} }
        class Box { method() { function nested() {} } }
      `,
    );
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const sourceId = inventory.sources[0]!.id;
    const sourceUnits = inventory.allUnits.filter((unit) => unit.sourceId === sourceId);
    const unitOrders = sourceUnits.map((unit) =>
      session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }),
    );
    expect(unitOrders.map((order) => order.declarationOrdinal)).toEqual(sourceUnits.map((_, index) => (index + 1) * 2));
    expect(new Set(unitOrders.map((order) => order.declarationOrdinal)).size).toBe(sourceUnits.length);
    const repeatedLocalOrdinals = sourceUnits.filter((unit) => unit.ordinal === 0);
    expect(repeatedLocalOrdinals.length).toBeGreaterThan(2);
    expect(
      new Set(
        repeatedLocalOrdinals.map(
          (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
        ),
      ).size,
    ).toBe(repeatedLocalOrdinals.length);

    const classRecord = inventory.classes[0]!;
    const classOrder = session.structuralOrder.forClass(classRecord.id, {
      domain: "class",
      roleOrdinal: 0,
    });
    const firstClassMemberOrder = Math.min(
      ...inventory.allUnits
        .filter((unit) => unit.lexicalOwnerId === classRecord.id)
        .map(
          (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
        ),
    );
    expect(classOrder.declarationOrdinal).toBe(firstClassMemberOrder - 1);
    expect(session.structuralOrder.forSource(sourceId, { domain: "support", roleOrdinal: 0 }).declarationOrdinal).toBe(
      0,
    );
    expectInvariant(
      () =>
        session.structuralOrder.forUnit("ir-unit:v1:missing" as IrUnitId, {
          domain: "callable",
          roleOrdinal: 0,
        }),
      "unknown-order-anchor",
    );
  });

  it("validates the full canonical reference payload beside an existing binding ID", () => {
    const file = source("/repo/reference.ts", "class Local {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const sourceId = inventory.sources[0]!.id;
    const classId = inventory.classes[0]!.id;
    const runtimeId = createIrBindingId({ ownerId: sourceId, domain: "global", role: "runtime-state" });
    const importId = createIrBindingId({ ownerId: sourceId, domain: "callable", role: "imported" });
    const classBindingId = createIrBindingId({ ownerId: classId, domain: "class", role: "layout" });
    const runtimeKey = `runtime|${runtimeId}|5:clock`;
    const importKey = `import|${importId}|3:env|4:read`;
    const classKey = `class|${classBindingId}|${classId}`;
    const session = new ProgramAbiSession(inventory, createEmptyModule());
    session.plan({
      id: runtimeId,
      structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "global", roleOrdinal: 0 }),
      displayName: "clock",
      structuralReferenceKey: runtimeKey,
      slotPolicy: "required",
      slotSpace: "global",
      intent: { kind: "global", origin: "runtime", valueType: "i32", mutable: true },
    });
    session.plan({
      id: importId,
      structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "callable", roleOrdinal: 0 }),
      displayName: "read",
      structuralReferenceKey: importKey,
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "import", signature: VOID_SIGNATURE },
    });
    session.plan({
      id: classBindingId,
      structuralOrder: session.structuralOrder.forClass(classId, { domain: "class", roleOrdinal: 0 }),
      displayName: "Local",
      structuralReferenceKey: classKey,
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "class", classId, layoutKey: "class:Local" },
    });
    session.registerStructuralReference(runtimeId, runtimeKey);
    session.registerStructuralReference(importId, importKey);
    session.registerStructuralReference(classBindingId, classKey);
    expectInvariant(
      () => session.registerStructuralReference(runtimeId, `runtime|${runtimeId}|5:timer`),
      "binding-reference-mismatch",
    );
    expectInvariant(
      () => session.registerStructuralReference(importId, `import|${importId}|5:other|5:field`),
      "binding-reference-mismatch",
    );
    expectInvariant(
      () =>
        session.registerStructuralReference(
          classBindingId,
          `class|${classBindingId}|${"ir-class:v1:foreign" as IrClassId}`,
        ),
      "binding-reference-mismatch",
    );

    const missingMetadataId = createIrBindingId({ ownerId: sourceId, domain: "support", role: "missing-metadata" });
    session.plan({
      id: missingMetadataId,
      structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "support", roleOrdinal: 1 }),
      displayName: "missing",
      slotPolicy: "none",
      intent: { kind: "support", role: "missing-metadata" },
    });
    expectInvariant(
      () => session.registerStructuralReference(missingMetadataId, "support|missing"),
      "missing-binding-reference",
    );
  });

  it("ensures repeated plans match the full frozen draft contract", () => {
    const fixture = sessionFixture();
    const session = new ProgramAbiSession(fixture.inventory, createEmptyModule());
    const id = binding(fixture, "global", "ensure");
    const draft = {
      ...globalDraft(fixture, id, "state", 0),
      structuralReferenceKey: `runtime|${id}|5:state`,
      intent: {
        kind: "global",
        origin: "runtime",
        valueType: "i32",
        mutable: true,
      },
    } satisfies ProgramAbiDraft;
    session.ensurePlan(draft);
    session.ensurePlan({ ...draft, structuralOrder: { ...draft.structuralOrder }, intent: { ...draft.intent } });
    expect(session.hasPlan(id)).toBe(true);
    expect(session.getDraft(id)).not.toBe(draft);

    const foreign = sessionFixture("/other/ensure.ts");
    const mismatches: ProgramAbiDraft[] = [
      { ...draft, displayName: "other" },
      { ...draft, structuralReferenceKey: `runtime|${id}|5:other` },
      { ...draft, structuralOrder: { ...draft.structuralOrder, sourceId: foreign.sourceId } },
      { ...draft, intent: { ...draft.intent, valueType: "f64" } },
      { ...draft, intent: { ...draft.intent, mutable: false } },
      { ...draft, intent: { ...draft.intent, capability: "dom" } },
    ];
    for (const mismatch of mismatches) {
      expectInvariant(() => session.ensurePlan(mismatch), "session-draft-mismatch");
    }
  });

  it("closes planning after publish, rejects publish twice, and validates context ownership", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const support = binding(fixture, "support", "marker");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(supportDraft(fixture, support, 0));
    const publication = session.publish(module);
    expect(session.publication).toBe(publication);
    expectInvariant(
      () => session.plan(supportDraft(fixture, binding(fixture, "support", "late"), 1)),
      "session-closed",
    );
    expectInvariant(() => session.publish(module), "session-publish-once");

    const otherModule = createEmptyModule();
    const mismatch = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(() => mismatch.assertModule(otherModule), "context-session-mismatch");
    expectInvariant(
      () => createCodegenContext(otherModule, {} as unknown as ts.TypeChecker, undefined, mismatch),
      "context-session-mismatch",
    );
    const matchingContext = createCodegenContext(module, {} as unknown as ts.TypeChecker, undefined, mismatch);
    expect(matchingContext.programAbiSession).toBe(mismatch);
  });
});

describe("#3520 ProgramAbiMap derived-unit provenance", () => {
  function baseDerivedRecord(
    fixture: SessionFixture,
    parentId: IrUnitId,
    role: "lifted-closure" | "monomorphization-clone",
    ordinal: number,
  ): ProgramAbiDerivedUnitRecord {
    const parent = fixture.inventory.allUnits.find((unit) => unit.id === parentId)!;
    return {
      id: createDerivedIrUnitId({ parentId, role, ordinal }),
      parentId,
      terminalOwnerId: parent.terminalOwnerId,
      sourceId: fixture.sourceId,
      role,
      ordinal,
    };
  }

  it("rejects invalid IDs, duplicate units, unknown parents/sources/owners, and ownership mismatches", () => {
    const fixture = sessionFixture();
    const valid = baseDerivedRecord(fixture, fixture.firstUnitId, "lifted-closure", 0);
    expectInvariant(() => new ProgramAbiMap(fixture.inventory, [valid, valid]), "duplicate-derived-unit");
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, id: "not-the-derived-id" as IrUnitId }]),
      "invalid-derived-unit",
    );

    const unknownParent = "ir-unit:v1:unknown" as IrUnitId;
    const unknownParentRecord: ProgramAbiDerivedUnitRecord = {
      ...valid,
      id: createDerivedIrUnitId({ parentId: unknownParent, role: "lifted-closure", ordinal: 0 }),
      parentId: unknownParent,
    };
    expectInvariant(() => new ProgramAbiMap(fixture.inventory, [unknownParentRecord]), "unknown-derived-parent");

    const foreign = sessionFixture("/other/foreign.ts");
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, sourceId: foreign.sourceId }]),
      "unknown-derived-source",
    );
    expectInvariant(
      () =>
        new ProgramAbiMap(fixture.inventory, [
          { ...valid, terminalOwnerId: "ir-unit:v1:missing-terminal" as IrUnitId },
        ]),
      "unknown-derived-terminal-owner",
    );
    const second = fixture.inventory.allUnits.find((unit) => unit.id === fixture.secondUnitId)!;
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, terminalOwnerId: second.terminalOwnerId }]),
      "derived-terminal-owner-mismatch",
    );
  });

  it("rejects a known but different source from the parent", () => {
    const firstFile = source("/repo/a.ts", "export function first() {}");
    const secondFile = source("/repo/b.ts", "export function second() {}");
    const inventory = buildIrUnitInventory([firstFile, secondFile], { entrySource: firstFile });
    const parent = inventory.allUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
    )!;
    const otherSource = inventory.sources.find((record) => record.id !== parent.sourceId)!;
    const record: ProgramAbiDerivedUnitRecord = {
      id: createDerivedIrUnitId({ parentId: parent.id, role: "lifted-closure", ordinal: 0 }),
      parentId: parent.id,
      terminalOwnerId: parent.terminalOwnerId,
      sourceId: otherSource.id,
      role: "lifted-closure",
      ordinal: 0,
    };
    expectInvariant(() => new ProgramAbiMap(inventory, [record]), "derived-source-mismatch");
  });
});
