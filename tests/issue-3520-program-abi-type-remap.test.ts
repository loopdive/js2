// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

const { injectedParentIds, observedCloneIds } = vi.hoisted(() => ({
  injectedParentIds: new Set<string>(),
  observedCloneIds: vi.fn<(ids: readonly string[]) => void>(),
}));

// Source lowering currently normalizes direct-call tuples before the
// monomorphizer sees them. This transparent wrapper runs the real pass and then
// supplies one specialized clone through its production result contract so the
// test remains focused on final Program ABI type remapping.
vi.mock("../src/ir/passes/monomorphize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/passes/monomorphize.js")>();
  const { createDerivedIrUnitId } = await import("../src/ir/identity.js");
  const { irVal } = await import("../src/ir/nodes.js");
  return {
    ...actual,
    monomorphize(...args: Parameters<typeof actual.monomorphize>) {
      const result = actual.monomorphize(...args);
      const cloneSignatures = new Map(result.cloneSignatures);
      const cloneOrigins = new Map(result.cloneOrigins);
      const cloneUnitProvenance = new Map(result.cloneUnitProvenance);
      const injectedClones: Array<(typeof result.module.functions)[number]> = [];
      const booleanType = irVal({ kind: "i32", boolean: true });

      for (const parent of result.module.functions) {
        if (!injectedParentIds.has(parent.unitId)) continue;
        if (parent.params.length < 2 || parent.resultTypes.length !== 1) {
          throw new Error(`test clone injection requires capture + value params and one result from ${parent.unitId}`);
        }
        const cloneUnitId = createDerivedIrUnitId({
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
        const cloneName = `${parent.name}$abi_type_remap`;
        const params = parent.params.map((param, index) =>
          index === parent.params.length - 1
            ? { ...structuredClone(param), type: booleanType }
            : structuredClone(param),
        );
        injectedClones.push({
          ...structuredClone(parent),
          unitId: cloneUnitId,
          name: cloneName,
          params,
          resultTypes: [booleanType],
          exported: false,
        });
        cloneSignatures.set(cloneUnitId, {
          name: cloneName,
          params: params.map((param) => param.type),
          returnType: booleanType,
        });
        cloneOrigins.set(cloneUnitId, parent.unitId);
        cloneUnitProvenance.set(cloneUnitId, {
          id: cloneUnitId,
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
      }

      observedCloneIds(injectedClones.map((clone) => clone.unitId));
      return {
        ...result,
        // Child-first placement also proves type remapping does not depend on
        // the derived callable's production order.
        module: { functions: [...injectedClones, ...result.module.functions] },
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
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
  type IrUnitId,
} from "../src/ir/identity.js";
import { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type GlobalDef,
  type TypeDef,
  type ValType,
  type WasmFunction,
  type WasmModule,
} from "../src/ir/types.js";
import {
  ProgramAbiSession,
  type ProgramAbiTypeCell,
  type ProgramAbiTypeLayoutRemap,
} from "../src/codegen/program-abi-session.js";

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

function canonicalSignature(signature: Pick<FuncTypeDef, "params" | "results">) {
  return {
    params: signature.params.map(canonicalValType),
    results: signature.results.map(canonicalValType),
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

interface TypeLayoutSessionFixture {
  readonly module: WasmModule;
  readonly session: ProgramAbiSession;
  readonly previousTypes: TypeDef[];
  readonly captureType: TypeDef;
  readonly callableType: FuncTypeDef;
  readonly callable: WasmFunction;
  readonly global: GlobalDef;
  readonly typeCell: ProgramAbiTypeCell;
  readonly ids: {
    readonly callable: IrBindingId;
    readonly alias: IrBindingId;
    readonly global: IrBindingId;
    readonly type: IrBindingId;
  };
}

function createTypeLayoutSessionFixture(): TypeLayoutSessionFixture {
  const ast = analyzeSource(
    "export function remapOwner(value: number): number { return value; }",
    "/repo/issue-3520-program-abi-session-type-remap.ts",
  );
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile });
  const owner = inventory.allUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "remapOwner",
  );
  if (!owner) throw new Error("missing lower-level type-remap owner");
  const sourceId = inventory.sources[0]!.id;
  const module = createEmptyModule();
  const deadType: TypeDef = { kind: "struct", name: "$Dead", fields: [] };
  const captureType: TypeDef = { kind: "struct", name: "$Capture", fields: [] };
  const callableType: FuncTypeDef = {
    kind: "func",
    name: "$Closure",
    params: [{ kind: "ref", typeIdx: 1 }, { kind: "f64" }],
    results: [{ kind: "f64" }],
  };
  const wrongCallableType: FuncTypeDef = {
    kind: "func",
    name: "$WrongClosure",
    params: [
      { kind: "ref", typeIdx: 1 },
      { kind: "i32", boolean: true },
    ],
    results: [{ kind: "i32", boolean: true }],
  };
  const previousTypes = [deadType, captureType, callableType, wrongCallableType];
  module.types = previousTypes;
  const callable: WasmFunction = {
    name: "remapOwner__closure_0",
    typeIdx: 2,
    locals: [],
    body: [],
    exported: false,
  };
  const global: GlobalDef = {
    name: "capture",
    type: { kind: "ref_null", typeIdx: 1 },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: 1 }],
  };
  module.functions.push(callable);
  module.globals.push(global);

  const ids = {
    callable: createIrBindingId({ ownerId: owner.id, domain: "callable", role: "type-remap-body" }),
    alias: createIrBindingId({ ownerId: sourceId, domain: "callable", role: "type-remap-alias" }),
    global: createIrBindingId({ ownerId: sourceId, domain: "global", role: "type-remap-capture" }),
    type: createIrBindingId({ ownerId: sourceId, domain: "type", role: "type-remap-capture" }),
  };
  const session = new ProgramAbiSession(inventory, module);
  const callableSignature = canonicalSignature(callableType);
  session.plan({
    id: ids.callable,
    structuralOrder: session.structuralOrder.forUnit(owner.id, { domain: "callable", roleOrdinal: 0 }),
    displayName: callable.name,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "source",
      unitId: owner.id,
      signature: callableSignature,
    },
  });
  session.registerCallableTypeContract(ids.callable, callableType);
  session.attachLocator(ids.callable, { kind: "defined-function", value: callable });
  session.plan({
    id: ids.alias,
    structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "callable", roleOrdinal: 1 }),
    displayName: "remapAlias",
    slotPolicy: "alias",
    aliasOf: ids.callable,
    intent: {
      kind: "callable",
      origin: "import",
      signature: callableSignature,
    },
  });
  session.plan({
    id: ids.global,
    structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "global", roleOrdinal: 0 }),
    displayName: global.name,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "source",
      valueType: canonicalValType(global.type),
      mutable: global.mutable,
    },
  });
  session.registerGlobalTypeContract(ids.global, global.type, global.mutable);
  session.attachLocator(ids.global, { kind: "defined-global", value: global });
  session.plan({
    id: ids.type,
    structuralOrder: session.structuralOrder.forSource(sourceId, { domain: "type", roleOrdinal: 0 }),
    displayName: captureType.name,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "type", shapeKey: "struct:$Capture" },
  });
  const typeCell = session.createTypeCell(captureType);
  session.attachLocator(ids.type, { kind: "type-cell", cell: typeCell });

  return {
    module,
    session,
    previousTypes,
    captureType,
    callableType,
    callable,
    global,
    typeCell,
    ids,
  };
}

describe("#3520 Program ABI callable type remapping", () => {
  it("publishes post-DCE capture-ref signatures for a lifted callable and its exact clone", () => {
    const ast = analyzeSource(
      `
        export function owner(value: number): number {
          const identity = (input: number): number => input;
          return identity(value);
        }
      `,
      "/repo/issue-3520-program-abi-type-remap.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile });
    const owner = inventory.allUnits.find(
      (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "owner",
    );
    if (!owner) throw new Error("missing exact source owner");

    const liftedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const cloneUnitId = createDerivedIrUnitId({
      parentId: liftedUnitId,
      role: "monomorphization-clone",
      ordinal: 0,
    });
    injectedParentIds.clear();
    observedCloneIds.mockClear();
    injectedParentIds.add(liftedUnitId);

    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(observedCloneIds).toHaveBeenCalledTimes(1);
    expect(observedCloneIds.mock.calls[0]?.[0]).toEqual([cloneUnitId]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entriesById = new Map(publication.abi.entries().map((entry) => [entry.id, entry] as const));
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
    const assertPublishedSignature = (unitId: IrUnitId, expectedName: string) => {
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
        throw new Error(`missing concrete function signature for ${unitId}`);
      }
      expect({
        params: signature.params.map(canonicalValType),
        results: signature.results.map(canonicalValType),
      }).toEqual(entry.intent.signature);
      return { bindingId, entry, signature, ...slot };
    };

    const lifted = assertPublishedSignature(liftedUnitId, "owner__closure_0");
    const clone = assertPublishedSignature(cloneUnitId, "owner__closure_0$abi_type_remap");
    expect(lifted.signature.params.at(-1)).toEqual({ kind: "f64" });
    expect(lifted.signature.results).toEqual([{ kind: "f64" }]);
    expect(clone.signature.params.at(-1)).toEqual({ kind: "i32", boolean: true });
    expect(clone.signature.results).toEqual([{ kind: "i32", boolean: true }]);
    expect(lifted.signature.params[0]).toEqual(clone.signature.params[0]);
    expect(lifted.bindingId).not.toBe(clone.bindingId);
    expect(lifted.finalIndex.index).not.toBe(clone.finalIndex.index);
    expect(lifted.func.typeIdx).not.toBe(clone.func.typeIdx);
  });

  it("remaps callable, alias, global, and type-cell contracts through one complete layout", () => {
    const fixture = createTypeLayoutSessionFixture();
    const finalCaptureType: TypeDef = { kind: "struct", name: "$Capture", fields: [] };
    const finalCallableType: FuncTypeDef = {
      kind: "func",
      name: "$Closure",
      params: [{ kind: "ref", typeIdx: 0 }, { kind: "f64" }],
      results: [{ kind: "f64" }],
    };
    const nextTypes = [finalCaptureType, finalCallableType];
    fixture.session.applyTypeLayoutRemap({
      previousTypes: fixture.previousTypes,
      nextTypes,
      targetsByOldIndex: [null, 0, 1, null],
    });
    expect(fixture.typeCell.current).toBe(finalCaptureType);
    expect(fixture.session.typeCellFor(finalCaptureType)).toBe(fixture.typeCell);

    fixture.module.types = nextTypes;
    fixture.callable.typeIdx = 1;
    fixture.global.type = { kind: "ref_null", typeIdx: 0 };
    fixture.global.init = [{ op: "ref.null", typeIdx: 0 }];
    const { abi } = fixture.session.publish(fixture.module);
    const entries = new Map(abi.entries().map((entry) => [entry.id, entry] as const));
    const finalSignature = canonicalSignature(finalCallableType);
    expect(entries.get(fixture.ids.callable)?.intent).toEqual({
      kind: "callable",
      origin: "source",
      unitId: expect.any(String),
      signature: finalSignature,
    });
    expect(entries.get(fixture.ids.alias)?.intent).toEqual({
      kind: "callable",
      origin: "import",
      signature: finalSignature,
    });
    expect(entries.get(fixture.ids.global)?.intent).toEqual({
      kind: "global",
      origin: "source",
      valueType: canonicalValType(fixture.global.type),
      mutable: true,
    });
    expect(abi.resolveFinalIndex(fixture.ids.callable)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(fixture.ids.alias)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(fixture.ids.global)).toEqual({ space: "global", index: 0 });
    expect(abi.resolveFinalIndex(fixture.ids.type)).toEqual({ space: "type", index: 0 });
  });

  it("rejects invalid layouts and wrong locators transactionally", () => {
    const compactCapture: TypeDef = { kind: "struct", name: "$Capture", fields: [] };
    const compactCallable: FuncTypeDef = {
      kind: "func",
      name: "$Closure",
      params: [{ kind: "ref", typeIdx: 0 }, { kind: "f64" }],
      results: [{ kind: "f64" }],
    };
    const cases: readonly {
      readonly code: ProgramAbiInvariantCode;
      readonly layout: (fixture: TypeLayoutSessionFixture) => ProgramAbiTypeLayoutRemap;
    }[] = [
      {
        code: "type-remap-mismatch",
        layout: (fixture) => ({
          previousTypes: fixture.previousTypes,
          nextTypes: [compactCapture, compactCallable],
          targetsByOldIndex: [null, 2, 1, null],
        }),
      },
      {
        code: "type-remap-mismatch",
        layout: (fixture) => ({
          previousTypes: fixture.previousTypes,
          nextTypes: [compactCapture, compactCallable],
          targetsByOldIndex: [null, 0, null, null],
        }),
      },
      {
        code: "ambiguous-type-remap",
        layout: (fixture) => ({
          previousTypes: fixture.previousTypes,
          nextTypes: [compactCapture],
          targetsByOldIndex: [null, 0, 0, null],
        }),
      },
      {
        code: "type-remap-mismatch",
        layout: (fixture) => ({
          previousTypes: fixture.previousTypes,
          nextTypes: [compactCallable],
          targetsByOldIndex: [null, null, 0, null],
        }),
      },
    ];

    for (const testCase of cases) {
      const fixture = createTypeLayoutSessionFixture();
      const originalDraft = fixture.session.getDraft(fixture.ids.callable);
      expectInvariant(() => fixture.session.applyTypeLayoutRemap(testCase.layout(fixture)), testCase.code);
      expect(fixture.session.publication).toBeUndefined();
      expect(fixture.session.getDraft(fixture.ids.callable)).toBe(originalDraft);
      expect(fixture.typeCell.current).toBe(fixture.captureType);
      const { abi } = fixture.session.publish(fixture.module);
      expect(abi.resolveFinalIndex(fixture.ids.callable)).toEqual({ space: "function", index: 0 });
      expect(abi.resolveFinalIndex(fixture.ids.alias)).toEqual({ space: "function", index: 0 });
      expect(abi.resolveFinalIndex(fixture.ids.type)).toEqual({ space: "type", index: 1 });
    }

    const fixture = createTypeLayoutSessionFixture();
    const wrongReplacement: WasmFunction = {
      name: fixture.callable.name,
      typeIdx: 3,
      locals: [],
      body: [],
      exported: false,
    };
    expectInvariant(
      () => fixture.session.replaceDefinedFunctionLocator(fixture.ids.callable, fixture.callable, wrongReplacement),
      "type-remap-mismatch",
    );
    expect(fixture.session.publication).toBeUndefined();
    expect(fixture.session.hasLocator(fixture.ids.callable, fixture.callable)).toBe(true);
    expect(fixture.session.hasLocator(fixture.ids.callable, wrongReplacement)).toBe(false);
    const { abi } = fixture.session.publish(fixture.module);
    expect(abi.resolveFinalIndex(fixture.ids.callable)).toEqual({ space: "function", index: 0 });
  });
});
