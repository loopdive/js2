// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  catalogProgramAbiCallableImports,
  type PreparedCallableImportDescriptor,
} from "../src/codegen/program-abi-import-planning.js";
import {
  planProgramAbiGlobal,
  planProgramAbiUnitCallable,
  PROGRAM_ABI_GLOBAL_ROLE,
} from "../src/codegen/program-abi-planning.js";
import type { PreparedExportAliasDescriptor } from "../src/codegen/program-abi-export-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irClassTypeRef, irSupportGlobalRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import {
  irCallableBindingKey,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import {
  buildIrUnitInventory,
  type IrBindingId,
  type IrTerminalUnitRecord,
  type IrUnitId,
} from "../src/ir/identity.js";
import type { IrFunction } from "../src/ir/nodes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type GlobalDef,
  type Import,
  type StructTypeDef,
  type WasmFunction,
} from "../src/ir/types.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({ kind: "func" as const, params: Object.freeze([]), results: Object.freeze([]) });
const RUNTIME_TARGETS = ["gc", "standalone"] as const;

const SHARED_PROVIDER_SOURCE = `
  class Failed {
    value(input: string): number { return input.slice(1).length; }
  }
  class Healthy {
    value(input: string): number { return input.slice(1).length; }
  }
  export function failed(): number { return new Failed().value("abc"); }
  export function healthy(): number { return new Healthy().value("abcd"); }
`;

const EXACT_CLASS_SETTER_SOURCE = `
  function trigger(): void {
    const C = class {
      set value(next) {
        target = next;
      }
    };
    new C().value = 42;
  }

  var verdict: number = 0;
  try {
    trigger();
  } catch (error) {
    verdict = error instanceof ReferenceError ? 1 : 2;
  }
  let target: any;

  export function run(): number {
    return verdict;
  }
`;

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function exactAccessorUnits(source: string, fileName: string): readonly IrTerminalUnitRecord[] {
  const ast = analyzeSource(source, fileName);
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  return inventory.terminalUnits.filter(
    (unit) => unit.observedKind === "class-member" && unit.kind === "class-instance-setter",
  );
}

function exactOutcome(result: CompileResult, unitId: IrUnitId): IrObservedOutcome {
  const outcomes = (result.irOutcomes ?? []).filter((candidate) => candidate.unitId === unitId);
  expect(outcomes, `outcome count for ${unitId}`).toHaveLength(1);
  return outcomes[0]!;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watCallTargets(wat: string, body: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

function referenceErrorCallChains(result: CompileResult): readonly string[] {
  return parseWatFunctions(result.wat)
    .flatMap(({ name, body }) =>
      watCallTargets(result.wat, body)
        .filter((target) => target === "__new_ReferenceError" || target === "__throw_reference_error")
        .map((target) => `${name}->${target}`),
    )
    .sort();
}

function referenceErrorImportInventory(result: CompileResult): readonly string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
    .filter(
      (name) => name.endsWith(".__new_ReferenceError:function") || name.endsWith(".__throw_reference_error:function"),
    )
    .sort();
}

function importInventory(result: CompileResult): readonly string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
    .sort();
}

function referenceErrorProviderInventory(generated: ReturnType<typeof generateModule>) {
  const providerKey = irCallableBindingKey(irRuntimeFuncRef("__new_ReferenceError").binding);
  return (generated.programAbi?.abi.entries() ?? [])
    .filter(({ structuralReferenceKey }) => structuralReferenceKey === providerKey)
    .map((entry) => ({
      id: entry.id,
      structuralReferenceKey: entry.structuralReferenceKey,
      slotPolicy: entry.slotPolicy,
      slotSpace: entry.slotPolicy === "required" ? entry.slotSpace : undefined,
      intent: entry.intent,
      finalIndex: generated.programAbi!.abi.resolveFinalIndex(entry.id),
    }));
}

function referenceErrorDefinitionCount(result: CompileResult): number {
  return parseWatFunctions(result.wat).filter(({ name }) => name === "__new_ReferenceError").length;
}

async function withPreparedSealFailure<T>(selector: string, run: () => T | Promise<T>): Promise<T> {
  const key = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE";
  const previous = process.env[key];
  process.env[key] = selector;
  try {
    return await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = previous;
  }
}

async function instantiateAndInitialize(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  exports.__module_init?.();
  return exports;
}

function sharedProviderUnits(fileName: string) {
  const ast = analyzeSource(SHARED_PROVIDER_SOURCE, fileName);
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  const failedClass = inventory.classes.find(({ displayName }) => displayName === "Failed");
  const healthyClass = inventory.classes.find(({ displayName }) => displayName === "Healthy");
  const failed = inventory.terminalUnits.find(
    ({ kind, lexicalOwnerId }) => kind === "class-instance-method" && lexicalOwnerId === failedClass?.id,
  );
  const healthy = inventory.terminalUnits.find(
    ({ kind, lexicalOwnerId }) => kind === "class-instance-method" && lexicalOwnerId === healthyClass?.id,
  );
  if (!failed || !healthy) throw new Error("invalid #4260 shared-provider fixture");
  return { ast, failed, healthy };
}

function importedFunction(name: string): Import {
  return { module: "env", name, desc: { kind: "func", typeIdx: 0 } };
}

function sourceFunction(name: string): WasmFunction {
  return { name, typeIdx: 0, locals: [], body: [], exported: false };
}

function irFunction(unitId: IrUnitId, name: string): IrFunction {
  return {
    kind: "function",
    unitId,
    name,
    params: [],
    returnType: null,
    blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs: [], term: { kind: "return", value: null } }],
    entry: 0,
  };
}

function fixture() {
  const file = ts.createSourceFile(
    "/repo/issue-4260.ts",
    "export function first(): void {} export function second(): void {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([file], { entrySource: file });
  const terminals = inventory.terminalUnits.filter(({ kind }) => kind === "top-level-function");
  if (terminals.length !== 2) throw new Error("invalid #4260 transaction fixture");
  const module = createEmptyModule();
  module.types.push(VOID_SIGNATURE);
  const runtimeImport = importedFunction("shared_runtime");
  module.imports.push(runtimeImport);
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
  ctx.numImportFuncs = 1;
  catalogProgramAbiCallableImports(ctx);
  const imports = ctx.programAbiCallableImports;
  const providers = ctx.programAbiCallableProviders;
  if (!imports || !providers) throw new Error("missing #4260 ABI registries");
  const providerRef = irRuntimeFuncRef("shared_runtime");
  const providerKey = irCallableBindingKey(providerRef.binding);
  providers.observe(providerRef, 0);
  const sourceFunctions: WasmFunction[] = [];
  const sourceBindingIds = terminals.map((terminal) => {
    const func = sourceFunction(terminal.displayName);
    sourceFunctions.push(func);
    module.functions.push(func);
    const bindingId = planProgramAbiUnitCallable(ctx, {
      ref: irUnitFuncRef(irFunction(terminal.id, terminal.displayName)),
      signature: VOID_SIGNATURE,
      func,
    });
    if (!bindingId) throw new Error("missing source callable binding");
    return bindingId;
  });
  return {
    ctx,
    imports,
    inventory,
    module,
    providerKey,
    providers,
    runtimeImport,
    session,
    sourceBindingIds,
    sourceFunctions,
    terminals,
  };
}

type Fixture = ReturnType<typeof fixture>;

function classFixture() {
  const ast = analyzeSource(
    "class Box { value(): void {} } export function run(): void { new Box().value(); }",
    "/repo/issue-4260-class.ts",
  );
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const classRecord = inventory.classes.find(({ displayName }) => displayName === "Box");
  const terminal = inventory.terminalUnits.find(
    ({ kind, lexicalOwnerId }) => kind === "class-instance-method" && lexicalOwnerId === classRecord?.id,
  );
  const declaration = ast.sourceFile.statements.find(ts.isClassDeclaration);
  if (!classRecord || !terminal || !declaration) throw new Error("invalid #4260 class fixture");
  const module = createEmptyModule();
  const classType: StructTypeDef = { kind: "struct", name: "Box", fields: [] };
  module.types.push(VOID_SIGNATURE, classType);
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, { experimentalIR: true }, session, identity);
  const types = ctx.programAbiTypes;
  if (!types) throw new Error("missing #4260 type registry");
  types.observeClass(declaration, "Box", classType);
  const func = sourceFunction(terminal.displayName);
  module.functions.push(func);
  const sourceBindingId = planProgramAbiUnitCallable(ctx, {
    ref: irUnitFuncRef(irFunction(terminal.id, terminal.displayName)),
    signature: VOID_SIGNATURE,
    func,
  });
  if (!sourceBindingId) throw new Error("missing class source callable binding");
  const structuralKey = irTypeBindingKey(irClassTypeRef(classRecord.id, classRecord.displayName).binding);
  return {
    classRecord,
    classType,
    ctx,
    declaration,
    module,
    session,
    sourceBindingId,
    structuralKey,
    terminal,
    types,
  };
}

type ClassFixture = ReturnType<typeof classFixture>;

function descriptors(f: Fixture) {
  const callableImports = f.imports.describePrepared(new Set([f.runtimeImport]));
  const callableProviders = f.providers.describePrepared(new Set([f.providerKey]), callableImports);
  return { callableImports, callableProviders };
}

function sessionState(session: ProgramAbiSession) {
  const state = session as unknown as Record<string, ReadonlyMap<unknown, unknown>>;
  return {
    drafts: [...state.drafts!.entries()],
    draftOrderOwners: [...state.draftOrderOwners!.entries()],
    locators: [...state.locators!.entries()],
    locatorOwners: [...state.locatorOwners!.entries()],
    structuralReferenceKeys: [...state.structuralReferenceKeys!.entries()],
    callableTypeContracts: [...state.callableTypeContracts!.entries()],
    preparedScopes: [...state.preparedScopes!.entries()],
    preparedScopeByUnitId: [...state.preparedScopeByUnitId!.entries()],
    preparedScopeByClassId: [...state.preparedScopeByClassId!.entries()],
    preparedScopeIdsByBindingId: [...state.preparedScopeIdsByBindingId!.entries()].map(([id, scopeIds]) => [
      id,
      [...(scopeIds as Set<string>)],
    ]),
  };
}

function registryState(f: Fixture) {
  const imports = f.imports as unknown as {
    readonly sealedEntries: readonly unknown[] | undefined;
    readonly plannedByImport: ReadonlyMap<Import, IrBindingId>;
  };
  const providers = f.providers as unknown as {
    readonly observationOrder: readonly string[] | undefined;
    readonly appendedOrder: readonly string[];
    readonly plannedByKey: ReadonlyMap<string, IrBindingId>;
  };
  return {
    sealedImportCount: imports.sealedEntries?.length ?? null,
    plannedImports: [...imports.plannedByImport.entries()],
    providerOrder: providers.observationOrder ? [...providers.observationOrder] : null,
    providerAppend: [...providers.appendedOrder],
    plannedProviders: [...providers.plannedByKey.entries()],
  };
}

function exportAliasDrafts(session: ProgramAbiSession) {
  const state = session as unknown as {
    readonly drafts: ReadonlyMap<IrBindingId, { readonly intent: { kind: string } }>;
  };
  return [...state.drafts.values()].filter(({ intent }) => intent.kind === "export");
}

function stageProviderBatch(f: Fixture, scopeId: string, terminalIndex = 0) {
  const exact = descriptors(f);
  const terminal = f.terminals[terminalIndex]!;
  const scope = f.session.beginPreparedComponentScope(scopeId, [terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId,
    terminalUnitIds: [terminal.id],
    requestedStructuralReferenceKeys: [f.providerKey],
    ...exact,
  });
  const providerIds = scope.abi.bindingIdsForStructuralReference(f.providerKey);
  expect(providerIds).toHaveLength(1);
  return { ...exact, providerId: providerIds[0]!, scope, terminal };
}

function stageExportedProviderBatch(f: Fixture, scopeId: string, exportNames = ["shared_runtime_export"]) {
  for (const name of exportNames) f.module.exports.push({ name, desc: { kind: "func", index: 0 } });
  const exact = descriptors(f);
  const exportAliases = f.ctx.programAbiExports?.describePrepared(new Set([f.runtimeImport]));
  if (!exportAliases) throw new Error("missing prepared export-alias descriptor");
  const terminal = f.terminals[0]!;
  const scope = f.session.beginPreparedComponentScope(scopeId, [terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId,
    terminalUnitIds: [terminal.id],
    requestedStructuralReferenceKeys: [f.providerKey],
    ...exact,
    exportAliases,
  });
  const [providerId] = scope.abi.bindingIdsForStructuralReference(f.providerKey);
  if (!providerId) throw new Error("missing exported provider identity");
  return { ...exact, exportAliases, providerId, scope, terminal };
}

function stageSourceExportBatch(f: Fixture, scopeId: string, exportNames = ["first_export"], terminalIndex = 0) {
  const target = f.sourceFunctions[terminalIndex]!;
  const index = 1 + terminalIndex;
  for (const name of exportNames) f.module.exports.push({ name, desc: { kind: "func", index } });
  const exportAliases = f.ctx.programAbiExports?.describePrepared(new Set([target]));
  if (!exportAliases) throw new Error("missing source export-alias descriptor");
  const terminal = f.terminals[terminalIndex]!;
  const scope = f.session.beginPreparedComponentScope(scopeId, [terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId,
    terminalUnitIds: [terminal.id],
    requestedStructuralReferenceKeys: [],
    exportAliases,
  });
  return { exportAliases, scope, target, terminal };
}

function stageGlobalExportBatch(f: Fixture, scopeId: string) {
  const terminal = f.terminals[0]!;
  const global: GlobalDef = {
    name: "prepared_global",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
  f.module.globals.push(global);
  const ref = irSupportGlobalRef(terminal.id, "prepared-global", "prepared_global");
  planProgramAbiGlobal(f.ctx, {
    ref,
    anchor: { kind: "unit", unitId: terminal.id },
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    global,
  });
  f.module.exports.push({ name: "prepared_global_export", desc: { kind: "global", index: 0 } });
  const exportAliases = f.ctx.programAbiExports?.describePrepared(new Set([global]));
  if (!exportAliases) throw new Error("missing global export-alias descriptor");
  const scope = f.session.beginPreparedComponentScope(scopeId, [terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId,
    terminalUnitIds: [terminal.id],
    requestedStructuralReferenceKeys: [],
    exportAliases,
  });
  scope.includeBinding(ref.binding.bindingId);
  return { exportAliases, global, globalId: ref.binding.bindingId, scope, terminal };
}

function stageClassBatch(f: ClassFixture, scopeId: string) {
  const classLayouts = f.types.describePreparedClassLayouts(new Set([f.classRecord.id]));
  const scope = f.session.beginPreparedComponentScope(scopeId, [f.terminal.id]);
  scope.stagePreparedComponentBatch({
    scopeId,
    terminalUnitIds: [f.terminal.id],
    requestedStructuralReferenceKeys: [f.structuralKey],
    classLayouts,
  });
  const [classBindingId] = scope.abi.bindingIdsForStructuralReference(f.structuralKey);
  if (!classBindingId) throw new Error("missing provisional class binding");
  return { classBindingId, classLayouts, scope };
}

describe("#4260 atomic prepared provider publication", () => {
  it("keeps every session and registry publication row absent after abort and consumes the batch", () => {
    const f = fixture();
    const beforeSession = sessionState(f.session);
    const beforeRegistries = registryState(f);
    const staged = stageProviderBatch(f, "aborted-provider");

    expect(f.session.getDraft(staged.providerId)).toBeUndefined();
    expect(registryState(f)).toEqual(beforeRegistries);
    staged.scope.abort();
    expect(sessionState(f.session)).toEqual(beforeSession);
    expect(registryState(f)).toEqual(beforeRegistries);

    const replay = f.session.beginPreparedComponentScope("replayed-provider", [staged.terminal.id]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "replayed-provider",
        terminalUnitIds: [staged.terminal.id],
        requestedStructuralReferenceKeys: [f.providerKey],
        callableImports: staged.callableImports,
        callableProviders: staged.callableProviders,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    replay.abort();
    expect(() => f.imports.publishPreparedDescriptor(staged.callableImports)).toThrowError(ProgramAbiInvariantError);
    expect(() => f.providers.publishPreparedDescriptor(staged.callableProviders)).toThrowError(
      ProgramAbiInvariantError,
    );
  });

  it("publishes session sidecars, registry mappings, and scope visibility as one successful batch", () => {
    const f = fixture();
    const staged = stageProviderBatch(f, "committed-provider");
    staged.scope.includeBinding(staged.providerId);
    const sealed = staged.scope.seal();

    const providerDraft = f.session.getDraft(staged.providerId);
    expect(providerDraft).toMatchObject({
      structuralReferenceKey: f.providerKey,
      slotPolicy: "alias",
      intent: { kind: "callable", origin: "runtime" },
    });
    const canonicalId = sealed.canonicalId(staged.providerId);
    expect(canonicalId).not.toBe(staged.providerId);
    expect(f.session.hasLocator(canonicalId, f.runtimeImport)).toBe(true);
    expect(registryState(f)).toMatchObject({
      sealedImportCount: 1,
      providerOrder: [f.providerKey],
      plannedProviders: [[f.providerKey, staged.providerId]],
    });
    expect(sealed.bindingIds).toEqual(expect.arrayContaining([f.sourceBindingIds[0], canonicalId, staged.providerId]));
  });

  it("consumes a stale staged batch and leaves publication snapshots byte-for-byte unchanged", () => {
    const f = fixture();
    const beforeSession = sessionState(f.session);
    const beforeRegistries = registryState(f);
    const staged = stageProviderBatch(f, "stale-provider");
    staged.scope.includeBinding(staged.providerId);
    f.module.imports[0] = importedFunction("shared_runtime");

    expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(sessionState(f.session)).toEqual(beforeSession);
    expect(registryState(f)).toEqual(beforeRegistries);
    const replay = f.session.beginPreparedComponentScope("stale-replay", [staged.terminal.id]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "stale-replay",
        terminalUnitIds: [staged.terminal.id],
        requestedStructuralReferenceKeys: [f.providerKey],
        callableImports: staged.callableImports,
        callableProviders: staged.callableProviders,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    replay.abort();
  });

  it("rejects forged, foreign, partial, and second batches without publishing a row", () => {
    const target = fixture();
    const foreign = fixture();
    const beforeSession = sessionState(target.session);
    const beforeRegistries = registryState(target);
    const targetDescriptors = descriptors(target);
    const foreignDescriptors = descriptors(foreign);

    const mutations: Array<
      (
        scopeId: string,
      ) => Parameters<ReturnType<ProgramAbiSession["beginPreparedComponentScope"]>["stagePreparedComponentBatch"]>[0]
    > = [
      (scopeId) => ({
        scopeId,
        terminalUnitIds: [target.terminals[0]!.id],
        requestedStructuralReferenceKeys: [target.providerKey],
        callableImports: Object.freeze({
          kind: "prepared-callable-import-descriptor",
        }) as PreparedCallableImportDescriptor,
        callableProviders: targetDescriptors.callableProviders,
      }),
      (scopeId) => ({
        scopeId,
        terminalUnitIds: [target.terminals[0]!.id],
        requestedStructuralReferenceKeys: [target.providerKey],
        callableImports: foreignDescriptors.callableImports,
        callableProviders: foreignDescriptors.callableProviders,
      }),
      (scopeId) => ({
        scopeId,
        terminalUnitIds: [target.terminals[0]!.id],
        requestedStructuralReferenceKeys: [target.providerKey],
        callableProviders: targetDescriptors.callableProviders,
      }),
    ];
    mutations.forEach((mutation, index) => {
      const scopeId = `invalid-batch-${index}`;
      const scope = target.session.beginPreparedComponentScope(scopeId, [target.terminals[0]!.id]);
      expect(() => scope.stagePreparedComponentBatch(mutation(scopeId))).toThrowError(ProgramAbiInvariantError);
      scope.abort();
      expect(sessionState(target.session)).toEqual(beforeSession);
      expect(registryState(target)).toEqual(beforeRegistries);
    });

    const fresh = fixture();
    const staged = stageProviderBatch(fresh, "double-stage");
    expect(() =>
      staged.scope.stagePreparedComponentBatch({
        scopeId: "double-stage",
        terminalUnitIds: [staged.terminal.id],
        requestedStructuralReferenceKeys: [fresh.providerKey],
        callableImports: staged.callableImports,
        callableProviders: staged.callableProviders,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    staged.scope.abort();
  });

  it("reuses one committed provider/import identity across a disjoint healthy scope", () => {
    const f = fixture();
    const first = stageProviderBatch(f, "first-provider", 0);
    first.scope.includeBinding(first.providerId);
    first.scope.seal();

    const second = f.session.beginPreparedComponentScope("second-provider", [f.terminals[1]!.id]);
    second.includeBinding(first.providerId);
    const sealed = second.seal();
    expect(sealed.canonicalId(first.providerId)).toBe(f.session.locatorBindingId(f.runtimeImport));
    expect(registryState(f).plannedProviders).toEqual([[f.providerKey, first.providerId]]);
    expect(f.session.bindingIdsForStructuralReference(f.providerKey)).toEqual([first.providerId]);
  });

  it("rejects mismatched scope, terminal, request, and seal closure denominators without writes", () => {
    const mutations = [
      (f: Fixture, scopeId: string) => ({
        ...descriptors(f),
        scopeId: `${scopeId}-foreign`,
        terminalUnitIds: [f.terminals[0]!.id],
        requestedStructuralReferenceKeys: [f.providerKey],
      }),
      (f: Fixture, scopeId: string) => ({
        ...descriptors(f),
        scopeId,
        terminalUnitIds: [f.terminals[1]!.id],
        requestedStructuralReferenceKeys: [f.providerKey],
      }),
      (f: Fixture, scopeId: string) => ({
        ...descriptors(f),
        scopeId,
        terminalUnitIds: [f.terminals[0]!.id],
        requestedStructuralReferenceKeys: [`${f.providerKey}:wrong`],
      }),
    ];
    mutations.forEach((mutation, index) => {
      const f = fixture();
      const beforeSession = sessionState(f.session);
      const beforeRegistries = registryState(f);
      const scopeId = `denominator-${index}`;
      const scope = f.session.beginPreparedComponentScope(scopeId, [f.terminals[0]!.id]);
      expect(() => scope.stagePreparedComponentBatch(mutation(f, scopeId))).toThrowError(ProgramAbiInvariantError);
      scope.abort();
      expect(sessionState(f.session)).toEqual(beforeSession);
      expect(registryState(f)).toEqual(beforeRegistries);
    });

    const incomplete = fixture();
    const beforeSession = sessionState(incomplete.session);
    const beforeRegistries = registryState(incomplete);
    const staged = stageProviderBatch(incomplete, "missing-seal-closure");
    expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(sessionState(incomplete.session)).toEqual(beforeSession);
    expect(registryState(incomplete)).toEqual(beforeRegistries);
  });

  it("publishes no transaction rows across stale import/provider population, locator, signature, or key", () => {
    const mutations: readonly ((f: Fixture) => void)[] = [
      (f) => f.module.imports.push(importedFunction("late_population")),
      (f) => {
        f.module.imports[0] = importedFunction("shared_runtime");
      },
      (f) => {
        f.module.types[0] = {
          kind: "func",
          params: [{ kind: "i32" }],
          results: [],
        };
      },
      (f) => {
        f.runtimeImport.name = "changed_structural_key";
      },
      (f) => {
        f.providers.observe(irRuntimeFuncRef("late_provider"), 0);
      },
    ];
    mutations.forEach((mutate, index) => {
      const f = fixture();
      const staged = stageProviderBatch(f, `stale-${index}`);
      staged.scope.includeBinding(staged.providerId);
      mutate(f);
      const beforeSession = sessionState(f.session);
      const beforeRegistries = registryState(f);
      expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
      expect(sessionState(f.session)).toEqual(beforeSession);
      expect(registryState(f)).toEqual(beforeRegistries);
    });

    const crossed = fixture();
    const staged = stageProviderBatch(crossed, "crossed-publication");
    staged.scope.includeBinding(staged.providerId);
    const competing = descriptors(crossed);
    crossed.imports.publishPreparedDescriptor(competing.callableImports);
    const beforeSession = sessionState(crossed.session);
    const beforeRegistries = registryState(crossed);
    expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(sessionState(crossed.session)).toEqual(beforeSession);
    expect(registryState(crossed)).toEqual(beforeRegistries);

    const staleBeforeStage = fixture();
    const exact = descriptors(staleBeforeStage);
    const initialSession = sessionState(staleBeforeStage.session);
    const initialRegistries = registryState(staleBeforeStage);
    staleBeforeStage.module.imports[0] = importedFunction("shared_runtime");
    const rejected = staleBeforeStage.session.beginPreparedComponentScope("stale-before-stage", [
      staleBeforeStage.terminals[0]!.id,
    ]);
    expect(() =>
      rejected.stagePreparedComponentBatch({
        scopeId: "stale-before-stage",
        terminalUnitIds: [staleBeforeStage.terminals[0]!.id],
        requestedStructuralReferenceKeys: [staleBeforeStage.providerKey],
        ...exact,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    rejected.abort();
    expect(sessionState(staleBeforeStage.session)).toEqual(initialSession);
    expect(registryState(staleBeforeStage)).toEqual(initialRegistries);

    staleBeforeStage.module.imports[0] = staleBeforeStage.runtimeImport;
    const replay = staleBeforeStage.session.beginPreparedComponentScope("stale-before-stage-replay", [
      staleBeforeStage.terminals[0]!.id,
    ]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "stale-before-stage-replay",
        terminalUnitIds: [staleBeforeStage.terminals[0]!.id],
        requestedStructuralReferenceKeys: [staleBeforeStage.providerKey],
        ...exact,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    replay.abort();
    expect(sessionState(staleBeforeStage.session)).toEqual(initialSession);
    expect(registryState(staleBeforeStage)).toEqual(initialRegistries);
  });

  it("keeps committed shared rows exact when a later same-provider batch aborts", () => {
    const f = fixture();
    const healthy = stageProviderBatch(f, "healthy-shared", 0);
    healthy.scope.includeBinding(healthy.providerId);
    healthy.scope.seal();
    const beforeSession = sessionState(f.session);
    const beforeRegistries = registryState(f);

    const aborted = stageProviderBatch(f, "aborted-shared", 1);
    expect(aborted.providerId).toBe(healthy.providerId);
    aborted.scope.abort();
    expect(sessionState(f.session)).toEqual(beforeSession);
    expect(registryState(f)).toEqual(beforeRegistries);
  });

  it("reuses one committed shared export alias when a later component aborts", () => {
    const f = fixture();
    const healthy = stageExportedProviderBatch(f, "healthy-export-alias");
    healthy.scope.includeBinding(healthy.providerId);
    healthy.scope.seal();
    const beforeSession = sessionState(f.session);
    const beforeRegistries = registryState(f);

    const exact = descriptors(f);
    const exportAliases = f.ctx.programAbiExports?.describePrepared(new Set([f.runtimeImport]));
    if (!exportAliases) throw new Error("missing reusable export descriptor");
    const terminal = f.terminals[1]!;
    const aborted = f.session.beginPreparedComponentScope("aborted-reused-export", [terminal.id]);
    aborted.stagePreparedComponentBatch({
      scopeId: "aborted-reused-export",
      terminalUnitIds: [terminal.id],
      requestedStructuralReferenceKeys: [f.providerKey],
      ...exact,
      exportAliases,
    });
    const [providerId] = aborted.abi.bindingIdsForStructuralReference(f.providerKey);
    if (!providerId) throw new Error("missing reused provider identity");
    expect(providerId).toBe(healthy.providerId);
    aborted.includeBinding(providerId);
    aborted.abort();
    expect(sessionState(f.session)).toEqual(beforeSession);
    expect(registryState(f)).toEqual(beforeRegistries);
  });

  it("commits every same-target export alias with its provider and leaves all aliases absent on abort", () => {
    const aborted = fixture();
    const beforeAbort = sessionState(aborted.session);
    const abandoned = stageExportedProviderBatch(aborted, "aborted-export-alias", ["shared_one", "shared_two"]);
    expect(exportAliasDrafts(aborted.session)).toEqual([]);
    abandoned.scope.abort();
    expect(sessionState(aborted.session)).toEqual(beforeAbort);
    expect(exportAliasDrafts(aborted.session)).toEqual([]);

    const committed = fixture();
    const staged = stageExportedProviderBatch(committed, "committed-export-alias", ["shared_one", "shared_two"]);
    staged.scope.includeBinding(staged.providerId);
    const sealed = staged.scope.seal();
    const canonicalId = sealed.canonicalId(staged.providerId);
    const aliases = exportAliasDrafts(committed.session);
    expect(aliases).toHaveLength(2);
    expect(aliases).toEqual([
      expect.objectContaining({
        slotPolicy: "alias",
        aliasOf: canonicalId,
        intent: { kind: "export", externalName: "shared_one", targetId: canonicalId },
      }),
      expect.objectContaining({
        slotPolicy: "alias",
        aliasOf: canonicalId,
        intent: { kind: "export", externalName: "shared_two", targetId: canonicalId },
      }),
    ]);
    expect(sealed.bindingIds).toEqual(expect.arrayContaining(aliases.map(({ id }) => id)));
    const beforeRetained = sessionState(committed.session);
    committed.ctx.programAbiExports?.planRetained();
    expect(sessionState(committed.session)).toEqual(beforeRetained);
  });

  it("commits a required global alias and a defined-provider alias through the same overlay", () => {
    const globalFixture = fixture();
    const preparedGlobal = stageGlobalExportBatch(globalFixture, "committed-global-export");
    const globalScope = preparedGlobal.scope.seal();
    const [globalAlias] = exportAliasDrafts(globalFixture.session);
    expect(globalAlias).toMatchObject({
      slotPolicy: "alias",
      aliasOf: preparedGlobal.globalId,
      intent: {
        kind: "export",
        externalName: "prepared_global_export",
        targetId: preparedGlobal.globalId,
      },
    });
    expect(globalScope.bindingIds).toEqual(expect.arrayContaining([preparedGlobal.globalId, globalAlias!.id]));
    expect(globalFixture.session.hasLocator(preparedGlobal.globalId, preparedGlobal.global)).toBe(true);

    const defined = fixture();
    const allocator = sourceFunction("defined_provider");
    defined.module.functions.push(allocator);
    const providerRef = irRuntimeFuncRef("defined_provider");
    const providerKey = irCallableBindingKey(providerRef.binding);
    const providerHandle = defined.ctx.numImportFuncs + defined.module.functions.indexOf(allocator);
    defined.providers.observe(providerRef, providerHandle);
    const callableProviders = defined.providers.describePrepared(new Set([providerKey]));
    defined.module.exports.push({ name: "defined_provider_export", desc: { kind: "func", index: providerHandle } });
    const exportAliases = defined.ctx.programAbiExports?.describePrepared(new Set([allocator]));
    if (!exportAliases) throw new Error("missing defined-provider export descriptor");
    const terminal = defined.terminals[0]!;
    const scope = defined.session.beginPreparedComponentScope("defined-provider-export", [terminal.id]);
    scope.stagePreparedComponentBatch({
      scopeId: "defined-provider-export",
      terminalUnitIds: [terminal.id],
      requestedStructuralReferenceKeys: [providerKey],
      callableProviders,
      exportAliases,
    });
    const [providerId] = scope.abi.bindingIdsForStructuralReference(providerKey);
    if (!providerId) throw new Error("missing defined provider binding");
    scope.includeBinding(providerId);
    const sealed = scope.seal();
    expect(defined.session.getDraft(providerId)).toMatchObject({
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "runtime" },
    });
    expect(defined.session.hasLocator(providerId, allocator)).toBe(true);
    expect(registryState(defined).plannedImports).toEqual([]);
    expect(exportAliasDrafts(defined.session)).toEqual([
      expect.objectContaining({
        aliasOf: providerId,
        intent: { kind: "export", externalName: "defined_provider_export", targetId: providerId },
      }),
    ]);
    expect(sealed.canonicalId(exportAliasDrafts(defined.session)[0]!.id)).toBe(providerId);
  });

  it("rejects stale, forged, reused, and unrelated export descriptors without one publication write", () => {
    const stale = fixture();
    const beforeStale = sessionState(stale.session);
    const staged = stageExportedProviderBatch(stale, "stale-export-alias");
    staged.scope.includeBinding(staged.providerId);
    stale.module.exports[0]!.name = "changed_export";
    expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(sessionState(stale.session)).toEqual(beforeStale);

    stale.module.exports[0]!.name = "shared_runtime_export";
    const exact = descriptors(stale);
    const replay = stale.session.beginPreparedComponentScope("reused-export-alias", [stale.terminals[0]!.id]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "reused-export-alias",
        terminalUnitIds: [stale.terminals[0]!.id],
        requestedStructuralReferenceKeys: [stale.providerKey],
        ...exact,
        exportAliases: staged.exportAliases,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    replay.abort();
    expect(sessionState(stale.session)).toEqual(beforeStale);

    const forged = fixture();
    forged.module.exports.push({ name: "shared_runtime_export", desc: { kind: "func", index: 0 } });
    const forgedExact = descriptors(forged);
    const forgedScope = forged.session.beginPreparedComponentScope("forged-export-alias", [forged.terminals[0]!.id]);
    expect(() =>
      forgedScope.stagePreparedComponentBatch({
        scopeId: "forged-export-alias",
        terminalUnitIds: [forged.terminals[0]!.id],
        requestedStructuralReferenceKeys: [forged.providerKey],
        ...forgedExact,
        exportAliases: Object.freeze({ kind: "prepared-export-alias-descriptor" }) as PreparedExportAliasDescriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    forgedScope.abort();
    expect(exportAliasDrafts(forged.session)).toEqual([]);

    const unrelated = fixture();
    unrelated.module.exports.push({ name: "second_only", desc: { kind: "func", index: 2 } });
    const unrelatedDescriptor = unrelated.ctx.programAbiExports?.describePrepared(
      new Set([unrelated.sourceFunctions[1]!]),
    );
    if (!unrelatedDescriptor) throw new Error("missing unrelated export descriptor");
    const unrelatedScope = unrelated.session.beginPreparedComponentScope("unrelated-export-alias", [
      unrelated.terminals[0]!.id,
    ]);
    unrelatedScope.stagePreparedComponentBatch({
      scopeId: "unrelated-export-alias",
      terminalUnitIds: [unrelated.terminals[0]!.id],
      requestedStructuralReferenceKeys: [],
      exportAliases: unrelatedDescriptor,
    });
    expect(() => unrelatedScope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(exportAliasDrafts(unrelated.session)).toEqual([]);

    const foreignTarget = fixture();
    const foreign = fixture();
    foreign.module.exports.push({ name: "foreign", desc: { kind: "func", index: 1 } });
    const foreignDescriptor = foreign.ctx.programAbiExports?.describePrepared(new Set([foreign.sourceFunctions[0]!]));
    if (!foreignDescriptor) throw new Error("missing foreign export descriptor");
    const foreignScope = foreignTarget.session.beginPreparedComponentScope("foreign-export-alias", [
      foreignTarget.terminals[0]!.id,
    ]);
    expect(() =>
      foreignScope.stagePreparedComponentBatch({
        scopeId: "foreign-export-alias",
        terminalUnitIds: [foreignTarget.terminals[0]!.id],
        requestedStructuralReferenceKeys: [],
        exportAliases: foreignDescriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    foreignScope.abort();
    expect(exportAliasDrafts(foreignTarget.session)).toEqual([]);
  });

  it("rejects every exact export denominator and projected-intent mutation before publication", () => {
    const mutations: readonly {
      readonly names?: readonly string[];
      readonly mutate: (f: Fixture) => void;
    }[] = [
      {
        mutate: (f) => f.module.exports.push({ name: "late", desc: { kind: "memory", index: 0 } }),
      },
      { mutate: (f) => void f.module.exports.pop() },
      {
        names: ["first", "second"],
        mutate: (f) => f.module.exports.reverse(),
      },
      {
        mutate: (f) => {
          const row = f.module.exports[0]!;
          f.module.exports[0] = { name: row.name, desc: row.desc };
        },
      },
      {
        mutate: (f) => {
          const row = f.module.exports[0]! as unknown as { desc: { kind: "func"; index: number } };
          row.desc = { ...row.desc };
        },
      },
      {
        mutate: (f) => {
          const row = f.module.exports[0]! as unknown as { desc: { kind: string; index: number } };
          row.desc.kind = "global";
        },
      },
      {
        mutate: (f) => {
          const row = f.module.exports[0]! as unknown as { desc: { kind: string; index: number } };
          row.desc.index = 99;
        },
      },
      {
        mutate: (f) => {
          f.module.functions[0] = sourceFunction("replacement_first");
        },
      },
      {
        mutate: (f) => {
          const order = f.session.structuralOrder as unknown as {
            forSource: ProgramAbiSession["structuralOrder"]["forSource"];
          };
          const original = order.forSource.bind(f.session.structuralOrder);
          order.forSource = (sourceId, input) => {
            const value = original(sourceId, input);
            return { ...value, derivedOrdinal: value.derivedOrdinal + 1 };
          };
        },
      },
    ];
    mutations.forEach(({ names, mutate }, index) => {
      const f = fixture();
      const staged = stageSourceExportBatch(f, `stale-export-denominator-${index}`, names ? [...names] : undefined);
      mutate(f);
      const before = sessionState(f.session);
      expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
      expect(sessionState(f.session)).toEqual(before);
      expect(exportAliasDrafts(f.session)).toEqual([]);
    });

    const crossed = fixture();
    crossed.module.exports.push({ name: "crossed", desc: { kind: "func", index: 1 } });
    const crossedDescriptor = crossed.ctx.programAbiExports?.describePrepared(new Set([crossed.sourceFunctions[0]!]));
    if (!crossedDescriptor) throw new Error("missing crossed export descriptor");
    crossed.ctx.programAbiExports?.planRetained();
    const crossedBefore = sessionState(crossed.session);
    const crossedScope = crossed.session.beginPreparedComponentScope("crossed-export-planning", [
      crossed.terminals[0]!.id,
    ]);
    expect(() =>
      crossedScope.stagePreparedComponentBatch({
        scopeId: "crossed-export-planning",
        terminalUnitIds: [crossed.terminals[0]!.id],
        requestedStructuralReferenceKeys: [],
        exportAliases: crossedDescriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    crossedScope.abort();
    expect(sessionState(crossed.session)).toEqual(crossedBefore);

    const duplicate = fixture();
    duplicate.module.exports.push(
      { name: "duplicate", desc: { kind: "func", index: 1 } },
      { name: "duplicate", desc: { kind: "func", index: 2 } },
    );
    expect(() => duplicate.ctx.programAbiExports?.describePrepared(new Set(duplicate.sourceFunctions))).toThrowError(
      ProgramAbiInvariantError,
    );

    const wrongIntent = fixture();
    wrongIntent.module.exports.push({ name: "wrong_intent", desc: { kind: "func", index: 1 } });
    const wrongDescriptor = wrongIntent.ctx.programAbiExports?.describePrepared(
      new Set([wrongIntent.sourceFunctions[0]!]),
    );
    if (!wrongDescriptor) throw new Error("missing wrong-intent export descriptor");
    const targetId = wrongIntent.sourceBindingIds[0]!;
    const targetDraft = wrongIntent.session.getDraft(targetId)!;
    const privateDrafts = wrongIntent.session as unknown as {
      readonly drafts: Map<IrBindingId, typeof targetDraft>;
    };
    privateDrafts.drafts.set(
      targetId,
      Object.freeze({ ...targetDraft, intent: Object.freeze({ kind: "global" }) }) as typeof targetDraft,
    );
    const wrongBefore = sessionState(wrongIntent.session);
    const wrongScope = wrongIntent.session.beginPreparedComponentScope("wrong-export-intent", [
      wrongIntent.terminals[0]!.id,
    ]);
    expect(() =>
      wrongScope.stagePreparedComponentBatch({
        scopeId: "wrong-export-intent",
        terminalUnitIds: [wrongIntent.terminals[0]!.id],
        requestedStructuralReferenceKeys: [],
        exportAliases: wrongDescriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    wrongScope.abort();
    expect(sessionState(wrongIntent.session)).toEqual(wrongBefore);

    const incomplete = fixture();
    incomplete.module.exports.push(
      { name: "component_owned", desc: { kind: "func", index: 1 } },
      { name: "prepared_provider", desc: { kind: "func", index: 0 } },
    );
    const incompleteExact = descriptors(incomplete);
    const incompleteExport = incomplete.ctx.programAbiExports?.describePrepared(new Set([incomplete.runtimeImport]));
    if (!incompleteExport) throw new Error("missing incomplete export descriptor");
    const incompleteBefore = sessionState(incomplete.session);
    const incompleteRegistries = registryState(incomplete);
    const incompleteScope = incomplete.session.beginPreparedComponentScope("incomplete-export-closure", [
      incomplete.terminals[0]!.id,
    ]);
    incompleteScope.stagePreparedComponentBatch({
      scopeId: "incomplete-export-closure",
      terminalUnitIds: [incomplete.terminals[0]!.id],
      requestedStructuralReferenceKeys: [incomplete.providerKey],
      ...incompleteExact,
      exportAliases: incompleteExport,
    });
    const [incompleteProviderId] = incompleteScope.abi.bindingIdsForStructuralReference(incomplete.providerKey);
    if (!incompleteProviderId) throw new Error("missing incomplete provider identity");
    incompleteScope.includeBinding(incompleteProviderId);
    expect(() => incompleteScope.seal()).toThrowError(ProgramAbiInvariantError);
    expect(sessionState(incomplete.session)).toEqual(incompleteBefore);
    expect(registryState(incomplete)).toEqual(incompleteRegistries);
  });

  it("does not let an abandoned preview freeze provider or import retained order", () => {
    const afterAbort = fixture();
    stageProviderBatch(afterAbort, "abandoned-order").scope.abort();
    const control = fixture();
    const earlierRef = irRuntimeFuncRef("a_earlier_provider");
    for (const f of [afterAbort, control]) {
      f.providers.observe(earlierRef, 0);
    }
    expect([...afterAbort.providers.planRetained().entries()]).toEqual([...control.providers.planRetained().entries()]);

    const removedAfterAbort = fixture();
    stageProviderBatch(removedAfterAbort, "abandoned-import").scope.abort();
    const removedControl = fixture();
    for (const f of [removedAfterAbort, removedControl]) {
      f.module.imports = [];
      f.ctx.numImportFuncs = 0;
    }
    expect([...removedAfterAbort.imports.planRetained().entries()]).toEqual([
      ...removedControl.imports.planRetained().entries(),
    ]);
  });

  it("keeps provider/import identity deterministic when component execution order reverses", () => {
    const ordered = fixture();
    const orderedIds = [0, 1].map((index) => {
      const staged = stageProviderBatch(ordered, `ordered-${index}`, index);
      staged.scope.includeBinding(staged.providerId);
      staged.scope.seal();
      return staged.providerId;
    });
    const reversed = fixture();
    const reversedIds = [1, 0].map((index) => {
      const staged = stageProviderBatch(reversed, `reversed-${index}`, index);
      staged.scope.includeBinding(staged.providerId);
      staged.scope.seal();
      return staged.providerId;
    });
    expect(new Set(orderedIds)).toEqual(new Set(reversedIds));
    expect(ordered.session.locatorBindingId(ordered.runtimeImport)).toBe(
      reversed.session.locatorBindingId(reversed.runtimeImport),
    );
  });

  it("stages class layouts atomically and rejects every exact stale class state", () => {
    const committed = classFixture();
    const staged = stageClassBatch(committed, "committed-class");
    staged.scope.includeBinding(staged.classBindingId);
    const sealed = staged.scope.seal();
    expect(sealed.bindingIds).toEqual(expect.arrayContaining([committed.sourceBindingId, staged.classBindingId]));
    expect(
      committed.session.hasLocator(staged.classBindingId, committed.session.typeCellFor(committed.classType)!),
    ).toBe(true);

    const mutations: readonly ((f: ClassFixture) => void)[] = [
      (f) => {
        const next: StructTypeDef = { kind: "struct", name: "Box2", fields: [] };
        f.module.types.push(next);
        f.types.observeClass(f.declaration, "Box2", next);
      },
      (f) => {
        const cell = f.session.typeCellFor(f.classType) as { current: StructTypeDef | null };
        cell.current = null;
      },
      (f) => {
        (f.classType.fields as Array<StructTypeDef["fields"][number]>).push({
          name: "late",
          type: { kind: "i32" },
          mutable: true,
        });
      },
      (f) => {
        f.module.types.splice(f.module.types.indexOf(f.classType), 1);
      },
      (f) => f.types.planRetained(),
    ];
    mutations.forEach((mutate, index) => {
      const f = classFixture();
      const staged = stageClassBatch(f, `stale-class-${index}`);
      staged.scope.includeBinding(staged.classBindingId);
      mutate(f);
      const before = sessionState(f.session);
      expect(() => staged.scope.seal()).toThrowError(ProgramAbiInvariantError);
      expect(sessionState(f.session)).toEqual(before);
    });
  });

  it("rejects a foreign or missing class half-batch without publishing", () => {
    const target = classFixture();
    const foreign = classFixture();
    const foreignDescriptor = foreign.types.describePreparedClassLayouts(new Set([foreign.classRecord.id]));
    const before = sessionState(target.session);
    const foreignScope = target.session.beginPreparedComponentScope("foreign-class", [target.terminal.id]);
    expect(() =>
      foreignScope.stagePreparedComponentBatch({
        scopeId: "foreign-class",
        terminalUnitIds: [target.terminal.id],
        requestedStructuralReferenceKeys: [target.structuralKey],
        classLayouts: foreignDescriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    foreignScope.abort();
    expect(sessionState(target.session)).toEqual(before);

    const missingScope = target.session.beginPreparedComponentScope("missing-class", [target.terminal.id]);
    expect(() =>
      missingScope.stagePreparedComponentBatch({
        scopeId: "missing-class",
        terminalUnitIds: [target.terminal.id],
        requestedStructuralReferenceKeys: [target.structuralKey],
        callableImports: target.ctx.programAbiCallableImports?.describePrepared(new Set()),
      }),
    ).toThrowError(ProgramAbiInvariantError);
    missingScope.abort();
    expect(sessionState(target.session)).toEqual(before);
  });

  it.each(RUNTIME_TARGETS)(
    "keeps the sole ReferenceError requester transactional across an injected setter seal failure in %s",
    async (target) => {
      const fileName = `issue-4260-reference-error-${target}.ts`;
      const setters = exactAccessorUnits(EXACT_CLASS_SETTER_SOURCE, fileName);
      expect(setters, "exact class-setter terminal inventory").toHaveLength(1);
      const setter = setters[0]!;

      const directOptions = {
        fileName,
        target,
        experimentalIR: false,
        deferTopLevelInit: true,
        emitWat: true,
        hostBridge: target === "gc" ? ("always" as const) : ("off" as const),
        skipSemanticDiagnostics: true,
      };
      const preparedOptions = {
        ...directOptions,
        experimentalIR: true,
        trackIrOutcomes: true,
      };

      const direct = await compile(EXACT_CLASS_SETTER_SOURCE, directOptions);
      const prepared = await compile(EXACT_CLASS_SETTER_SOURCE, preparedOptions);
      const injected = await withPreparedSealFailure(`terminal:${setter.id}`, () =>
        compile(EXACT_CLASS_SETTER_SOURCE, preparedOptions),
      );

      for (const [label, result] of [
        ["direct", direct],
        ["prepared", prepared],
        ["injected", injected],
      ] as const) {
        expect(result.success, `${label}: ${result.errors.map(({ message }) => message).join("\n")}`).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        // The legacy inline body and the retained setter can each carry the
        // same canonical constructor call. B.7 cardinality is semantic:
        // exactOutcome() and the provider inventory below each require one
        // requester/component/provider, while this checks the physical chain.
        expect(referenceErrorCallChains(result), `${label}: canonical ReferenceError helper chain`).toEqual(
          target === "gc"
            ? [`__anonClass_0_set_value->${label === "prepared" ? "__new_ReferenceError" : "__throw_reference_error"}`]
            : ["__anonClass_0_set_value->__new_ReferenceError", "trigger->__new_ReferenceError"],
        );
      }

      expect(exactOutcome(prepared, setter.id)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irCompiledFuncs ?? []).toContain(setter.displayName);
      expect(exactOutcome(injected, setter.id)).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(exactOutcome(injected, setter.id)).not.toHaveProperty("preparedComponentId");
      expect(injected.irCompiledFuncs ?? []).not.toContain(setter.displayName);

      for (const result of [direct, prepared, injected]) {
        expect((await instantiateAndInitialize(result)).run!()).toBe(1);
      }

      const codegenOptions = {
        deferTopLevelInit: true,
        emitWat: true,
        hostBridge: target === "gc" ? ("always" as const) : ("off" as const),
        standalone: target === "standalone",
        nativeStrings: target === "standalone",
        skipSemanticDiagnostics: true,
      };
      const directGenerated = generateModule(analyzeSource(EXACT_CLASS_SETTER_SOURCE, fileName), {
        ...codegenOptions,
        experimentalIR: false,
      });
      const preparedGenerated = generateModule(analyzeSource(EXACT_CLASS_SETTER_SOURCE, fileName), {
        ...codegenOptions,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const injectedGenerated = await withPreparedSealFailure(`terminal:${setter.id}`, () =>
        generateModule(analyzeSource(EXACT_CLASS_SETTER_SOURCE, fileName), {
          ...codegenOptions,
          experimentalIR: true,
          trackIrOutcomes: true,
        }),
      );

      for (const [label, generated] of [
        ["direct", directGenerated],
        ["prepared", preparedGenerated],
        ["injected", injectedGenerated],
      ] as const) {
        const hardErrors = generated.errors.filter(({ severity }) => severity !== "warning");
        expect(hardErrors, `${label}: ${hardErrors.map(({ message }) => message).join("\n")}`).toEqual([]);
        expect(generated.irPostClaimErrors ?? []).toEqual([]);
      }

      expect(referenceErrorImportInventory(injected)).toEqual(referenceErrorImportInventory(direct));

      if (target === "gc") {
        expect(referenceErrorImportInventory(direct)).toEqual(["env.__throw_reference_error:function"]);
        expect(referenceErrorImportInventory(prepared)).toEqual(["env.__new_ReferenceError:function"]);
      } else {
        expect(referenceErrorImportInventory(prepared)).toEqual(referenceErrorImportInventory(direct));
        for (const result of [direct, prepared, injected]) {
          expect(result.imports, "standalone compiler import descriptors").toEqual([]);
          expect(result.hostImportSummary?.total ?? 0, "standalone host-import inventory").toBe(0);
          expect(importInventory(result), "standalone Wasm import section").toEqual([]);
          expect(referenceErrorDefinitionCount(result)).toBe(1);
        }
      }

      const directProviders = referenceErrorProviderInventory(directGenerated);
      const preparedProviders = referenceErrorProviderInventory(preparedGenerated);
      const injectedProviders = referenceErrorProviderInventory(injectedGenerated);
      expect(directProviders).toEqual([]);
      expect(preparedProviders).toHaveLength(1);
      expect(preparedProviders[0]).toMatchObject(
        target === "gc"
          ? {
              structuralReferenceKey: irCallableBindingKey(irRuntimeFuncRef("__new_ReferenceError").binding),
              slotPolicy: "alias",
              slotSpace: undefined,
              intent: { kind: "callable", origin: "runtime" },
              finalIndex: { space: "function" },
            }
          : {
              structuralReferenceKey: irCallableBindingKey(irRuntimeFuncRef("__new_ReferenceError").binding),
              slotPolicy: "required",
              slotSpace: "function",
              intent: { kind: "callable", origin: "runtime" },
              finalIndex: { space: "function" },
            },
      );
      if (target === "gc") {
        expect(injectedProviders).toEqual(directProviders);
      } else {
        // Standalone fallback materializes the same canonical in-module
        // constructor as Prepared; the retained row is one live provider,
        // not an extra aborted-component publication.
        expect(injectedProviders).toEqual(preparedProviders);
      }

      for (const generated of [directGenerated, preparedGenerated, injectedGenerated]) {
        expect(generated.module.functions.filter(({ name }) => name === "__new_ReferenceError")).toHaveLength(
          target === "standalone" ? 1 : 0,
        );
      }
    },
  );

  it.each(RUNTIME_TARGETS)(
    "aborts one exact %s component while its sibling commits the one shared string-slice provider",
    async (target) => {
      const fileName = `issue-4260-shared-provider-${target}.ts`;
      const { failed, healthy } = sharedProviderUnits(fileName);
      const selector = `terminal:${failed.id}`;
      const result = await withPreparedSealFailure(selector, () =>
        compile(SHARED_PROVIDER_SOURCE, {
          fileName,
          target,
          experimentalIR: true,
          trackIrOutcomes: true,
          deferTopLevelInit: true,
          hostBridge: "always",
          skipSemanticDiagnostics: true,
        }),
      );

      expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const failedOutcome = result.irOutcomes?.find(({ unitId }) => unitId === failed.id);
      const healthyOutcome = result.irOutcomes?.find(({ unitId }) => unitId === healthy.id);
      expect(failedOutcome).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(failedOutcome).not.toHaveProperty("preparedComponentId");
      expect(healthyOutcome).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      const exports = await instantiateAndInitialize(result);
      expect(exports.failed!()).toBe(2);
      expect(exports.healthy!()).toBe(3);

      const codegenOptions = {
        experimentalIR: true,
        trackIrOutcomes: true,
        deferTopLevelInit: true,
        hostBridge: "always" as const,
        standalone: target === "standalone",
        nativeStrings: target === "standalone",
      };
      const generated = await withPreparedSealFailure(selector, () =>
        generateModule(analyzeSource(SHARED_PROVIDER_SOURCE, fileName), codegenOptions),
      );
      const control = generateModule(analyzeSource(SHARED_PROVIDER_SOURCE, fileName), codegenOptions);
      for (const candidate of [generated, control]) {
        const hardErrors = candidate.errors.filter(({ severity }) => severity !== "warning");
        expect(hardErrors, hardErrors.map(({ message }) => message).join("\n")).toEqual([]);
        expect(candidate.programAbi).toBeDefined();
      }

      const providerSymbol = target === "standalone" ? "__str_slice" : "string_slice";
      const providerKey = irCallableBindingKey(irIntrinsicFuncRef(providerSymbol).binding);
      const providerProjection = (candidate: typeof generated) => {
        const entries = candidate
          .programAbi!.abi.entries()
          .filter(({ structuralReferenceKey }) => structuralReferenceKey === providerKey);
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        return {
          id: entry.id,
          structuralReferenceKey: entry.structuralReferenceKey,
          slotPolicy: entry.slotPolicy,
          intent: entry.intent,
          finalIndex: candidate.programAbi!.abi.resolveFinalIndex(entry.id),
        };
      };
      const injectedProvider = providerProjection(generated);
      expect(injectedProvider).toEqual(providerProjection(control));
      expect(injectedProvider.intent).toMatchObject({ kind: "callable", origin: "intrinsic" });
      expect(injectedProvider.finalIndex).toEqual(expect.objectContaining({ space: "function" }));

      if (target === "gc") {
        expect(
          generated.module.imports.filter(
            (entry) => entry.desc.kind === "func" && entry.module === "env" && entry.name === "string_slice",
          ),
        ).toHaveLength(1);
      } else {
        expect(generated.module.imports).toEqual([]);
        expect(generated.module.functions.filter(({ name }) => name === "__str_slice")).toHaveLength(1);
      }
    },
  );
});
