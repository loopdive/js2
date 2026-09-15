// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { describeProgramAbiUnitCallable, planProgramAbiUnitCallable } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  describePreparedUnitCallables,
  type PreparedUnitCallableDescriptor,
} from "../src/codegen/program-abi-unit-callable-preparation.js";
import { irCallableBindingKey, irRuntimeFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { createEmptyModule, type FuncTypeDef, type WasmFunction, type StructTypeDef } from "../src/ir/types.js";
import { irVal } from "../src/ir/nodes.js";
import { describePreparedSupportTypes } from "../src/codegen/program-abi-support-type-preparation.js";
import { ProgramAbiTypeRegistry } from "../src/codegen/program-abi-type-planning.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";
import { describeProgramAbiSupportType } from "../src/codegen/program-abi-support-type-description.js";
import { irSupportTypeRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";

function fixture(sourceText = "export function run(): number { return 42; }") {
  const source = ts.createSourceFile("/repo/issue-1058.ts", sourceText, ts.ScriptTarget.Latest, true);
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const unit = inventory.terminalUnits.find((row) => row.kind === "top-level-function");
  if (!unit) throw new Error("missing callable description control unit");
  const module = createEmptyModule();
  const signature: FuncTypeDef = { kind: "func", params: [], results: [{ kind: "f64" }] };
  module.types.push(signature);
  const func: WasmFunction = {
    name: "run",
    typeIdx: 0,
    locals: [],
    body: [{ op: "f64.const", value: 42 }],
    exported: true,
  };
  module.functions.push(func);
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
  const plan = { ref: irUnitFuncRef({ unitId: unit.id, name: "run" }), signature, func };
  return { ctx, session, plan };
}

function supportTypeFixture() {
  const f = fixture("export function run(): number { return 42; } export function other(): number { return 42; }");
  const type: StructTypeDef = {
    kind: "struct",
    name: "support_cell",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: true }],
  };
  f.ctx.programAbiTypes = new ProgramAbiTypeRegistry(
    f.session,
    f.ctx,
    buildIrPlanningIdentityContext(f.session.inventory),
  );
  f.ctx.mod.types.push(type);
  const request = { innerType: irVal({ kind: "f64" }), cellType: type };
  const [support] = f.ctx.programAbiTypes!.prepareRefCellSupportTypes([request], true);
  const id = support!.cellTypeRef.binding.bindingId;
  const units = f.session.inventory.terminalUnits.filter((unit) => unit.kind === "top-level-function");
  units.forEach((unit, index) => {
    const func = index === 0 ? f.plan.func : { ...f.plan.func, name: "other" };
    if (index > 0) f.ctx.mod.functions.push(func);
    planProgramAbiUnitCallable(f.ctx, {
      ref: irUnitFuncRef({ unitId: unit.id, name: func.name }),
      signature: f.plan.signature,
      func,
    });
  });
  return { ...f, type, request, id, units };
}

it.each(["abort", "seal"] as const)("publishes candidate support types only on %s", (action) => {
  const f = supportTypeFixture();
  const unitId = f.units[0]!.id;
  const token = describePreparedSupportTypes(f.ctx, [unitId], [f.id]);
  const scope = f.session.beginPreparedComponentScope("support-control", [unitId]);
  scope.stagePreparedComponentBatch({
    scopeId: "support-control",
    terminalUnitIds: [unitId],
    requestedStructuralReferenceKeys: [],
    supportTypes: token,
  });
  scope.includeBinding(f.id);
  expect(f.session.hasPlan(f.id)).toBe(false);
  expect(scope.abi.get(f.id)).toBeDefined();
  scope[action]();
  expect(f.session.hasPlan(f.id)).toBe(action === "seal");
  const secondId = f.units[1]!.id;
  const second = f.session.beginPreparedComponentScope("support-second", [secondId]);
  const fresh = describePreparedSupportTypes(f.ctx, [secondId], [f.id]);
  second.stagePreparedComponentBatch({
    scopeId: "support-second",
    terminalUnitIds: [secondId],
    requestedStructuralReferenceKeys: [],
    supportTypes: fresh,
  });
  second.includeBinding(f.id);
  second.abort();
  expect(f.session.hasPlan(f.id)).toBe(action === "seal");
  // Repeated default preparation promotes a described layout without changing its identity.
  const [published] = f.ctx.programAbiTypes!.prepareRefCellSupportTypes([f.request]);
  expect(published!.cellTypeRef.binding.bindingId).toBe(f.id);
  expect(f.session.hasPlan(f.id)).toBe(true);
});

it("rejects a stale support type descriptor before publication", () => {
  const f = supportTypeFixture();
  const unitId = f.units[0]!.id;
  const token = describePreparedSupportTypes(f.ctx, [unitId], [f.id]);
  const scope = f.session.beginPreparedComponentScope("support-stale", [unitId]);
  f.type.fields = [];
  expect(() =>
    scope.stagePreparedComponentBatch({
      scopeId: "support-stale",
      terminalUnitIds: [unitId],
      requestedStructuralReferenceKeys: [],
      supportTypes: token,
    }),
  ).toThrow("exact allocator or shape");
  scope.abort();
  expect(f.session.hasPlan(f.id)).toBe(false);
});

it("describes a support type without publishing required ownership", () => {
  const { session, plan } = fixture();
  const source = session.inventory.sources.find((source) => source.kind === "entry")!;
  const ref = irSupportTypeRef(source.id, "description-control", "support_type");
  const cell = session.createTypeCell(plan.signature);
  const input = {
    session,
    entrySourceId: source.id,
    ref,
    cell,
    type: plan.signature,
    roleOrdinal: 0,
    derivedOrdinal: 0,
  };
  const contribution = describeProgramAbiSupportType(input);
  const id = contribution.draft.id;
  const key = irTypeBindingKey(ref.binding);
  expect(session.hasPlan(id)).toBe(false);
  expect(session.hasLocator(id)).toBe(false);
  expect(session.locatorBindingId(cell)).toBeUndefined();
  expect(session.bindingIdsForStructuralReference(key)).toEqual([]);
  expect(contribution.locator).toEqual({ kind: "type-cell", cell });
  session.ensurePlan(contribution.draft);
  session.registerStructuralReference(id, key);
  session.attachLocator(id, contribution.locator!);
  expect(session.hasPlan(id)).toBe(true);
  expect(session.hasLocator(id, cell)).toBe(true);
  expect(session.bindingIdsForStructuralReference(key)).toEqual([id]);
  expect(describeProgramAbiSupportType(input)).toEqual(contribution);
  const foreign = fixture().session;
  expect(() => describeProgramAbiSupportType({ ...input, session: foreign })).toThrow("exact session-owned cell");
  expect(() => describeProgramAbiSupportType({ ...input, type: { ...plan.signature } })).toThrow(
    "exact session-owned cell",
  );
  expect(session.hasLocator(id, cell)).toBe(true);
});

it("describes the exact callable without publishing any ownership or contract", () => {
  const { ctx, session, plan } = fixture();
  const contribution = describeProgramAbiUnitCallable(ctx, plan);
  expect(contribution).toBeDefined();
  const id = contribution!.draft.id;
  const key = irCallableBindingKey(plan.ref.binding);
  expect(contribution!.locator).toEqual({ kind: "defined-function", value: plan.func });
  expect(contribution!.callableTypeContract).toEqual({ params: [], results: [{ kind: "f64" }] });
  expect(session.hasPlan(id)).toBe(false);
  expect(session.getDraft(id)).toBeUndefined();
  expect(session.hasLocator(id)).toBe(false);
  expect(session.locatorBindingId(plan.func)).toBeUndefined();
  expect(session.currentCallableContract(id)).toBeUndefined();
  expect(session.bindingIdsForStructuralReference(key)).toEqual([]);

  // A real publication is the positive control for every absent view above.
  expect(planProgramAbiUnitCallable(ctx, plan)).toBe(id);
  expect(session.getDraft(id)).toEqual(contribution!.draft);
  expect(session.hasLocator(id, plan.func)).toBe(true);
  expect(session.locatorBindingId(plan.func)).toBe(id);
  expect(session.currentCallableContract(id)).toEqual(contribution!.callableTypeContract);
  expect(session.bindingIdsForStructuralReference(key)).toEqual([id]);
  expect(planProgramAbiUnitCallable(ctx, plan)).toBe(id);
});

it("does not let a provisional contract mutate another description", () => {
  const { ctx, plan } = fixture();
  const first = describeProgramAbiUnitCallable(ctx, plan)!;
  const second = describeProgramAbiUnitCallable(ctx, plan)!;
  expect(first.callableTypeContract).not.toBe(second.callableTypeContract);
  expect(first.callableTypeContract!.results).not.toBe(plan.signature.results);
  expect(first.callableTypeContract!.results[0]).not.toBe(plan.signature.results[0]);
  expect(first).toEqual(second);
});

it("retains exact-unit validation and rejects foreign allocator ownership", () => {
  const { ctx, session, plan } = fixture();
  expect(
    describeProgramAbiUnitCallable(ctx, {
      ...plan,
      ref: irUnitFuncRef({ unitId: "missing-source-unit" as IrUnitId, name: "run" }),
    }),
  ).toBeUndefined();
  expect(() => describeProgramAbiUnitCallable(ctx, { ...plan, ref: irRuntimeFuncRef("run") })).toThrow(
    "requires an exact unit reference",
  );
  const id = planProgramAbiUnitCallable(ctx, plan)!;
  expect(() => planProgramAbiUnitCallable(ctx, { ...plan, func: { ...plan.func } })).toThrow();
  expect(session.hasLocator(id, plan.func)).toBe(true);
});

it.each(["abort", "seal"] as const)("stages unit ownership until scope %s", (action) => {
  const { ctx, session, plan } = fixture();
  if (plan.ref.binding.kind !== "unit") throw new Error("missing exact unit");
  const unitId = plan.ref.binding.unitId;
  ctx.irUnitFuncMap.set(unitId, plan.func);
  const contribution = describeProgramAbiUnitCallable(ctx, plan)!;
  const id = contribution.draft.id;
  const descriptor = describePreparedUnitCallables(ctx, [unitId], [plan]);
  const scope = session.beginPreparedComponentScope("unit-control", [unitId]);
  scope.stagePreparedComponentBatch({
    scopeId: "unit-control",
    terminalUnitIds: [unitId],
    requestedStructuralReferenceKeys: [],
    unitCallables: descriptor,
  });
  expect(session.hasPlan(id)).toBe(false);
  expect(session.hasLocator(id)).toBe(false);
  expect(scope.abi.get(id)).toEqual(contribution.draft);
  expect(scope.abi.locatorObject(id)).toBe(plan.func);
  // Source-unit reservations are included by the scope's exact unit census;
  // includeBinding is reserved for external/support dependencies.
  scope[action]();
  expect(session.hasPlan(id)).toBe(action === "seal");
  expect(session.hasLocator(id, plan.func)).toBe(action === "seal");
  if (action === "abort") {
    const replay = session.beginPreparedComponentScope("unit-replay", [unitId]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "unit-replay",
        terminalUnitIds: [unitId],
        requestedStructuralReferenceKeys: [],
        unitCallables: descriptor,
      }),
    ).toThrow("already claimed");
    replay.abort();
    expect(session.hasPlan(id)).toBe(false);
  }
});

it("rejects forged and stale unit descriptors without committing ownership", () => {
  const { ctx, session, plan } = fixture();
  if (plan.ref.binding.kind !== "unit") throw new Error("missing exact unit");
  const unitId = plan.ref.binding.unitId;
  ctx.irUnitFuncMap.set(unitId, plan.func);
  const id = describeProgramAbiUnitCallable(ctx, plan)!.draft.id;
  const forged = session.beginPreparedComponentScope("forged", [unitId]);
  expect(() =>
    forged.stagePreparedComponentBatch({
      scopeId: "forged",
      terminalUnitIds: [unitId],
      requestedStructuralReferenceKeys: [],
      unitCallables: { kind: "prepared-unit-callables" } as PreparedUnitCallableDescriptor,
    }),
  ).toThrow("foreign prepared unit callable scope");
  forged.abort();
  const descriptor = describePreparedUnitCallables(ctx, [unitId], [plan]);
  const stale = session.beginPreparedComponentScope("stale", [unitId]);
  ctx.irUnitFuncMap.set(unitId, { ...plan.func });
  expect(() =>
    stale.stagePreparedComponentBatch({
      scopeId: "stale",
      terminalUnitIds: [unitId],
      requestedStructuralReferenceKeys: [],
      unitCallables: descriptor,
    }),
  ).toThrow("exact unit allocator");
  stale.abort();
  expect(session.hasPlan(id)).toBe(false);
  expect(session.hasLocator(id)).toBe(false);
});
