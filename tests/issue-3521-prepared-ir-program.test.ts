// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiValType,
} from "../src/codegen/program-abi-signatures.js";
import { ProgramAbiSession, type ProgramAbiDraft } from "../src/codegen/program-abi-session.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
  type IrUnitId,
} from "../src/ir/identity.js";
import { PreparedIrProgramBuilder, type PreparedIrIrCandidateInput } from "../src/ir/prepare.js";
import { IR_CLASS_SHAPE_CELL, type IrClassShape } from "../src/ir/nodes.js";
import {
  createPreparedIrCandidateProgram,
  preparedIrReadonlyMap,
  PreparedIrEmissionTransaction,
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrProgramInvariantCode,
} from "../src/ir/program.js";
import { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../src/ir/program-abi.js";
import { ProgramAbiMap } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type GlobalDef,
  type TypeDef,
  type WasmFunction,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({
  params: Object.freeze([]),
  results: Object.freeze([]),
});

function expectInvariant(action: () => unknown, code: ProgramAbiInvariantCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
}

function fixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/session-seal.ts",
    "export function value(): number { return 1; } function other(): number { return 2; }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const unit = inventory.allUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "value",
  );
  const otherUnit = inventory.allUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "other",
  );
  if (!unit || !otherUnit) throw new Error("missing function inventory unit");
  return { inventory, sourceId: inventory.sources[0]!.id, unit, otherUnit };
}

function functionDraft(
  session: ProgramAbiSession,
  id: IrBindingId,
  unitId: ReturnType<typeof fixture>["unit"]["id"],
  structuralReferenceKey: string,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: 0,
    }),
    displayName: "value",
    structuralReferenceKey,
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

function wasmFunction(name: string): WasmFunction {
  return { name, typeIdx: 0, locals: [], body: [], exported: false };
}

describe("#3521 Program ABI plan sealing", () => {
  it("seals intentions before exact replacement and binds the final shifted function index once", () => {
    const { inventory, sourceId, unit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const original = wasmFunction("value$planned");
    module.functions.push(original);

    const session = new ProgramAbiSession(inventory, module);
    const bindingId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const referenceKey = `unit|${unit.id}|body`;
    session.plan(functionDraft(session, bindingId, unit.id, referenceKey));
    session.registerCallableTypeContract(bindingId, VOID_SIGNATURE);
    session.attachLocator(bindingId, { kind: "defined-function", value: original });

    const sealed = session.sealPlan(module);
    expect(sealed.planningSealed).toBe(true);
    expect(session.sealPlan(module)).toBe(sealed);
    expect("bindFinalIndex" in sealed).toBe(false);
    expect("finishBinding" in sealed).toBe(false);
    expect(() =>
      (
        sealed as typeof sealed & {
          bindFinalIndex(id: IrBindingId, value: { space: "function"; index: number }): void;
        }
      ).bindFinalIndex(bindingId, { space: "function", index: 99 }),
    ).toThrow(TypeError);
    const sealedEntry = sealed.get(bindingId)!;
    expect(Object.isFrozen(sealedEntry)).toBe(true);
    expect(Reflect.set(sealedEntry, "displayName", "tampered")).toBe(false);

    const lateBinding = createIrBindingId({ ownerId: sourceId, domain: "support", role: "late" });
    expectInvariant(
      () =>
        session.plan({
          id: lateBinding,
          structuralOrder: session.structuralOrder.forSource(sourceId, {
            domain: "support",
            roleOrdinal: 0,
          }),
          displayName: "late",
          slotPolicy: "none",
          intent: { kind: "support", role: "late" },
        }),
      "session-closed",
    );
    expectInvariant(
      () => session.ensurePlan(functionDraft(session, bindingId, unit.id, referenceKey)),
      "session-closed",
    );
    expectInvariant(() => session.registerStructuralReference(bindingId, referenceKey), "session-closed");
    const derivedId = createDerivedIrUnitId({
      parentId: unit.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    expectInvariant(
      () =>
        session.registerDerivedUnit({
          id: derivedId,
          parentId: unit.id,
          terminalOwnerId: unit.terminalOwnerId,
          sourceId: unit.sourceId,
          role: "lifted-closure",
          ordinal: 0,
        }),
      "session-closed",
    );
    expectInvariant(() => session.registerCallableTypeContract(bindingId, VOID_SIGNATURE), "session-closed");
    expectInvariant(() => session.createTypeCell({ kind: "struct", name: "$Late", fields: [] }), "session-closed");
    expectInvariant(
      () => session.attachLocator(bindingId, { kind: "defined-function", value: original }),
      "session-closed",
    );

    const replacement = wasmFunction("value$emitted");
    module.functions[0] = replacement;
    session.replaceDefinedFunctionLocator(bindingId, original, replacement);

    module.imports.push({
      module: "env",
      name: "late_import",
      desc: { kind: "func", typeIdx: 0 },
    });
    expect(session.resolveCurrentIndex(bindingId, "function", referenceKey, module)).toBe(1);

    const publication = session.bindAndPublish(module);
    expect(publication.abi).not.toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "function", index: 1 });
    expect(session.publication).toBe(publication);
    expect(session.resolveCurrentIndex(bindingId, "function", referenceKey, module)).toBe(1);
    expectInvariant(
      () => session.replaceDefinedFunctionLocator(bindingId, replacement, wasmFunction("post-publish")),
      "session-closed",
    );
    expectInvariant(
      () => session.remapTypeObject(module.types[0]!, { kind: "func", name: "$other", params: [], results: [] }),
      "session-closed",
    );
    expectInvariant(() => session.bindAndPublish(module), "session-publish-once");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });

  it("allows an exact type-cell DCE remap after sealing and binds only the retained object", () => {
    const { inventory, sourceId } = fixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const planned: TypeDef = { kind: "struct", name: "$Record$planned", fields: [] };
    module.types.push(removed, planned);

    const session = new ProgramAbiSession(inventory, module);
    const bindingId = createIrBindingId({ ownerId: sourceId, domain: "type", role: "record" });
    const referenceKey = `type|${bindingId}`;
    session.plan({
      id: bindingId,
      structuralOrder: session.structuralOrder.forSource(sourceId, {
        domain: "type",
        roleOrdinal: 0,
      }),
      displayName: "$Record",
      structuralReferenceKey: referenceKey,
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "type", shapeKey: "struct:record" },
    });
    const cell = session.createTypeCell(planned);
    session.attachLocator(bindingId, { kind: "type-cell", cell });

    const sealed = session.sealPlan(module);
    const retained: TypeDef = { kind: "struct", name: "$Record$retained", fields: [] };
    session.remapTypeCell(cell, retained);
    module.types = [retained];

    expect(session.resolveCurrentIndex(bindingId, "type", referenceKey, module)).toBe(0);
    const publication = session.bindAndPublish(module);
    expect(publication.abi).not.toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "type", index: 0 });
  });

  it("re-materializes callable and global type-index contracts after a post-seal layout remap", () => {
    const { inventory, sourceId, unit } = fixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const payload: TypeDef = { kind: "struct", name: "$Payload$planned", fields: [] };
    const callableType: FuncTypeDef = {
      kind: "func",
      name: "$callable$planned",
      params: [{ kind: "ref", typeIdx: 1 }],
      results: [{ kind: "ref_null", typeIdx: 1 }],
    };
    module.types.push(removed, payload, callableType);
    const callable = wasmFunction("value$planned");
    callable.typeIdx = 2;
    const global: GlobalDef = {
      name: "state$planned",
      type: { kind: "ref_null", typeIdx: 1 },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: 1 }],
    };
    module.functions.push(callable);
    module.globals.push(global);

    const session = new ProgramAbiSession(inventory, module);
    const callableId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const globalId = createIrBindingId({ ownerId: sourceId, domain: "global", role: "state" });
    session.plan({
      id: callableId,
      structuralOrder: session.structuralOrder.forUnit(unit.id, {
        domain: "callable",
        roleOrdinal: 0,
      }),
      displayName: "value",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(callableType),
        unitId: unit.id,
      },
    });
    session.registerCallableTypeContract(callableId, callableType);
    session.attachLocator(callableId, { kind: "defined-function", value: callable });
    session.plan({
      id: globalId,
      structuralOrder: session.structuralOrder.forSource(sourceId, {
        domain: "global",
        roleOrdinal: 0,
      }),
      displayName: "state",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "source",
        valueType: canonicalProgramAbiValType(global.type),
        mutable: true,
      },
    });
    session.registerGlobalTypeContract(globalId, global.type, global.mutable);
    session.attachLocator(globalId, { kind: "defined-global", value: global });

    const sealed = session.sealPlan(module);
    const sealedCallableIntent = sealed.get(callableId)!.intent;
    const sealedGlobalIntent = sealed.get(globalId)!.intent;
    expect(sealedCallableIntent.kind === "callable" ? sealedCallableIntent.signature.params : []).toEqual([
      '{"kind":"ref","typeIdx":1}',
    ]);
    expect(sealedGlobalIntent.kind === "global" ? sealedGlobalIntent.valueType : "").toBe(
      '{"kind":"ref_null","typeIdx":1}',
    );

    const finalPayload: TypeDef = { kind: "struct", name: "$Payload$final", fields: [] };
    const finalCallableType: FuncTypeDef = {
      kind: "func",
      name: "$callable$final",
      params: [{ kind: "ref", typeIdx: 0 }],
      results: [{ kind: "ref_null", typeIdx: 0 }],
    };
    const previousTypes = module.types;
    const nextTypes = [finalPayload, finalCallableType];
    session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [null, 0, 1],
    });
    module.types = nextTypes;
    callable.typeIdx = 1;
    global.type = { kind: "ref_null", typeIdx: 0 };
    global.init = [{ op: "ref.null", typeIdx: 0 }];

    const remappedCallableIntent = sealed.get(callableId)!.intent;
    const remappedGlobalIntent = sealed.get(globalId)!.intent;
    expect(remappedCallableIntent.kind === "callable" ? remappedCallableIntent.signature.params : []).toEqual([
      '{"kind":"ref","typeIdx":0}',
    ]);
    expect(remappedGlobalIntent.kind === "global" ? remappedGlobalIntent.valueType : "").toBe(
      '{"kind":"ref_null","typeIdx":0}',
    );

    const publication = session.bindAndPublish(module);
    expect(publication.abi.get(callableId)?.intent).toEqual(remappedCallableIntent);
    expect(publication.abi.get(globalId)?.intent).toEqual(remappedGlobalIntent);
    expect(publication.abi.resolveFinalIndex(callableId)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(globalId)).toEqual({ space: "global", index: 0 });
  });

  it("rejects unsealed binding and atomically fails a required draft without its planning locator", () => {
    const { inventory, unit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const session = new ProgramAbiSession(inventory, module);
    expectInvariant(() => session.bindAndPublish(module), "planning-not-sealed");

    const bindingId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    session.plan(functionDraft(session, bindingId, unit.id, `unit|${unit.id}|body`));
    expectInvariant(() => session.sealPlan(module), "missing-required-locator");
    expect(session.publication).toBeUndefined();
    expectInvariant(
      () => session.attachLocator(bindingId, { kind: "defined-function", value: wasmFunction("late") }),
      "session-closed",
    );
    expectInvariant(() => session.sealPlan(module), "session-closed");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });

  it("validates every final locator before committing any index when a later entry was eliminated", () => {
    const { inventory, unit, otherUnit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const first = wasmFunction("first");
    const second = wasmFunction("second");
    module.functions.push(first, second);

    const session = new ProgramAbiSession(inventory, module);
    const firstId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const secondId = createIrBindingId({ ownerId: otherUnit.id, domain: "callable", role: "body" });
    session.plan(functionDraft(session, firstId, unit.id, `unit|${unit.id}|body`));
    session.plan(functionDraft(session, secondId, otherUnit.id, `unit|${otherUnit.id}|body`));
    session.attachLocator(firstId, { kind: "defined-function", value: first });
    session.attachLocator(secondId, { kind: "defined-function", value: second });
    const sealed = session.sealPlan(module);

    module.functions = [first];
    expectInvariant(() => session.bindAndPublish(module), "eliminated-required-locator");
    expect(session.publication).toBeUndefined();
    expect("resolveFinalIndex" in sealed).toBe(false);
    expectInvariant(() => session.bindAndPublish(module), "session-publish-once");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });
});

function expectPreparedInvariant(action: () => unknown, code: PreparedIrProgramInvariantCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect((caught as PreparedIrProgramInvariantError).code).toBe(code);
}

function preparedCoreFixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/prepared-core.ts",
    [
      "export function alpha(value: number): number { return value + 1; }",
      "function beta(value: number): number { return alpha(value) * 2; }",
      "function legacy(value: unknown): unknown { return value; }",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const units = new Map(
    inventory.terminalUnits
      .filter((unit) => unit.kind === "top-level-function")
      .map((unit) => [unit.displayName, unit] as const),
  );
  const alpha = units.get("alpha");
  const beta = units.get("beta");
  const legacy = units.get("legacy");
  if (!alpha || !beta || !legacy) throw new Error("missing prepared-core function inventory");
  const abi = new ProgramAbiMap(inventory);
  abi.sealPlan();
  return { abi, alpha, beta, legacy };
}

function preparedInput(unitId: IrUnitId, marker: string): PreparedIrIrCandidateInput {
  return {
    unitId,
    assertedSignature: { params: ["f64"], results: ["f64"] },
    assertedBackendLegality: { backend: "wasmgc", target: "gc", verified: true },
    assertedOptimization: {
      inlineSmall: marker === "beta" ? "applied" : "not-applicable",
      monomorphization: marker === "alpha" ? "applied" : "not-applicable",
      allocationProvenance: "verified",
    },
    irCandidate: { marker, blocks: [{ id: 0, instructions: [] }] },
  };
}

function validPreparedCore(): {
  readonly program: PreparedIrProgram;
  readonly alphaId: IrUnitId;
  readonly betaId: IrUnitId;
  readonly legacyId: IrUnitId;
} {
  const { abi, alpha, beta, legacy } = preparedCoreFixture();
  const builder = new PreparedIrProgramBuilder(abi);
  builder.recordIrCandidate(preparedInput(alpha.id, "alpha"));
  builder.recordIrCandidate(preparedInput(beta.id, "beta"));
  builder.recordDirectCandidate({
    unitId: legacy.id,
    code: "unsupported-syntax",
    stage: "select",
    detail: "temporary direct policy",
  });
  builder.addComponentCandidate({ id: "prepared-call-graph", unitIds: [alpha.id, beta.id] });
  builder.addComponentCandidate({ id: "legacy-singleton", unitIds: [legacy.id] });
  return { program: builder.seal(), alphaId: alpha.id, betaId: beta.id, legacyId: legacy.id };
}

describe("#3521 PreparedIrProgram structural ownership", () => {
  it("owns the exact inventory while labeling all unwired evidence and components as candidates", () => {
    const { abi, alpha, beta, legacy } = preparedCoreFixture();
    const builder = new PreparedIrProgramBuilder(abi);
    builder.recordIrCandidate(preparedInput(alpha.id, "alpha"));
    builder.recordIrCandidate(preparedInput(beta.id, "beta"));
    builder.recordDirectCandidate({
      unitId: legacy.id,
      code: "unsupported-syntax",
      stage: "select",
      detail: "temporary hybrid route",
    });
    builder.addComponentCandidate({ id: "numeric", unitIds: [alpha.id, beta.id] });
    builder.addComponentCandidate({ id: "direct", unitIds: [legacy.id] });

    const supportIntents = [
      { key: "callback:host", kind: "host-callback", ownerUnitId: alpha.id },
      { key: "date:snapshot", kind: "runtime-entry", ownerUnitId: alpha.id, detail: "Date snapshot" },
      { key: "promise:delay", kind: "runtime-entry", ownerUnitId: beta.id, detail: "Promise delay" },
      { key: "literal:hello", kind: "literal", ownerUnitId: alpha.id },
      { key: "closure:lifted:0", kind: "lifted-closure", ownerUnitId: alpha.id },
      { key: "clone:mono:0", kind: "monomorphized-clone", ownerUnitId: alpha.id },
    ] as const;
    for (const intent of supportIntents) builder.addSupportIntentCandidate(intent);
    builder.addAllocationCandidate({ key: "literal:hello", kind: "literal", ownerUnitId: alpha.id, ordinal: 0 });
    builder.addAllocationCandidate({ key: "helper:promise", kind: "helper", ownerUnitId: beta.id, ordinal: 0 });
    const liftedId = createDerivedIrUnitId({ parentId: alpha.id, role: "lifted-closure", ordinal: 0 });
    const cloneId = createDerivedIrUnitId({ parentId: alpha.id, role: "monomorphization-clone", ordinal: 0 });
    builder.addProvenanceCandidate({
      artifactUnitId: liftedId,
      ownerUnitId: alpha.id,
      parentUnitId: alpha.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    builder.addProvenanceCandidate({
      artifactUnitId: cloneId,
      ownerUnitId: alpha.id,
      parentUnitId: alpha.id,
      role: "monomorphization-clone",
      ordinal: 0,
    });

    const program = builder.seal();
    expect(Object.isFrozen(program)).toBe(true);
    expect(program.units.size).toBe(3);
    expect(program.irCandidates.size).toBe(2);
    expect(program.directCandidates.size).toBe(1);
    expect(program.invariantCandidates.size).toBe(0);
    expect(program.reconciliation).toBe("pending-production-wiring");
    expect(
      program.componentCandidates.map((component) => [
        component.id,
        component.candidateRoutes,
        component.evidenceStatus,
      ]),
    ).toEqual([
      ["numeric", ["ir"], "unvalidated-component-candidate"],
      ["direct", ["direct"], "unvalidated-component-candidate"],
    ]);
    expect(program.supportIntentCandidates.map((intent) => intent.key)).toEqual(
      supportIntents.map((intent) => intent.key),
    );
    expect(program.supportIntentCandidates.every((intent) => intent.evidenceStatus === "unvalidated-candidate")).toBe(
      true,
    );
    expect(Object.isFrozen(program.supportIntentCandidates)).toBe(true);
    expect((program.units as Map<IrUnitId, unknown>).set).toBeUndefined();
    expect(program.irCandidates.get(beta.id)?.assertedOptimization.inlineSmall).toBe("applied");
    expect(program.irCandidates.get(alpha.id)?.assertedOptimization.monomorphization).toBe("applied");
    expect(program.provenanceCandidates.map((record) => record.artifactUnitId)).toEqual([liftedId, cloneId]);

    const emission = program.beginEmission();
    emission.emitIr(alpha.id, { op: "ir.alpha" });
    emission.emitIr(beta.id, { op: "ir.beta" });
    emission.emitDirect(legacy.id, { op: "direct.legacy" });
    const publication = emission.publish();
    expect(publication.evidenceStatus).toBe("unvalidated-candidate-publication");
    expect(publication.bodies.size).toBe(3);
    expect(publication.ledger.get(alpha.id)).toEqual({
      unitId: alpha.id,
      candidateRoute: "ir",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 1,
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(publication.ledger.get(legacy.id)).toEqual({
      unitId: legacy.id,
      candidateRoute: "direct",
      prepareAttempts: 1,
      directBodyEmissions: 1,
      irBodyEmissions: 0,
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expectPreparedInvariant(() => program.beginEmission(), "emission-already-started");
    expectPreparedInvariant(() => emission.emitIr(alpha.id, {}), "transaction-closed");
  });

  it("fails sealing for missing or duplicate unit candidates and duplicate component-candidate IDs", () => {
    const missingFixture = preparedCoreFixture();
    const missing = new PreparedIrProgramBuilder(missingFixture.abi);
    missing.recordIrCandidate(preparedInput(missingFixture.alpha.id, "alpha"));
    missing.recordIrCandidate(preparedInput(missingFixture.beta.id, "beta"));
    missing.addComponentCandidate({
      id: "all",
      unitIds: [missingFixture.alpha.id, missingFixture.beta.id, missingFixture.legacy.id],
    });
    expectPreparedInvariant(() => missing.seal(), "missing-unit");
    expectPreparedInvariant(
      () =>
        missing.recordInvariantCandidate({ unitId: missingFixture.legacy.id, code: "x", stage: "build", detail: "x" }),
      "program-seal-failed",
    );

    const duplicateFixture = preparedCoreFixture();
    const duplicate = new PreparedIrProgramBuilder(duplicateFixture.abi);
    duplicate.recordIrCandidate(preparedInput(duplicateFixture.alpha.id, "alpha"));
    duplicate.recordIrCandidate(preparedInput(duplicateFixture.alpha.id, "alpha-again"));
    duplicate.recordIrCandidate(preparedInput(duplicateFixture.beta.id, "beta"));
    duplicate.recordDirectCandidate({ unitId: duplicateFixture.legacy.id, code: "x", stage: "select", detail: "x" });
    duplicate.addComponentCandidate({ id: "a", unitIds: [duplicateFixture.alpha.id] });
    duplicate.addComponentCandidate({ id: "b", unitIds: [duplicateFixture.beta.id, duplicateFixture.legacy.id] });
    expectPreparedInvariant(() => duplicate.seal(), "duplicate-unit");

    const componentsFixture = preparedCoreFixture();
    const components = new PreparedIrProgramBuilder(componentsFixture.abi);
    components.recordIrCandidate(preparedInput(componentsFixture.alpha.id, "alpha"));
    components.recordIrCandidate(preparedInput(componentsFixture.beta.id, "beta"));
    components.recordDirectCandidate({ unitId: componentsFixture.legacy.id, code: "x", stage: "select", detail: "x" });
    components.addComponentCandidate({ id: "same", unitIds: [componentsFixture.alpha.id] });
    components.addComponentCandidate({ id: "same", unitIds: [componentsFixture.beta.id] });
    expectPreparedInvariant(() => components.seal(), "duplicate-component-candidate");
  });

  it("keeps mixed caller groupings explicitly unvalidated instead of treating them as atomic components", () => {
    const { abi, alpha, beta, legacy } = preparedCoreFixture();
    const builder = new PreparedIrProgramBuilder(abi);
    builder.recordIrCandidate(preparedInput(alpha.id, "alpha"));
    builder.recordDirectCandidate({
      unitId: beta.id,
      code: "unsafe-abi-edge",
      stage: "resolve",
      detail: "unsafe edge",
    });
    builder.recordDirectCandidate({ unitId: legacy.id, code: "unsupported-syntax", stage: "select", detail: "legacy" });
    builder.addComponentCandidate({ id: "unsafe-local-edge", unitIds: [alpha.id, beta.id] });
    builder.addComponentCandidate({ id: "legacy", unitIds: [legacy.id] });
    const program = builder.seal();
    expect(program.componentCandidates[0]).toEqual({
      id: "unsafe-local-edge",
      unitIds: [alpha.id, beta.id],
      candidateRoutes: ["ir", "direct"],
      evidenceStatus: "unvalidated-component-candidate",
    });
    expect(program.reconciliation).toBe("pending-production-wiring");
  });

  it("rejects unsealed ABI input and support requests after the atomic seal", () => {
    const fixture = preparedCoreFixture();
    const unsealed = new ProgramAbiMap(fixture.abi.inventory);
    expectPreparedInvariant(() => new PreparedIrProgramBuilder(unsealed), "abi-not-sealed");

    const { program, alphaId } = validPreparedCore();
    expect(program.sealed).toBe(true);
    const sealedBuilder = new PreparedIrProgramBuilder(fixture.abi);
    sealedBuilder.recordIrCandidate(preparedInput(fixture.alpha.id, "alpha"));
    sealedBuilder.recordIrCandidate(preparedInput(fixture.beta.id, "beta"));
    sealedBuilder.recordDirectCandidate({
      unitId: fixture.legacy.id,
      code: "unsupported-syntax",
      stage: "select",
      detail: "legacy",
    });
    sealedBuilder.addComponentCandidate({ id: "prepared", unitIds: [fixture.alpha.id, fixture.beta.id] });
    sealedBuilder.addComponentCandidate({ id: "direct", unitIds: [fixture.legacy.id] });
    sealedBuilder.seal();
    expectPreparedInvariant(
      () => sealedBuilder.addSupportIntentCandidate({ key: "late:helper", kind: "helper", ownerUnitId: alphaId }),
      "late-support-intent",
    );
  });

  it("makes emission-transaction construction capability-only", () => {
    const { program } = validPreparedCore();
    expect(Object.isFrozen(PreparedIrEmissionTransaction)).toBe(true);
    expect(Object.isFrozen(PreparedIrEmissionTransaction.prototype)).toBe(true);
    expectPreparedInvariant(
      () =>
        Reflect.construct(PreparedIrEmissionTransaction as unknown as Function, [program, Symbol("forged-capability")]),
      "invalid-transaction-capability",
    );
    expect(program.beginEmission()).toBeInstanceOf(PreparedIrEmissionTransaction);
  });

  it("defensively owns builder and factory maps, arrays, and nested candidate data", () => {
    const { abi, alpha, beta, legacy } = preparedCoreFixture();
    const params = ["f64"];
    const blocks = [{ id: 0, instructions: [] as string[] }];
    const lookup = new Map([["alpha", { slot: 1 }]]);
    const labels = new Set(["prepared"]);
    const builder = new PreparedIrProgramBuilder(abi);
    builder.recordIrCandidate({
      ...preparedInput(alpha.id, "alpha"),
      assertedSignature: { params, results: ["f64"] },
      irCandidate: { blocks, lookup, labels },
    });
    params[0] = "externref";
    blocks[0]!.id = 99;
    blocks[0]!.instructions.push("mutated");
    lookup.get("alpha")!.slot = 99;
    lookup.set("late", { slot: 2 });
    labels.add("late");
    builder.recordIrCandidate(preparedInput(beta.id, "beta"));
    builder.recordDirectCandidate({ unitId: legacy.id, code: "x", stage: "select", detail: "x" });
    const program = builder.seal();
    expect(program.irCandidates.get(alpha.id)?.assertedSignature.params).toEqual(["f64"]);
    const ownedBuilderCandidate = program.irCandidates.get(alpha.id)?.irCandidate as {
      blocks: readonly { id: number; instructions: readonly string[] }[];
      lookup: ReadonlyMap<string, { slot: number }>;
      labels: ReadonlySet<string>;
    };
    expect(ownedBuilderCandidate.blocks).toEqual([{ id: 0, instructions: [] }]);
    expect([...ownedBuilderCandidate.lookup]).toEqual([["alpha", { slot: 1 }]]);
    expect([...ownedBuilderCandidate.labels]).toEqual(["prepared"]);

    const originalAlpha = program.irCandidates.get(alpha.id)!;
    const factoryParams = ["f64"];
    const factoryBlocks = [{ id: 0 }];
    const mutableUnits = new Map(program.units);
    mutableUnits.set(alpha.id, {
      ...originalAlpha,
      assertedSignature: { params: factoryParams, results: ["f64"] },
      irCandidate: { blocks: factoryBlocks },
    });
    const mutableComponentIds = [alpha.id, beta.id];
    const mutableComponents = [{ id: "mutable", unitIds: mutableComponentIds }];
    const mutableSupport = [{ key: "mutable:support", kind: "helper" as const, ownerUnitId: alpha.id }];
    const mutableAllocation = [
      { key: "mutable:allocation", kind: "helper" as const, ownerUnitId: alpha.id, ordinal: 0 },
    ];
    const mutableProvenance = [
      {
        artifactUnitId: createDerivedIrUnitId({
          parentId: alpha.id,
          role: "monomorphization-clone",
          ordinal: 1,
        }),
        ownerUnitId: alpha.id,
        parentUnitId: alpha.id,
        role: "monomorphization-clone" as const,
        ordinal: 1,
      },
    ];
    const mutableEntries = [...program.abi.entries];
    const factoryProgram = createPreparedIrCandidateProgram({
      abiEntries: mutableEntries,
      units: mutableUnits,
      componentCandidates: mutableComponents,
      supportIntentCandidates: mutableSupport,
      allocationCandidates: mutableAllocation,
      provenanceCandidates: mutableProvenance,
    });
    mutableUnits.clear();
    factoryParams[0] = "externref";
    factoryBlocks[0]!.id = 77;
    mutableComponentIds.push(legacy.id);
    mutableComponents[0]!.id = "changed";
    mutableSupport[0]!.key = "changed";
    mutableAllocation[0]!.key = "changed";
    mutableProvenance[0]!.ordinal = 99;
    mutableEntries.length = 0;
    expect(factoryProgram.units.size).toBe(3);
    expect(factoryProgram.irCandidates.get(alpha.id)?.assertedSignature.params).toEqual(["f64"]);
    expect(factoryProgram.irCandidates.get(alpha.id)?.irCandidate).toEqual({ blocks: [{ id: 0 }] });
    expect(factoryProgram.componentCandidates[0]?.id).toBe("mutable");
    expect(factoryProgram.componentCandidates[0]?.unitIds).toEqual([alpha.id, beta.id]);
    expect(factoryProgram.supportIntentCandidates[0]?.key).toBe("mutable:support");
    expect(factoryProgram.allocationCandidates[0]?.key).toBe("mutable:allocation");
    expect(factoryProgram.provenanceCandidates[0]?.ordinal).toBe(1);
    expect(factoryProgram.abi.entries).toEqual(program.abi.entries);
  });

  it("recursively owns exported readonly-map wrappers and rejects cycles through them", () => {
    const { program, alphaId } = validPreparedCore();
    const alpha = program.irCandidates.get(alphaId)!;
    const nested = { slot: 1 };
    const wrapped = preparedIrReadonlyMap([["alpha", nested] as const]);
    const units = new Map(program.units);
    units.set(alphaId, {
      ...alpha,
      irCandidate: { wrapped },
    });
    const ownedProgram = createPreparedIrCandidateProgram({
      abiEntries: program.abi.entries,
      units,
      componentCandidates: program.componentCandidates,
      supportIntentCandidates: program.supportIntentCandidates,
      allocationCandidates: program.allocationCandidates,
      provenanceCandidates: program.provenanceCandidates,
    });
    nested.slot = 99;
    const ownedWrapped = (
      ownedProgram.irCandidates.get(alphaId)?.irCandidate as {
        wrapped: ReadonlyMap<string, { slot: number }>;
      }
    ).wrapped;
    expect(ownedWrapped.get("alpha")?.slot).toBe(1);
    expect(ownedWrapped).not.toBe(wrapped);

    const cycleTarget: { wrapped?: ReadonlyMap<string, unknown> } = {};
    const cyclicWrapper = preparedIrReadonlyMap([["cycle", cycleTarget] as const]);
    cycleTarget.wrapped = cyclicWrapper;
    const cyclicUnits = new Map(program.units);
    cyclicUnits.set(alphaId, {
      ...alpha,
      irCandidate: { wrapped: cyclicWrapper },
    });
    expectPreparedInvariant(
      () =>
        createPreparedIrCandidateProgram({
          abiEntries: program.abi.entries,
          units: cyclicUnits,
          componentCandidates: program.componentCandidates,
          supportIntentCandidates: program.supportIntentCandidates,
          allocationCandidates: program.allocationCandidates,
          provenanceCandidates: program.provenanceCandidates,
        }),
      "invalid-prepared-data",
    );
  });

  it("owns exact recursive class-shape cells while rejecting unbranded lookalike cycles", () => {
    const { abi, alpha, beta, legacy } = preparedCoreFixture();
    const left = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: "ir-class:v1:test:root:class:0",
      className: "Left",
      fields: [],
      methods: [],
      constructorParams: [],
    } as unknown as IrClassShape;
    const right = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: "ir-class:v1:test:root:class:1",
      className: "Right",
      fields: [],
      methods: [],
      constructorParams: [],
    } as unknown as IrClassShape;
    (left.fields as { name: string; type: unknown }[]).push({ name: "right", type: { kind: "class", shape: right } });
    (right.fields as { name: string; type: unknown }[]).push({ name: "left", type: { kind: "class", shape: left } });

    const builder = new PreparedIrProgramBuilder(abi);
    builder.recordIrCandidate({ ...preparedInput(alpha.id, "alpha"), irCandidate: { shape: left } });
    builder.recordIrCandidate(preparedInput(beta.id, "beta"));
    builder.recordDirectCandidate({ unitId: legacy.id, code: "x", stage: "select", detail: "x" });
    const program = builder.seal();
    const ownedLeft = (program.irCandidates.get(alpha.id)?.irCandidate as { shape: IrClassShape }).shape;
    const ownedRight = (ownedLeft.fields[0]!.type as { kind: "class"; shape: IrClassShape }).shape;
    expect((ownedRight.fields[0]!.type as { kind: "class"; shape: IrClassShape }).shape).toBe(ownedLeft);
    expect(Object.isFrozen(ownedLeft)).toBe(true);
    expect(Object.isFrozen(ownedRight)).toBe(true);

    const lookalike = {
      classId: "ir-class:v1:test:root:class:2",
      className: "Forged",
      fields: [],
      methods: [],
      constructorParams: [],
    } as Record<string, unknown>;
    lookalike.self = lookalike;
    const rejectedFixture = preparedCoreFixture();
    const rejected = new PreparedIrProgramBuilder(rejectedFixture.abi);
    const rejectedUnit = rejectedFixture.alpha;
    expectPreparedInvariant(
      () =>
        rejected.recordIrCandidate({
          ...preparedInput(rejectedUnit.id, "alpha"),
          irCandidate: { shape: lookalike },
        }),
      "invalid-prepared-data",
    );
  });

  it("fails closed on inconsistent direct-factory unit identity and unknown grouping units", () => {
    const { program, alphaId } = validPreparedCore();
    const alpha = program.irCandidates.get(alphaId)!;
    expectPreparedInvariant(
      () =>
        createPreparedIrCandidateProgram({
          abiEntries: program.abi.entries,
          units: new Map([
            [
              alphaId,
              {
                ...alpha,
                kind: "unknown-kind",
                route: undefined,
              } as never,
            ],
          ]),
          componentCandidates: [],
          supportIntentCandidates: [],
          allocationCandidates: [],
          provenanceCandidates: [],
        }),
      "invalid-prepared-data",
    );
    expectPreparedInvariant(
      () =>
        createPreparedIrCandidateProgram({
          abiEntries: program.abi.entries,
          units: new Map([[alphaId, { ...alpha, unitId: "forged-unit" as IrUnitId }]]),
          componentCandidates: [],
          supportIntentCandidates: [],
          allocationCandidates: [],
          provenanceCandidates: [],
        }),
      "invalid-prepared-data",
    );
    expectPreparedInvariant(
      () =>
        createPreparedIrCandidateProgram({
          abiEntries: program.abi.entries,
          units: new Map([[alphaId, alpha]]),
          componentCandidates: [{ id: "unknown", unitIds: ["unknown-unit" as IrUnitId] }],
          supportIntentCandidates: [],
          allocationCandidates: [],
          provenanceCandidates: [],
        }),
      "unknown-unit",
    );
  });

  it("rejects nested functions as non-data and aborts the preparation collector without retry", () => {
    const { abi, alpha, beta } = preparedCoreFixture();
    const builder = new PreparedIrProgramBuilder(abi);
    expectPreparedInvariant(
      () =>
        builder.recordIrCandidate({
          ...preparedInput(alpha.id, "alpha"),
          irCandidate: { nested: { execute: () => 1 } },
        }),
      "invalid-prepared-data",
    );
    expectPreparedInvariant(() => builder.recordIrCandidate(preparedInput(beta.id, "beta")), "program-seal-failed");
  });

  it("rejects accessors before executing them in builder and direct-factory inputs", () => {
    const { abi, alpha } = preparedCoreFixture();
    const builder = new PreparedIrProgramBuilder(abi);
    let unitGetterCalls = 0;
    const accessorCandidate = { ...preparedInput(alpha.id, "alpha") };
    Object.defineProperty(accessorCandidate, "unitId", {
      enumerable: true,
      configurable: true,
      get() {
        unitGetterCalls++;
        return alpha.id;
      },
    });
    expectPreparedInvariant(
      () => builder.recordIrCandidate(accessorCandidate as PreparedIrIrCandidateInput),
      "invalid-prepared-data",
    );
    expect(unitGetterCalls).toBe(0);

    const { program } = validPreparedCore();
    let supportGetterCalls = 0;
    const accessorSupport = { kind: "helper" as const };
    Object.defineProperty(accessorSupport, "key", {
      enumerable: true,
      configurable: true,
      get() {
        supportGetterCalls++;
        return "forged:getter";
      },
    });
    expectPreparedInvariant(
      () =>
        createPreparedIrCandidateProgram({
          abiEntries: program.abi.entries,
          units: program.units,
          componentCandidates: [],
          supportIntentCandidates: [accessorSupport as never],
          allocationCandidates: [],
          provenanceCandidates: [],
        }),
      "invalid-prepared-data",
    );
    expect(supportGetterCalls).toBe(0);
  });

  it("aborts atomically on staging exceptions and nested functions, with no retry or publication", () => {
    const throwing = validPreparedCore();
    const throwingTx = throwing.program.beginEmission();
    const stagingError = new Error("injected-ownKeys-failure");
    const hostileBody = new Proxy(
      {},
      {
        ownKeys() {
          throw stagingError;
        },
      },
    );
    expect(() => throwingTx.emitIr(throwing.alphaId, hostileBody)).toThrow(stagingError);
    expect(throwingTx.publication).toBeUndefined();
    expect(throwingTx.ledger.get(throwing.alphaId)?.irBodyEmissions).toBe(0);
    expectPreparedInvariant(() => throwingTx.emitIr(throwing.alphaId, {}), "transaction-closed");
    expectPreparedInvariant(() => throwingTx.publish(), "transaction-closed");

    const executable = validPreparedCore();
    const executableTx = executable.program.beginEmission();
    expectPreparedInvariant(
      () => executableTx.emitIr(executable.alphaId, { nested: { execute: () => 1 } }),
      "invalid-prepared-data",
    );
    expect(executableTx.publication).toBeUndefined();
    expectPreparedInvariant(() => executableTx.emitIr(executable.alphaId, {}), "transaction-closed");
  });

  it("fails closed on wrong-direction, duplicate, and partial emission without publishing a body", () => {
    const wrong = validPreparedCore();
    const wrongTx = wrong.program.beginEmission();
    expectPreparedInvariant(() => wrongTx.emitDirect(wrong.alphaId, { op: "wrong" }), "wrong-emitter");
    expect(wrongTx.publication).toBeUndefined();
    expect(wrongTx.ledger.get(wrong.alphaId)?.directBodyEmissions).toBe(0);
    expectPreparedInvariant(() => wrongTx.emitIr(wrong.alphaId, { op: "late" }), "transaction-closed");

    const duplicate = validPreparedCore();
    const duplicateTx = duplicate.program.beginEmission();
    duplicateTx.emitIr(duplicate.alphaId, { op: "first" });
    expectPreparedInvariant(() => duplicateTx.emitIr(duplicate.alphaId, { op: "second" }), "duplicate-emission");
    expect(duplicateTx.publication).toBeUndefined();
    expect(duplicateTx.ledger.get(duplicate.alphaId)?.irBodyEmissions).toBe(1);

    const failed = validPreparedCore();
    const failedTx = failed.program.beginEmission();
    expectPreparedInvariant(
      () => failedTx.failEmission(failed.alphaId, "ir", "injected backend invariant"),
      "emission-failed",
    );
    expect(failedTx.publication).toBeUndefined();
    expect(failedTx.ledger.get(failed.alphaId)?.directBodyEmissions).toBe(0);
    expect(failedTx.ledger.get(failed.alphaId)?.irBodyEmissions).toBe(0);

    const partial = validPreparedCore();
    const partialTx = partial.program.beginEmission();
    partialTx.emitIr(partial.alphaId, { op: "only-one" });
    expectPreparedInvariant(() => partialTx.publish(), "partial-publication");
    expect(partialTx.publication).toBeUndefined();
    expectPreparedInvariant(() => partialTx.emitIr(partial.betaId, { op: "too-late" }), "transaction-closed");
  });

  it("keeps invariant candidates on the neither-emitter route", () => {
    const { abi, alpha, beta, legacy } = preparedCoreFixture();
    const builder = new PreparedIrProgramBuilder(abi);
    builder.recordInvariantCandidate({
      unitId: alpha.id,
      code: "selection-preparation-mismatch",
      stage: "verify",
      detail: "injected invariant",
    });
    builder.recordIrCandidate(preparedInput(beta.id, "beta"));
    builder.recordDirectCandidate({ unitId: legacy.id, code: "unsupported-syntax", stage: "select", detail: "legacy" });
    builder.addComponentCandidate({ id: "invariant", unitIds: [alpha.id] });
    builder.addComponentCandidate({ id: "prepared", unitIds: [beta.id] });
    builder.addComponentCandidate({ id: "direct", unitIds: [legacy.id] });
    const program = builder.seal();
    expect(program.invariantCandidates.size).toBe(1);
    expectPreparedInvariant(() => program.beginEmission(), "program-has-invariant-candidate");
  });
});
