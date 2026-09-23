// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/frontend/typescript.js";
import { buildIrUnitInventory, type IrSourceId, type IrUnitId } from "../src/ir/identity.js";
import { asBlockId, asValueId, irVal, type IrInstrCall } from "../src/ir/nodes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  prepareDependencyCompletePreparedComponents,
  type PreparedComponentArtifactEntry,
} from "../src/ir/prepared-component-sealing.js";
import { irRuntimeFuncRef, irCallableBindingKey, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import {
  IR_UNDEFINED_VALUE_FN,
  irUndefinedValueDemand,
  type IrUndefinedValueDemand,
} from "../src/ir/undefined-value-provider.js";
import { createEmptyModule, type FuncTypeDef, type WasmFunction } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { PreparedComponentDependencyEvidence } from "../src/ir/prepared-component-dependencies.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../src/codegen/program-abi-planning.js";
import { catalogProgramAbiCallableImports } from "../src/codegen/program-abi-import-planning.js";
import { prepareCallableProviderDescriptorForScope } from "../src/codegen/program-abi-provider-planning.js";
import { ensureAnyValueType } from "../src/codegen/any-helpers.js";
import { ensureLateImport, flushLateImportShifts } from "../src/codegen/shared.js";
import { addFuncType } from "../src/codegen/registry/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(native = true, observeSourceCallables = false) {
  const source = ts.createSourceFile(
    "/repo/undefined-demand.ts",
    "function first() {} function second() {}",
    ts.ScriptTarget.Latest,
    true,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const terminals = inventory.terminalUnits.filter((unit) => unit.kind === "top-level-function");
  expect(terminals).toHaveLength(2);
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(
    mod,
    {} as ts.TypeChecker,
    { target: native ? "standalone" : "gc" },
    session,
    observeSourceCallables ? buildIrPlanningIdentityContext(inventory) : undefined,
  );
  const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
  mod.types.push(signature);
  for (const terminal of terminals) {
    const func: WasmFunction = {
      name: terminal.displayName,
      typeIdx: mod.types.indexOf(signature),
      locals: [],
      body: [],
      exported: false,
    };
    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, func);
    if (observeSourceCallables) {
      const declaration = source.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === terminal.displayName,
      )!;
      expect(ctx.programAbiSourceCallables!.observe(declaration, handle)).toBe(terminal.id);
    }
    planProgramAbiUnitCallable(ctx, { ref: irUnitFuncRef({ unitId: terminal.id, name: func.name }), signature, func });
  }
  const instruction: IrInstrCall = {
    kind: "call",
    target: irRuntimeFuncRef(IR_UNDEFINED_VALUE_FN),
    args: [],
    result: asValueId(0),
    resultType: irVal({ kind: "externref" }),
  };
  const demands = terminals.map((unit) => irUndefinedValueDemand(unit.sourceId, unit.id, instruction));
  const registry = ctx.programAbiCallableProviders!;
  const key = irCallableBindingKey(instruction.target.binding);
  const reserve = () => registry.prepareUndefinedValueDemands(demands);
  const provider = () => definedFuncAt(ctx, ctx.funcMap.get(IR_UNDEFINED_VALUE_FN)!)!;
  return { ctx, mod, session, terminals, instruction, demands, registry, key, reserve, provider };
}

function publication(f: ReturnType<typeof fixture>) {
  const state = f.session as unknown as Record<string, Map<unknown, unknown>>;
  return [
    "drafts",
    "draftOrderOwners",
    "locators",
    "locatorOwners",
    "structuralReferenceKeys",
    "callableTypeContracts",
  ].map((key) => [key, [...state[key]!.entries()]]);
}

function componentPublication(f: ReturnType<typeof fixture>) {
  const state = f.session as unknown as Record<string, Map<unknown, unknown>>;
  return ["preparedScopes", "preparedScopeByUnitId", "preparedScopeByClassId", "preparedScopeIdsByBindingId"].map(
    (key) => [key, [...state[key]!.entries()].map(([id, value]) => [id, value instanceof Set ? [...value] : value])],
  );
}

/** Nash's actual candidate/sealing path: do not substitute manual descriptor staging. */
function componentFixture(native: boolean) {
  const f = fixture(native, true);
  f.reserve();
  catalogProgramAbiCallableImports(f.ctx);
  const entries: PreparedComponentArtifactEntry[] = f.terminals.map((unit) => ({
    artifactUnitId: unit.id,
    terminalOwnerUnitId: unit.id,
    fn: {
      unitId: unit.id,
      name: unit.displayName,
      params: [],
      resultTypes: [],
      exported: false,
      valueCount: 1,
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [f.instruction],
          terminator: { kind: "return", values: [] },
        },
      ],
    },
  }));
  const prepare = (index: number) => {
    const result = prepareDependencyCompletePreparedComponents({
      ctx: f.ctx,
      entries: [entries[index]!],
      inventory: f.session.inventory,
      callableImports: new Map(),
      deferPublication: true,
      onSealFailure: (_id, error) => {
        throw error;
      },
    });
    expect(result.openScopes).toHaveLength(1);
    expect([...result.componentIds.keys()]).toEqual([f.terminals[index]!.id]);
    return result.openScopes[0]!.scope;
  };
  return { ...f, entries, prepare };
}

it.each([true, false])(
  "seals actual complete-component reuse without allocating or publishing another provider (native=%s)",
  (native) => {
    const f = componentFixture(native);
    const first = f.prepare(0).seal();
    const [id] = f.session.bindingIdsForStructuralReference(f.key);
    expect(id).toBeDefined();
    expect(first.bindingIds).toContain(id);
    const before = publication(f);
    const func = f.provider();
    const counts = [f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length];
    const second = f.prepare(1);
    expect(publication(f)).toEqual(before);
    const pending = second.prepareSeal();
    expect(publication(f)).toEqual(before);
    expect(f.session.commitPreparedScopes([pending])[0]!.bindingIds).toContain(id);
    expect(publication(f)).toEqual(before);
    expect(f.provider()).toBe(func);
    expect([f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length]).toEqual(counts);
  },
);

const reuseMutations = [
  { native: true, mutation: "body", message: "body no longer" },
  { native: true, mutation: "global", message: "singleton identity" },
  { native: true, mutation: "type", message: "singleton identity" },
  { native: false, mutation: "body", message: "body no longer" },
  { native: false, mutation: "import", message: "must appear exactly once in the current population" },
  { native: false, mutation: "ABI", message: "changed its exact function type object" },
] as const;

it.each(reuseMutations.flatMap((test) => [false, true].map((afterPrepareSeal) => ({ ...test, afterPrepareSeal }))))(
  "rejects $mutation after actual reused-provider preparation (native=$native, pending=$afterPrepareSeal), retaining the first peer",
  ({ native, mutation, message, afterPrepareSeal }) => {
    const f = componentFixture(native);
    const first = f.prepare(0).seal();
    const [id] = f.session.bindingIdsForStructuralReference(f.key);
    expect(first.bindingIds).toContain(id);
    const firstDraft = f.session.getDraft(id!);
    const before = publication(f);
    const scopesBefore = componentPublication(f);
    const func = f.provider();
    const describe = vi.spyOn(f.registry, "describePrepared");
    const second = f.prepare(1);
    const pending = afterPrepareSeal ? second.prepareSeal() : undefined;
    const body = func.body;
    const globalIndex = f.ctx.undefinedGlobalIdx! - f.ctx.numImportGlobals;
    const global = f.mod.globals[globalIndex];
    const type = f.mod.types[f.ctx.anyValueTypeIdx];
    const imported = f.mod.imports[0];
    const signature = f.mod.types[func.typeIdx]!;
    if (mutation === "body") func.body = [{ op: "ref.null.extern" }];
    if (mutation === "global") f.mod.globals[globalIndex] = { ...global! };
    if (mutation === "type") f.mod.types[f.ctx.anyValueTypeIdx] = { ...type! };
    if (mutation === "import") f.mod.imports[0] = { ...imported! };
    if (mutation === "ABI") f.mod.types[func.typeIdx] = { kind: "func", params: [], results: [{ kind: "i32" }] };
    expect(() => (pending ? f.session.commitPreparedScopes([pending]) : second.seal())).toThrow(message);
    expect(publication(f)).toEqual(before);
    expect(componentPublication(f)).toEqual(scopesBefore);
    expect(f.session.getDraft(id!)).toBe(firstDraft);
    expect(f.session.locatorObjectForBinding(id!)).toBe(func);
    expect(describe).toHaveBeenCalledTimes(1);
    const descriptor = describe.mock.results[0]!.value;
    expect(() => prepareCallableProviderDescriptorForScope(descriptor, f.session, "replay")).toThrow("not fresh");
    func.body = body;
    if (global) f.mod.globals[globalIndex] = global;
    if (type) f.mod.types[f.ctx.anyValueTypeIdx] = type;
    if (imported) f.mod.imports[0] = imported;
    f.mod.types[func.typeIdx] = signature;
    const retry = f.prepare(1);
    expect(retry.seal().bindingIds).toContain(id);
    expect(publication(f)).toEqual(before);
    expect(f.provider()).toBe(func);
  },
);

it.each([true, false])("retains reuse authentication alongside another unresolved provider (native=%s)", (native) => {
  const f = componentFixture(native);
  const first = f.prepare(0).seal();
  const [id] = f.session.bindingIdsForStructuralReference(f.key);
  expect(first.bindingIds).toContain(id);
  const ref = irRuntimeFuncRef("__test_second_component_provider");
  const extraKey = irCallableBindingKey(ref.binding);
  const handle = mintDefinedFunc(f.ctx);
  pushDefinedFunc(f.ctx, handle, {
    name: ref.name,
    typeIdx: addFuncType(f.ctx, [], []),
    locals: [],
    body: [],
    exported: false,
  });
  f.registry.observe(ref, handle);
  f.entries[1]!.fn.blocks[0]!.instrs.push({ ...f.instruction, target: ref, result: null, resultType: null });
  const before = publication(f);
  const scopesBefore = componentPublication(f);
  const describe = vi.spyOn(f.registry, "describePrepared");
  const second = f.prepare(1);
  expect(describe).toHaveBeenCalledTimes(1);
  expect([...describe.mock.calls[0]![0]].sort()).toEqual([f.key, extraKey].sort());
  const func = f.provider();
  const body = func.body;
  func.body = [{ op: "ref.null.extern" }];
  expect(() => second.seal()).toThrow("body no longer");
  expect(publication(f)).toEqual(before);
  expect(componentPublication(f)).toEqual(scopesBefore);
  expect(f.session.bindingIdsForStructuralReference(extraKey)).toEqual([]);
  expect(f.session.locatorObjectForBinding(id!)).toBe(func);
  func.body = body;
  expect(f.prepare(1).seal().bindingIds).toContain(id);
  expect(f.session.bindingIdsForStructuralReference(extraKey)).toHaveLength(1);
});

function descriptors(f: ReturnType<typeof fixture>) {
  catalogProgramAbiCallableImports(f.ctx);
  const imports = f.registry.importsForPreparedProviders(new Set([f.key]))!;
  const callableImports = imports.size ? f.ctx.programAbiCallableImports!.describePrepared(imports) : undefined;
  const callableProviders = f.registry.describePrepared(new Set([f.key]), callableImports);
  return { callableProviders, ...(callableImports ? { callableImports } : {}) };
}

function stage(f: ReturnType<typeof fixture>, terminal = f.terminals[0]!, name = "undefined-component") {
  const batch = descriptors(f);
  const scope = f.session.beginPreparedComponentScope(name, [terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId: name,
    terminalUnitIds: [terminal.id],
    requestedStructuralReferenceKeys: [f.key],
    ...batch,
  });
  const ids = scope.abi.bindingIdsForStructuralReference(f.key);
  expect(ids).toHaveLength(1);
  scope.includeBinding(ids[0]!);
  for (const id of f.registry.preparedUndefinedValueResourceBindingIds(batch.callableProviders))
    scope.includeBinding(id);
  return { scope, batch, id: ids[0]! };
}

it("does nothing for no demand", () => {
  const f = fixture();
  const counts = [f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length];
  f.registry.prepareUndefinedValueDemands([]);
  expect([f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length]).toEqual(counts);
  expect(f.ctx.funcMap.has(IR_UNDEFINED_VALUE_FN)).toBe(false);
});

it("uses the same native singleton arm with nativeStrings on the host target", () => {
  const f = fixture(false);
  f.ctx.nativeStrings = true;
  f.reserve();
  const global = f.mod.globals[f.ctx.undefinedGlobalIdx! - f.ctx.numImportGlobals];
  const func = f.provider();
  expect(f.mod.imports).toEqual([]);
  expect(func.body).toEqual([{ op: "global.get", index: f.ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }]);
  f.reserve();
  expect(f.provider()).toBe(func);
  expect(f.mod.globals[f.ctx.undefinedGlobalIdx! - f.ctx.numImportGlobals]).toBe(global);
});

it.each([true, false])("reserves one exact allocator across repeated terminal demands (native=%s)", (native) => {
  const f = fixture(native);
  const before = publication(f);
  f.reserve();
  const func = f.provider();
  const counts = [f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length];
  f.reserve();
  expect(f.provider()).toBe(func);
  expect([f.mod.functions.length, f.mod.types.length, f.mod.globals.length, f.mod.imports.length]).toEqual(counts);
  expect(publication(f)).toEqual(before);
  expect(f.registry.resolveCurrentIndex(f.instruction.target)).toBe(f.ctx.funcMap.get(IR_UNDEFINED_VALUE_FN));
  if (native) expect(f.mod.imports).toEqual([]);
  else expect(f.mod.imports.filter((entry) => entry.name === "__get_undefined")).toHaveLength(1);
});

it.each(["source", "terminal", "ABI", "symbol"] as const)("refuses a wrong %s before allocating", (mutation) => {
  const f = fixture();
  const valid = f.demands[0]!;
  const bad: IrUndefinedValueDemand =
    mutation === "source"
      ? { ...valid, sourceId: "foreign" as IrSourceId }
      : mutation === "terminal"
        ? { ...valid, terminalUnitId: "foreign" as IrUnitId }
        : mutation === "symbol"
          ? { ...valid, ref: irRuntimeFuncRef("other") }
          : ({ ...valid, signature: { params: [], results: [{ kind: "i32" }] } } as unknown as IrUndefinedValueDemand);
  const count = f.mod.functions.length;
  expect(() => f.registry.prepareUndefinedValueDemands([bad])).toThrow(
    mutation === "source" || mutation === "terminal" ? "foreign source or terminal" : "invalid undefined value demand",
  );
  expect(f.mod.functions).toHaveLength(count);
  f.reserve();
  expect(f.provider()).toBeDefined();
});

it.each(["arguments", "void", "result"] as const)(
  "refuses a noncanonical call %s at the pure census seam",
  (mutation) => {
    const f = fixture();
    expect(irUndefinedValueDemand(f.terminals[0]!.sourceId, f.terminals[0]!.id, f.instruction)).toEqual(f.demands[0]);
    const instruction =
      mutation === "arguments"
        ? { ...f.instruction, args: [asValueId(1)] }
        : mutation === "void"
          ? { ...f.instruction, result: null }
          : { ...f.instruction, resultType: irVal({ kind: "i32" }) };
    expect(() => irUndefinedValueDemand(f.terminals[0]!.sourceId, f.terminals[0]!.id, instruction)).toThrow(
      "exact () -> externref",
    );
  },
);

it("refuses a provider-name collision rather than adopting its allocator", () => {
  const f = fixture();
  const index = mintDefinedFunc(f.ctx);
  pushDefinedFunc(f.ctx, index, { name: IR_UNDEFINED_VALUE_FN, typeIdx: 0, locals: [], body: [], exported: false });
  f.ctx.funcMap.set(IR_UNDEFINED_VALUE_FN, index);
  expect(() => f.reserve()).toThrow("collides with an unowned allocator");
});

it("joins only recorded source/terminal consumers to the actual component", () => {
  const f = fixture();
  f.registry.prepareUndefinedValueDemands([f.demands[0]!]);
  const component: PreparedComponentDependencyEvidence = {
    id: "first-component",
    status: "complete",
    terminalUnitIds: [f.terminals[0]!.id],
    functionUnitIds: [f.terminals[0]!.id],
    unitDependencies: [],
    abiDependencies: [],
    failures: [],
    externalCallables: [{ ownerUnitId: f.terminals[0]!.id, structuralReferenceKey: f.key, programAbiBindingId: null }],
  };
  expect(() => f.registry.assertUndefinedValueComponent(component)).not.toThrow();
  expect(() =>
    f.registry.assertUndefinedValueComponent({ ...component, terminalUnitIds: [f.terminals[1]!.id] }),
  ).toThrow("foreign or undemanded consumer");
  const second = {
    ...component,
    id: "second-component",
    terminalUnitIds: [f.terminals[1]!.id],
    externalCallables: [{ ...component.externalCallables[0]!, ownerUnitId: f.terminals[1]!.id }],
  };
  expect(() => f.registry.assertUndefinedValueComponent(second)).toThrow("foreign or undemanded consumer");
  const func = f.provider();
  f.registry.prepareUndefinedValueDemands([f.demands[1]!]);
  expect(() => f.registry.assertUndefinedValueComponent(second)).not.toThrow();
  expect(f.provider()).toBe(func);
});

it.each(["session", "module"] as const)("refuses a foreign %s before allocation", (mutation) => {
  const f = fixture();
  const foreign = fixture();
  if (mutation === "session") f.ctx.programAbiSession = foreign.session;
  else f.ctx.mod = foreign.mod;
  expect(() => f.reserve()).toThrow();
  expect(f.ctx.funcMap.has(IR_UNDEFINED_VALUE_FN)).toBe(false);
});

it("rejects forged and cross-session provider tokens without publication", () => {
  const f = fixture();
  f.reserve();
  const other = fixture();
  const descriptor = descriptors(f).callableProviders;
  const before = publication(f);
  expect(() => prepareCallableProviderDescriptorForScope({ ...descriptor }, f.session, "forged")).toThrow();
  expect(() => prepareCallableProviderDescriptorForScope(descriptor, other.session, "foreign")).toThrow();
  expect(publication(f)).toEqual(before);
});

it("rejects replacement of the native type or host import with an equivalent-looking object", () => {
  const native = fixture();
  native.reserve();
  native.mod.types[native.ctx.anyValueTypeIdx] = { ...native.mod.types[native.ctx.anyValueTypeIdx]! };
  expect(() => native.reserve()).toThrow("singleton identity");
  const host = fixture(false);
  host.reserve();
  host.mod.imports[0] = { ...host.mod.imports[0]! };
  expect(() => host.reserve()).toThrow("capability identity");
});

it("requires the canonical native singleton and rejects missing or replaced identity", () => {
  const f = fixture();
  ensureAnyValueType(f.ctx);
  const index = f.ctx.undefinedGlobalIdx!;
  f.ctx.undefinedGlobalIdx = undefined;
  expect(() => f.reserve()).toThrow("exact native singleton");
  f.ctx.undefinedGlobalIdx = index;
  f.reserve();
  f.mod.globals[index - f.ctx.numImportGlobals] = { ...f.mod.globals[index - f.ctx.numImportGlobals]! };
  expect(() => f.reserve()).toThrow("singleton identity");
});

it("uses the existing host import exactly and rejects unavailable capability", () => {
  const f = fixture(false);
  ensureLateImport(f.ctx, "__get_undefined", [], [{ kind: "externref" }]);
  flushLateImportShifts(f.ctx, null);
  const imported = f.mod.imports.find((entry) => entry.name === "__get_undefined")!;
  f.reserve();
  expect(f.registry.importsForPreparedProviders(new Set([f.key]))).toEqual(new Set([imported]));
  expect(f.provider().body).toEqual([{ op: "call", funcIdx: f.ctx.funcMap.get("__get_undefined") }]);
  const unavailable = fixture(false);
  unavailable.ctx.targetProfile = { ...unavailable.ctx.targetProfile, strictEnvImportGate: true };
  expect(() => unavailable.reserve()).toThrow("host capability is unavailable");
  expect(unavailable.mod.imports).toEqual([]);
});

it.each(["signature", "allocator"] as const)("rejects wrong host import %s", (mutation) => {
  const f = fixture(false);
  ensureLateImport(f.ctx, "__get_undefined", [], [{ kind: "externref" }]);
  flushLateImportShifts(f.ctx, null);
  const imported = f.mod.imports.find((entry) => entry.name === "__get_undefined")!;
  if (mutation === "signature" && imported.desc.kind === "func")
    f.mod.types[imported.desc.typeIdx] = { kind: "func", params: [], results: [{ kind: "i32" }] };
  else f.ctx.funcMap.set("__get_undefined", 99);
  expect(() => f.reserve()).toThrow(mutation === "signature" ? "exact () -> externref" : "foreign allocator");
});

it.each([true, false])(
  "preserves provider identity across late imports before and after reservation (native=%s)",
  (native) => {
    const f = fixture(native);
    ensureLateImport(f.ctx, "__test_before", [], []);
    flushLateImportShifts(f.ctx, null);
    f.reserve();
    const func = f.provider();
    ensureLateImport(f.ctx, "__test_after", [], []);
    flushLateImportShifts(f.ctx, null);
    f.reserve();
    expect(f.provider()).toBe(func);
    expect(f.registry.resolveCurrentIndex(f.instruction.target)).toBe(f.ctx.funcMap.get(IR_UNDEFINED_VALUE_FN));
  },
);

it.each([true, false])("aborts and retries without provider/import publication (native=%s)", (native) => {
  const f = fixture(native);
  f.reserve();
  const before = publication(f);
  const first = stage(f);
  expect(publication(f)).toEqual(before);
  first.scope.abort();
  expect(publication(f)).toEqual(before);
  expect(() => prepareCallableProviderDescriptorForScope(first.batch.callableProviders, f.session, "replay")).toThrow(
    "not fresh",
  );
  const func = f.provider();
  f.reserve();
  const retry = stage(f, f.terminals[0], "retry");
  retry.scope.seal();
  expect(f.session.hasPlan(retry.id)).toBe(true);
  expect(f.provider()).toBe(func);
});

it.each([true, false])("keeps a committed peer's resource when the next component withdraws (native=%s)", (native) => {
  const f = fixture(native);
  f.reserve();
  const first = stage(f);
  first.scope.seal();
  const before = publication(f);
  const func = f.provider();
  const second = stage(f, f.terminals[1], "second");
  second.scope.abort();
  expect(publication(f)).toEqual(before);
  expect(f.provider()).toBe(func);
  expect(f.session.hasPlan(first.id)).toBe(true);
});

it("requires the underlying host import descriptor in the same batch", () => {
  const f = fixture(false);
  f.reserve();
  catalogProgramAbiCallableImports(f.ctx);
  expect(() => f.registry.describePrepared(new Set([f.key]))).toThrow("exact host import descriptor");
  const valid = descriptors(f);
  const scope = f.session.beginPreparedComponentScope("partial", [f.terminals[0]!.id]);
  expect(() =>
    scope.stagePreparedComponentBatch({
      scopeId: "partial",
      terminalUnitIds: [f.terminals[0]!.id],
      requestedStructuralReferenceKeys: [f.key],
      callableProviders: valid.callableProviders,
    }),
  ).toThrow();
  scope.abort();
  expect(f.session.bindingIdsForStructuralReference(f.key)).toEqual([]);
});

it.each(["body", "signature", "singleton"] as const)(
  "refuses stale %s at sealing and consumes the descriptor",
  (mutation) => {
    const f = fixture();
    f.reserve();
    const before = publication(f);
    const { scope, batch } = stage(f);
    if (mutation === "body") f.provider().body = [{ op: "ref.null.extern" }];
    if (mutation === "signature")
      f.mod.types[f.provider().typeIdx] = { kind: "func", params: [], results: [{ kind: "i32" }] };
    if (mutation === "singleton") f.ctx.undefinedGlobalIdx = undefined;
    expect(() => scope.seal()).toThrow(
      mutation === "body"
        ? "body no longer"
        : mutation === "signature"
          ? "exact () -> externref"
          : "exact native singleton",
    );
    expect(publication(f)).toEqual(before);
    expect(() => prepareCallableProviderDescriptorForScope(batch.callableProviders, f.session, "retry")).toThrow(
      "not fresh",
    );
  },
);

it.each([true, false])("executes the actual reserved provider with stable non-null identity (native=%s)", (native) => {
  const f = fixture(native);
  f.reserve();
  f.mod.exports.push({ name: "read", desc: { kind: "func", index: f.ctx.funcMap.get(IR_UNDEFINED_VALUE_FN)! } });
  const module = new WebAssembly.Module(emitBinary(f.mod));
  if (native) expect(WebAssembly.Module.imports(module)).toEqual([]);
  else
    expect(WebAssembly.Module.imports(module)).toEqual([{ module: "env", name: "__get_undefined", kind: "function" }]);
  const instance = new WebAssembly.Instance(module, native ? {} : { env: { __get_undefined: () => undefined } });
  const read = instance.exports.read as () => unknown;
  const value = read();
  expect(value).not.toBe(null);
  expect(read()).toBe(value);
  if (!native) expect(value).toBe(undefined);
});

it.each(["gc", "standalone"] as const)("executes captured undefined before and after a write (%s)", async (target) => {
  const result = await compile(
    "export function run(): number { let value: number | undefined; const read = (): number => value === undefined ? 1 : 2; const before = read(); value = 42; return before * 10 + read(); }",
    { target, experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const mod = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  expect((instance.exports.run as () => number)()).toBe(12);
  expect(result.irOutcomes?.find((row) => row.displayName === "run")).toMatchObject({
    irBodyEmitted: true,
  });
});

it("keeps the semantic demand owner free of codegen and runtime-selection imports", () => {
  const source = readFileSync(new URL("../src/ir/undefined-value-provider.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("demand.ts", source, ts.ScriptTarget.Latest, true);
  const imports = ast.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
  expect(imports).toEqual(["../shared/contracts/ir-identity.js", "./core/nodes.js", "./core/callable-bindings.js"]);
  expect(source).not.toContain("CodegenContext");
  expect(source).not.toContain("ts-api");
});
