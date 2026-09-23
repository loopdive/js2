// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { CodegenOptions } from "../src/codegen/context/types.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { describePreparedSupportTypes } from "../src/codegen/program-abi-support-type-preparation.js";
import { getOrRegisterRefCellType } from "../src/codegen/registry/types.js";
import { ProgramAbiTypeRegistry } from "../src/codegen/program-abi-type-planning.js";
import { resolveIrDynamicCarrierType } from "../src/codegen/any-helpers.js";
import { canonicalProgramAbiRefCellKey } from "../src/ir/core/support-key.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { ClosureStructRegistry } from "../src/ir/closure-struct-registry.js";
import {
  collectClosureDynamicCarrierDemands,
  lowerPreparedClosureSupportType,
  prepareDerivedCallableTypeIdx,
} from "../src/ir/prepared-closure-support.js";
import type {
  ClosureDynamicCarrierDemand,
  ClosureDynamicCarrierEvidence,
} from "../src/ir/program/closure-dynamic-carrier.js";
import type { IrType, IrFunction } from "../src/ir/nodes.js";
import { createEmptyModule, type StructTypeDef } from "../src/ir/types.js";
import { ProgramAbiInvariantError } from "../src/shared/contracts/program-abi-error.js";
import { compile } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());
const dynamic: Extract<IrType, { kind: "dynamic" }> = { kind: "dynamic" };
const tagged: Extract<IrType, { kind: "dynamic" }> = { kind: "dynamic", tag: 7 as never };
function fixture(options: CodegenOptions = { fast: true, nativeStrings: true }) {
  const ast = analyzeSource(
    "export function first(): number { return 1; } export function second(): number { return 2; }",
    "/repo/dynamic-evidence.ts",
  );
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(mod, ast.checker, options, session, buildIrPlanningIdentityContext(inventory));
  const registry = ctx.programAbiTypes!;
  expect(registry).toBeInstanceOf(ProgramAbiTypeRegistry);
  const terminals = inventory.terminalUnits.map(({ id }) => id);
  expect(terminals.length).toBeGreaterThanOrEqual(2);
  const demand = (index = 0, type = dynamic): ClosureDynamicCarrierDemand => ({
    terminalUnitId: terminals[index]!,
    logicalTypeKey: canonicalProgramAbiRefCellKey(type),
    role: "closure-dynamic-payload",
  });
  const entry = (type: IrType = dynamic, index = 0) => {
    const b = new IrFunctionBuilder({ unitId: terminals[index]!, name: "same-display" }, [type]);
    const value = b.addParam("value", type);
    b.openBlock();
    b.terminate({ kind: "return", values: [value] });
    return { terminalOwnerUnitId: terminals[index]!, fn: b.finish() };
  };
  return { ctx, mod, session, registry, demand, entry, terminals };
}
type Fixture = ReturnType<typeof fixture>;
function state(f: Fixture) {
  const internal = f.session as unknown as { drafts: Map<unknown, unknown>; openPreparedScopeIds: Set<unknown> };
  return {
    types: [...f.mod.types],
    globals: [...f.mod.globals],
    imports: [...f.mod.imports],
    functions: [...f.mod.functions],
    drafts: [...internal.drafts],
    pending: [...internal.openPreparedScopeIds],
    candidates: [...f.registry.provisionalSupportTypes()],
    undefinedGlobal: f.ctx.undefinedGlobalIdx,
    anyValueTypeIdx: f.ctx.anyValueTypeIdx,
  };
}
function rejected(action: () => unknown, message: RegExp) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProgramAbiInvariantError);
  expect((error as Error).message).toMatch(message);
}

describe("closure dynamic evidence", () => {
  it.each([false, true])("preserves the existing retained allocation footprint (fast=%s)", (fast) => {
    const baseline = fixture({ fast, nativeStrings: true });
    baseline.registry.prepareDynamicCarrier(resolveIrDynamicCarrierType(baseline.ctx));
    const repaired = fixture({ fast, nativeStrings: true });
    repaired.registry.prepareClosureDynamicCarriers([
      repaired.demand(),
      repaired.demand(1),
      repaired.demand(1, tagged),
    ]);
    expect(state(repaired)).toEqual(state(baseline));
    expect(repaired.session.publication).toBeUndefined();
  });

  it("keeps all terminal proofs when a later preparation shares the same payload", () => {
    const f = fixture();
    const first = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    const second = f.registry.prepareClosureDynamicCarriers([f.demand(1)]);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic)).toMatchObject({ kind: "ref_null" });
    rejected(() => f.registry.resolveClosureDynamicCarrier(dynamic, first), /evidence population/);
    rejected(() => f.registry.resolveClosureDynamicCarrier(dynamic, second), /evidence population/);
    expect(f.registry.resolveClosureDynamicCarrier(dynamic, [...first, ...second])).toMatchObject({ kind: "ref_null" });
  });

  it("requires the private authentication record even for an original evidence object", () => {
    const f = fixture();
    const [proof] = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic)).toMatchObject({ kind: "ref_null" });
    const records = f.registry as unknown as { closureDynamicProofs: WeakMap<object, unknown> };
    expect(records.closureDynamicProofs.delete(proof!)).toBe(true);
    rejected(() => lowerPreparedClosureSupportType(f.ctx, dynamic), /exact type plan/);
  });

  it.each([false, true])(
    "authenticates sequential receipts and all current peers through an overlay (fast=%s)",
    (fast) => {
      const f = fixture({ fast, nativeStrings: fast });
      const first = f.registry.prepareClosureDynamicCarriers([f.demand()]);
      const carrier = f.registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, first);
      const second = f.registry.prepareClosureDynamicCarriers([f.demand(1)]);
      // Preserve the strict old API: a partial peer population is still invalid.
      rejected(() => f.registry.resolveClosureDynamicCarrier(dynamic, second), /evidence population/);
      const cellType = f.mod.types[getOrRegisterRefCellType(f.ctx, carrier)] as StructTypeDef;
      const [cell] = f.registry.prepareRefCellSupportTypes([{ innerType: dynamic, cellType }], true);
      const cellId = cell!.cellTypeRef.binding.bindingId;
      const scope = f.session.beginPreparedComponentScope("sequential-dynamic", f.terminals.slice(0, 2));
      scope.stagePreparedComponentBatch({
        scopeId: "sequential-dynamic",
        terminalUnitIds: f.terminals.slice(0, 2),
        requestedStructuralReferenceKeys: [],
        supportTypes: describePreparedSupportTypes(f.ctx, f.terminals.slice(0, 2), [cellId]),
      });
      expect(scope.abi.get(cellId)).toBeDefined();
      expect(f.session.hasPlan(cellId)).toBe(false);
      const before = state(f);
      for (const originals of [first, second]) {
        expect(f.registry.resolveClosureDynamicCarrier(dynamic, undefined, scope.abi, originals)).toEqual(carrier);
      }
      rejected(
        () =>
          f.registry.resolveClosureDynamicCarrier(dynamic, undefined, { ...scope.abi, get: () => undefined }, second),
        /exact type plan/,
      );
      expect(state(f)).toEqual(before);
      if (carrier.kind === "ref_null") {
        const previousTypes = f.mod.types;
        const nextTypes = [...previousTypes].reverse();
        f.session.applyTypeLayoutRemap({
          previousTypes,
          nextTypes,
          targetsByOldIndex: previousTypes.map((_, index) => previousTypes.length - 1 - index),
        });
        f.mod.types = nextTypes;
        for (const originals of [first, second]) {
          expect(f.registry.resolveClosureDynamicCarrier(dynamic, undefined, scope.abi, originals)).toEqual({
            kind: "ref_null",
            typeIdx: previousTypes.length - 1 - carrier.typeIdx,
          });
        }
      }
      scope.abort();
      expect(f.session.hasPlan(cellId)).toBe(false);
    },
  );

  it.each([
    "earlier-peer",
    "current-receipt",
    "renewed-original",
    "copied-original",
    "foreign-original",
    "removed-peer",
  ] as const)("refuses sequential preparation with invalid %s without minting replacement evidence", (mutation) => {
    const f = fixture();
    const first = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    const second = f.registry.prepareClosureDynamicCarriers([f.demand(1)]);
    let originals = mutation === "renewed-original" ? first : second;
    for (const receipts of [first, second]) {
      expect(f.registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, receipts)).toMatchObject({
        kind: "ref_null",
      });
    }
    const records = f.registry as unknown as {
      closureDynamicProofs: WeakMap<object, unknown>;
      closureDynamicEvidence: Map<string, ClosureDynamicCarrierEvidence>;
    };
    if (mutation === "renewed-original") {
      const renewed = f.registry.prepareClosureDynamicCarriers([f.demand()]);
      expect(renewed[0]).not.toBe(first[0]);
      expect(f.registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, first)).toMatchObject({
        kind: "ref_null",
      });
      expect(records.closureDynamicProofs.delete(first[0]!)).toBe(true);
      // Default peers alone would hide this invalidated original receipt.
      expect(f.registry.resolveClosureDynamicCarrier(dynamic)).toMatchObject({ kind: "ref_null" });
    } else if (mutation === "copied-original") {
      originals = second.map((proof) => Object.freeze({ ...proof }));
    } else if (mutation === "foreign-original") {
      const foreign = fixture();
      originals = foreign.registry.prepareClosureDynamicCarriers([foreign.demand(1)]);
    } else if (mutation === "removed-peer") {
      originals = first;
      expect(
        records.closureDynamicEvidence.delete(JSON.stringify([first[0]!.terminalUnitId, first[0]!.logicalTypeKey])),
      ).toBe(true);
      expect(f.registry.resolveClosureDynamicCarrier(dynamic)).toMatchObject({ kind: "ref_null" });
    } else {
      expect(records.closureDynamicProofs.delete((mutation === "earlier-peer" ? first : second)[0]!)).toBe(true);
    }
    const before = state(f);
    const peersBefore = [...records.closureDynamicEvidence];
    const recordsBefore = [...first, ...second].map((proof) => records.closureDynamicProofs.get(proof));
    rejected(
      () => f.registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, originals),
      /exact type plan|evidence population/,
    );
    expect(state(f)).toEqual(before);
    expect(records.closureDynamicEvidence.size).toBe(peersBefore.length);
    for (const [key, peer] of peersBefore) expect(records.closureDynamicEvidence.get(key)).toBe(peer);
    [...first, ...second].forEach((proof, index) => {
      expect(records.closureDynamicProofs.get(proof)).toBe(recordsBefore[index]);
    });
  });

  it.each(["shape", "slot-policy"] as const)("refuses a changed externref %s plan", (mutation) => {
    const f = fixture({ fast: false });
    const [proof] = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic)).toEqual({ kind: "externref" });
    const get = f.session.getDraft.bind(f.session);
    vi.spyOn(f.session, "getDraft").mockImplementation((id) => {
      const draft = get(id);
      if (id !== proof!.carrier.carrierTypeRef.binding.bindingId || !draft) return draft;
      return mutation === "shape"
        ? { ...draft, intent: { kind: "type", shapeKey: '{"kind":"f64"}' } }
        : { ...draft, slotPolicy: "required", slotSpace: "type" };
    });
    const before = state(f);
    rejected(() => lowerPreparedClosureSupportType(f.ctx, dynamic), /exact type plan|slotless plan/);
    expect(state(f)).toEqual(before);
  });
  it.each(
    [false, true].flatMap((fast) =>
      [false, true].flatMap((nativeStrings) =>
        [false, true].map((standalone) => ({ fast, nativeStrings, standalone })),
      ),
    ),
  )("uses the actual fast policy %j without per-terminal allocation", (options) => {
    const f = fixture(options);
    const before = state(f);
    const proofs = f.registry.prepareClosureDynamicCarriers([f.demand(), f.demand(1), f.demand(1, tagged)]);
    expect(proofs).toHaveLength(3);
    for (const proof of proofs) {
      expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.carrier)).toBe(true);
      expect(proof.carrier.kind).toBe(options.fast ? "reference" : "externref");
      if (proof.carrier.kind === "reference") expect(proof.carrier.nullable).toBe(true);
    }
    expect(new Set(proofs.map((proof) => proof.carrier.carrierTypeRef)).size).toBe(1);
    const actual = lowerPreparedClosureSupportType(f.ctx, dynamic);
    expect(actual).toEqual(resolveIrDynamicCarrierType(f.ctx));
    expect(lowerPreparedClosureSupportType(f.ctx, tagged)).toEqual(actual);
    const after = state(f);
    expect(after.drafts.length - before.drafts.length).toBe(1);
    expect(after.types.length - before.types.length).toBe(options.fast ? 1 : 0);
    expect(after.globals.length - before.globals.length).toBe(
      options.fast && (options.nativeStrings || options.standalone) ? 1 : 0,
    );
    expect(after.pending).toEqual(before.pending);
    expect(after.candidates).toEqual(before.candidates);
    f.registry.prepareClosureDynamicCarriers([f.demand(), f.demand(1)]);
    expect(state(f)).toEqual(after);
  });

  it("does no work for an empty demand population", () => {
    const f = fixture();
    const before = state(f);
    expect(f.registry.prepareClosureDynamicCarriers([])).toEqual([]);
    expect(state(f)).toEqual(before);
    rejected(() => lowerPreparedClosureSupportType(f.ctx, dynamic), /evidence population/);
    expect(state(f)).toEqual(before);
  });

  it("collects every terminal and nested type independently of names or box instructions", () => {
    const f = fixture();
    const nested: IrType = {
      kind: "object",
      shape: {
        fields: [
          { name: "boxed", type: { kind: "boxed", inner: dynamic } },
          { name: "vector", type: { kind: "vec", elementType: tagged, nullable: true } },
          { name: "union", type: { kind: "union", members: [dynamic, tagged] } },
          { name: "closure", type: { kind: "closure", signature: { params: [dynamic], returnType: tagged } } },
          { name: "callable", type: { kind: "callable", signature: { params: [tagged], returnType: dynamic } } },
        ],
      },
    };
    const entries = [f.entry(nested), f.entry(nested, 1)];
    const demands = collectClosureDynamicCarrierDemands(entries);
    expect(demands).toEqual([f.demand(), f.demand(0, tagged), f.demand(1), f.demand(1, tagged)]);
    expect(demands.every(Object.isFrozen)).toBe(true);
    f.registry.prepareClosureDynamicCarriers(demands);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic)).toMatchObject({ kind: "ref_null" });
  });

  it("collects capture/signature/result-only demands and terminates nominal recursion", () => {
    const f = fixture();
    const entry = f.entry({ kind: "val", val: { kind: "i32" } });
    const nominal: IrType = {
      kind: "class",
      shape: { classId: "nominal" as never, className: "Node", fields: [], methods: [], constructorParams: [tagged] },
    };
    (nominal.shape.fields as { name: string; type: IrType }[]).push(
      { name: "self", type: nominal },
      { name: "payload", type: dynamic },
    );
    const fn: IrFunction = {
      ...entry.fn,
      params: [],
      resultTypes: [nominal],
      closureSubtype: { signature: { params: [dynamic], returnType: tagged }, captureFieldTypes: [tagged] },
    };
    expect(collectClosureDynamicCarrierDemands([{ ...entry, fn }])).toEqual([f.demand(), f.demand(0, tagged)]);
  });

  it.each(["copy", "foreign-session", "wrong-terminal", "wrong-key", "missing-peer", "duplicate-peer"] as const)(
    "actual lowering refuses %s evidence after a valid allocation",
    (mutation) => {
      const f = fixture();
      const proofs = f.registry.prepareClosureDynamicCarriers([f.demand(), f.demand(1)]);
      const signature = { params: [dynamic], returnType: dynamic };
      const positive = new ClosureStructRegistry(f.ctx, (type) => lowerPreparedClosureSupportType(f.ctx, type));
      expect(positive.resolveBase(signature)).not.toBeNull();
      let corrupted: readonly ClosureDynamicCarrierEvidence[];
      switch (mutation) {
        case "copy":
          corrupted = [{ ...proofs[0]! }, proofs[1]!];
          break;
        case "foreign-session": {
          const foreign = fixture();
          corrupted = [foreign.registry.prepareClosureDynamicCarriers([foreign.demand()])[0]!, proofs[1]!];
          break;
        }
        case "wrong-terminal":
          corrupted = [{ ...proofs[0]!, terminalUnitId: "foreign" as IrUnitId }, proofs[1]!];
          break;
        case "wrong-key":
          corrupted = [{ ...proofs[0]!, logicalTypeKey: canonicalProgramAbiRefCellKey(tagged) }, proofs[1]!];
          break;
        case "missing-peer":
          corrupted = [proofs[0]!];
          break;
        case "duplicate-peer":
          corrupted = [proofs[0]!, proofs[0]!];
          break;
      }
      const consume = f.registry.resolveClosureDynamicCarrier.bind(f.registry);
      const spy = vi
        .spyOn(f.registry, "resolveClosureDynamicCarrier")
        .mockImplementation((type) => consume(type, corrupted));
      const before = state(f);
      rejected(() => lowerPreparedClosureSupportType(f.ctx, dynamic), /evidence population/);
      const negative = new ClosureStructRegistry(f.ctx, (type) => lowerPreparedClosureSupportType(f.ctx, type));
      expect(negative.resolveBase(signature)).toBeNull();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(state(f)).toEqual(before);
    },
  );

  it.each([0, 1, 2])("reauthenticates peer %s across three same-context preparations", (invalidated) => {
    const ast = analyzeSource(
      "export function first(): number { return 1; } export function second(): number { return 2; } export function third(): number { return 3; }",
      "/repo/three-dynamic-peers.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
    const mod = createEmptyModule();
    const session = new ProgramAbiSession(inventory, mod);
    const ctx = createCodegenContext(
      mod,
      ast.checker,
      { fast: true },
      session,
      buildIrPlanningIdentityContext(inventory),
    );
    const registry = ctx.programAbiTypes!;
    const units = inventory.terminalUnits.filter((unit) => unit.kind === "top-level-function");
    expect(units).toHaveLength(3);
    const receipts = units.map((unit) =>
      registry.prepareClosureDynamicCarriers([
        {
          terminalUnitId: unit.id,
          logicalTypeKey: canonicalProgramAbiRefCellKey(dynamic),
          role: "closure-dynamic-payload",
        },
      ]),
    );
    const expected = registry.resolveClosureDynamicCarrier(dynamic);
    for (const originals of receipts) {
      expect(registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, originals)).toEqual(expected);
    }
    const records = registry as unknown as { closureDynamicProofs: WeakMap<object, unknown> };
    expect(records.closureDynamicProofs.delete(receipts[invalidated]![0]!)).toBe(true);
    for (const originals of receipts) {
      rejected(
        () => registry.resolveClosureDynamicCarrier(dynamic, undefined, undefined, originals),
        /exact type plan/,
      );
    }
  });

  it.each(["foreign-registry", "replaced-module", "replaced-session"] as const)("rejects %s", (mutation) => {
    const f = fixture();
    f.registry.prepareClosureDynamicCarriers([f.demand()]);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic)).toMatchObject({ kind: "ref_null" });
    const foreign = fixture();
    foreign.registry.prepareClosureDynamicCarriers([foreign.demand()]);
    if (mutation === "replaced-module") f.ctx.mod = foreign.mod;
    if (mutation === "replaced-session") f.ctx.programAbiSession = foreign.session;
    rejected(
      () =>
        lowerPreparedClosureSupportType(
          f.ctx,
          dynamic,
          undefined,
          undefined,
          mutation === "foreign-registry" ? foreign.registry : f.registry,
        ),
      /owning registry|different WasmModule|authenticated registry evidence/,
    );
  });

  it.each(["shape", "removed", "lost-cell"] as const)(
    "rejects a %s carrier mutation without allocation",
    (mutation) => {
      const f = fixture();
      const [proof] = f.registry.prepareClosureDynamicCarriers([f.demand()]);
      const physical = lowerPreparedClosureSupportType(f.ctx, dynamic);
      expect(physical.kind).toBe("ref_null");
      if (physical.kind !== "ref_null") throw new Error("expected physical carrier");
      const type = f.mod.types[physical.typeIdx] as StructTypeDef;
      if (mutation === "shape") type.fields[0]!.mutable = !type.fields[0]!.mutable;
      if (mutation === "removed") f.mod.types.splice(physical.typeIdx, 1);
      if (mutation === "lost-cell") f.session.remapTypeCell(f.session.typeCellFor(type)!, null);
      const before = state(f);
      expect(() => f.registry.resolveClosureDynamicCarrier(dynamic, [proof!])).toThrow();
      expect(state(f)).toEqual(before);
    },
  );

  it("rechecks authenticated evidence after a complete type layout remap", () => {
    const f = fixture();
    const [proof] = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    const first = lowerPreparedClosureSupportType(f.ctx, dynamic);
    if (first.kind !== "ref_null") throw new Error("expected reference");
    f.mod.types.push({ kind: "struct", name: "later", fields: [] });
    const previous = f.mod.types;
    const next = [...previous].reverse();
    f.session.applyTypeLayoutRemap({
      previousTypes: previous,
      nextTypes: next,
      targetsByOldIndex: previous.map((_, index) => previous.length - 1 - index),
    });
    f.mod.types = next;
    expect(f.registry.resolveClosureDynamicCarrier(dynamic, [proof!])).toEqual({
      kind: "ref_null",
      typeIdx: previous.length - 1 - first.typeIdx,
    });
    const shape = next[previous.length - 1 - first.typeIdx] as StructTypeDef;
    shape.fields[0]!.mutable = !shape.fields[0]!.mutable;
    rejected(() => lowerPreparedClosureSupportType(f.ctx, dynamic), /changed shape/);
  });

  it.each([false, true])("uses the actual open-scope lookup (fast=%s) without live fallback", (fast) => {
    const f = fixture({ fast, nativeStrings: fast });
    const [proof] = f.registry.prepareClosureDynamicCarriers([f.demand()]);
    const scope = f.session.beginPreparedComponentScope("dynamic-evidence", [f.terminals[0]!]);
    const carrier = lowerPreparedClosureSupportType(f.ctx, dynamic);
    const cellType = f.mod.types[getOrRegisterRefCellType(f.ctx, carrier)] as StructTypeDef;
    const [cellSupport] = f.registry.prepareRefCellSupportTypes([{ innerType: dynamic, cellType }], true);
    const cellId = cellSupport!.cellTypeRef.binding.bindingId;
    expect(f.session.hasPlan(cellId)).toBe(false);
    scope.stagePreparedComponentBatch({
      scopeId: "dynamic-evidence",
      terminalUnitIds: [f.terminals[0]!],
      requestedStructuralReferenceKeys: [],
      supportTypes: describePreparedSupportTypes(f.ctx, [f.terminals[0]!], [cellId]),
    });
    expect(scope.abi.get(cellId)).toBeDefined();
    expect(f.session.hasPlan(cellId)).toBe(false);
    const expected = lowerPreparedClosureSupportType(f.ctx, dynamic);
    expect(lowerPreparedClosureSupportType(f.ctx, dynamic, undefined, undefined, f.registry, scope.abi)).toEqual(
      expected,
    );
    const missing = { ...scope.abi, get: () => undefined };
    rejected(
      () => lowerPreparedClosureSupportType(f.ctx, dynamic, undefined, undefined, f.registry, missing),
      /exact type plan/,
    );
    expect(f.session.hasPlan(proof!.carrier.carrierTypeRef.binding.bindingId)).toBe(true);
    scope.abort();
    expect(f.session.hasPlan(cellId)).toBe(false);
  });

  it("rejects malformed and duplicate demands before any retained allocation", () => {
    const f = fixture();
    for (const demands of [
      [f.demand(), f.demand()],
      [{ ...f.demand(), terminalUnitId: "foreign" as IrUnitId }],
      [{ ...f.demand(), logicalTypeKey: "invalid-json" }],
      [{ ...f.demand(), logicalTypeKey: '{"kind":"string"}' }],
    ]) {
      const before = state(f);
      rejected(() => f.registry.prepareClosureDynamicCarriers(demands), /demand/);
      expect(state(f)).toEqual(before);
    }
    f.registry.prepareClosureDynamicCarriers([f.demand()]);
    f.registry.planRetained();
    const sealed = state(f);
    rejected(() => f.registry.prepareClosureDynamicCarriers([f.demand()]), /after planning/);
    expect(state(f)).toEqual(sealed);
  });

  it("derived callable allocation consumes the prepared dynamic evidence", () => {
    const f = fixture({ fast: false });
    const entry = f.entry();
    const demands = collectClosureDynamicCarrierDemands([entry]);
    f.registry.prepareClosureDynamicCarriers(demands);
    const registry = new ClosureStructRegistry(f.ctx, (type) => lowerPreparedClosureSupportType(f.ctx, type));
    const cells = { resolveIr: () => null };
    const index = prepareDerivedCallableTypeIdx(f.ctx, registry, entry.fn, cells);
    expect(f.mod.types[index]).toMatchObject({
      kind: "func",
      params: [{ kind: "externref" }],
      results: [{ kind: "externref" }],
    });
    const consume = f.registry.resolveClosureDynamicCarrier.bind(f.registry);
    vi.spyOn(f.registry, "resolveClosureDynamicCarrier").mockImplementation((type) => consume(type, []));
    const before = state(f);
    rejected(() => prepareDerivedCallableTypeIdx(f.ctx, registry, entry.fn, cells), /evidence population/);
    expect(state(f)).toEqual(before);
  });

  it("real integration prepares demands before the first consumer and keeps runtime values", async () => {
    let prepared = 0;
    let consumed = 0;
    const prepare = ProgramAbiTypeRegistry.prototype.prepareClosureDynamicCarriers;
    const consume = ProgramAbiTypeRegistry.prototype.resolveClosureDynamicCarrier;
    vi.spyOn(ProgramAbiTypeRegistry.prototype, "prepareClosureDynamicCarriers").mockImplementation(function (
      this: ProgramAbiTypeRegistry,
      demands,
    ) {
      const evidence = prepare.call(this, demands);
      prepared += evidence.length;
      return evidence;
    });
    vi.spyOn(ProgramAbiTypeRegistry.prototype, "resolveClosureDynamicCarrier").mockImplementation(function (
      this: ProgramAbiTypeRegistry,
      ...args
    ) {
      expect(prepared).toBeGreaterThan(0);
      consumed++;
      return consume.apply(this, args);
    });
    const result = await compile(
      `export function run(): number {
      let value: number | undefined;
      const read = (): number => value === undefined ? 1 : 2;
      const before = read(); value = 42; return before * 10 + read();
    }`,
      { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(prepared).toBeGreaterThan(0);
    expect(consumed).toBeGreaterThan(0);
    const module = new WebAssembly.Module(result.binary!);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect((new WebAssembly.Instance(module, {}).exports.run as () => number)()).toBe(12);
  });

  it.each(["all", "last"] as const)(
    "refuses %s late-invalidated proofs for cached mutable captures",
    async (mutation) => {
      const source = `export function run(): number {
      let value: number | undefined;
      const read = (): number => value === undefined ? 1 : 2;
      const before = read(); value = 42; return before * 10 + read();
    }`;
      const prepare = ProgramAbiTypeRegistry.prototype.prepareClosureDynamicCarriers;
      const consume = ProgramAbiTypeRegistry.prototype.resolveClosureDynamicCarrier;
      const begin = ProgramAbiSession.prototype.beginPreparedComponentScope;
      const resolveSubtype = ClosureStructRegistry.prototype.resolveSubtype;
      let invalidate = false;
      let deleted = 0;
      let lateCalls = 0;
      let refusals = 0;
      const prepared = new Map<
        ProgramAbiSession,
        { registry: ProgramAbiTypeRegistry; evidence: readonly ClosureDynamicCarrierEvidence[] }
      >();
      const scoped = new Set<ProgramAbiSession>();
      const aborted = new Set<ProgramAbiSession>();
      const cachedNestedContexts = new Set<ProgramAbiTypeRegistry["ctx"]>();
      vi.spyOn(ClosureStructRegistry.prototype, "resolveSubtype").mockImplementation(function (
        this: ClosureStructRegistry,
        ...args
      ) {
        const result = resolveSubtype.apply(this, args);
        if (result && args[1].some((type) => type.kind === "boxed" && type.inner.kind === "dynamic")) {
          const actual = this as unknown as { ctx: ProgramAbiTypeRegistry["ctx"]; subCache: Map<string, unknown> };
          expect(actual.subCache.size).toBeGreaterThan(0);
          cachedNestedContexts.add(actual.ctx);
        }
        return result;
      });
      vi.spyOn(ProgramAbiTypeRegistry.prototype, "prepareClosureDynamicCarriers").mockImplementation(function (
        this: ProgramAbiTypeRegistry,
        demands,
      ) {
        const evidence = prepare.call(this, demands);
        if (evidence.length) prepared.set(this.session, { registry: this, evidence });
        return evidence;
      });
      vi.spyOn(ProgramAbiSession.prototype, "beginPreparedComponentScope").mockImplementation(function (
        this: ProgramAbiSession,
        ...args
      ) {
        const scope = begin.apply(this, args);
        const abort = scope.abort.bind(scope);
        vi.spyOn(scope, "abort").mockImplementation(() => {
          abort();
          aborted.add(this);
        });
        const entry = prepared.get(this);
        if (entry && !scoped.has(this)) {
          expect(entry.evidence.length).toBeGreaterThanOrEqual(2);
          expect(cachedNestedContexts.has(entry.registry.ctx)).toBe(true);
          // Both proofs came from this actual compile and already built its layouts.
          for (const proof of entry.evidence)
            consume.call(entry.registry, JSON.parse(proof.logicalTypeKey), entry.evidence);
          scoped.add(this);
          if (invalidate) {
            const records = entry.registry as unknown as { closureDynamicProofs: WeakMap<object, unknown> };
            for (const proof of mutation === "all" ? entry.evidence : entry.evidence.slice(-1)) {
              expect(records.closureDynamicProofs.delete(proof)).toBe(true);
              deleted++;
            }
          }
        }
        return scope;
      });
      vi.spyOn(ProgramAbiTypeRegistry.prototype, "resolveClosureDynamicCarrier").mockImplementation(function (
        this: ProgramAbiTypeRegistry,
        ...args
      ) {
        if (scoped.has(this.session)) {
          lateCalls++;
          expect(args[1]).toBeUndefined();
          expect(args[3]).toBe(prepared.get(this.session)!.evidence);
          // A successfully staged component must use its overlay. An already
          // withdrawn component has no open overlay and uses the exact session.
        }
        try {
          return consume.apply(this, args);
        } catch (error) {
          expect(scoped.has(this.session)).toBe(true);
          expect(error).toBeInstanceOf(ProgramAbiInvariantError);
          expect((error as Error).message).toMatch(/closure dynamic evidence lost its exact type plan/);
          refusals++;
          throw error;
        }
      });
      const options = { target: "standalone" as const, experimentalIR: true, trackIrOutcomes: true };
      const positive = await compile(source, options);
      expect(positive.success, JSON.stringify(positive.errors)).toBe(true);
      expect(
        (new WebAssembly.Instance(new WebAssembly.Module(positive.binary!), {}).exports.run as () => number)(),
      ).toBe(12);
      expect(scoped.size).toBeGreaterThan(0);
      const positiveLateCalls = lateCalls;
      expect(refusals).toBe(0);
      invalidate = true;
      lateCalls = 0;
      const refused = await compile(source, options);
      expect(deleted).toBeGreaterThanOrEqual(mutation === "all" ? 2 : 1);
      // This fixture already withdraws its prepared component. Legitimate
      // fallback remains allowed, but cannot hide a missing late proof check.
      expect(refusals).toBeGreaterThan(0);
      expect(refused.success, JSON.stringify(refused.errors)).toBe(true);
      expect(
        (new WebAssembly.Instance(new WebAssembly.Module(refused.binary!), {}).exports.run as () => number)(),
      ).toBe(12);
      expect(positiveLateCalls).toBeGreaterThan(0);
      expect(lateCalls).toBeGreaterThan(0);
      for (const session of prepared.keys()) {
        expect(aborted.has(session)).toBe(true);
        expect((session as unknown as { openPreparedScopeIds: Set<string> }).openPreparedScopeIds.size).toBe(0);
      }
    },
  );

  it.each([false, true])("initializes the reviewed backend cycle in either import order (reverse=%s)", (reverse) => {
    const root = resolve(import.meta.dirname, "..");
    const paths = ["./src/codegen/any-helpers.ts", "./src/codegen/program-abi-type-planning.ts"];
    if (reverse) paths.reverse();
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `for (const path of ${JSON.stringify(paths)}) await import(path); console.log("initialized");`,
      ],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("initialized");
    expect(readFileSync(resolve(root, "src/ir/prepared-closure-support.ts"), "utf8")).not.toContain(
      'from "../codegen/any-helpers.js"',
    );
  });
});
