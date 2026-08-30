// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { catalogProgramAbiCallableImports } from "../src/codegen/program-abi-import-planning.js";
import {
  assertPreparedModuleCallableAliasDescriptorCurrent,
  describePreparedModuleCallableAliases,
  preparedModuleCallableAliasBindings,
} from "../src/codegen/program-abi-module-callable-alias-planning.js";
import { planProgramAbiUnitCallable } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  irCallableBindingKey,
  irRuntimeFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId, type IrBindingId, type IrUnitId } from "../src/ir/identity.js";
import type { IrFunction } from "../src/ir/nodes.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import { createEmptyModule, type Import, type WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({ kind: "func" as const, params: Object.freeze([]), results: Object.freeze([]) });

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
  const importerFile = ts.createSourceFile(
    "/repo/a-importer.ts",
    "export function first(): void {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const exporterFile = ts.createSourceFile(
    "/repo/z-exporter.ts",
    "export function second(): void {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([importerFile, exporterFile], { entrySource: exporterFile });
  const terminals = inventory.terminalUnits.filter(({ kind }) => kind === "top-level-function");
  if (terminals.length !== 2) throw new Error("invalid #3525 aggregate Program-ABI fixture");
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
  if (!imports || !providers) throw new Error("missing #3525 aggregate Program-ABI registries");
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

function moduleCallableAliasRecords(f: Fixture) {
  const importerSource = f.inventory.sources.find(({ originalFileName }) => originalFileName === "/repo/a-importer.ts");
  const exporterSource = f.inventory.sources.find(({ originalFileName }) => originalFileName === "/repo/z-exporter.ts");
  const terminal = f.terminals.find(({ sourceId }) => sourceId === exporterSource?.id);
  if (!importerSource || !exporterSource || !terminal) throw new Error("invalid module-alias source fixture");
  const rootFunction = f.sourceFunctions[f.terminals.indexOf(terminal)];
  if (!rootFunction) throw new Error("missing module-alias root allocator");
  const rootBindingId = irUnitCallableBindingId(terminal.id);
  const exportBindingId = createIrBindingId({
    ownerId: exporterSource.id,
    domain: "callable",
    role: "module-export-callable",
    ordinal: 0,
  });
  const importBindingId = createIrBindingId({
    ownerId: importerSource.id,
    domain: "callable",
    role: "module-import-callable",
    ordinal: 0,
  });
  return {
    terminal,
    rootFunction,
    rootBindingId,
    exportBindingId,
    importBindingId,
    importerSource,
    exporterSource,
    records: Object.freeze([
      Object.freeze({
        bindingId: rootBindingId,
        sourceId: exporterSource.id,
        declarationOrdinal: terminal.ordinal,
        bindingOrdinal: 0,
        kind: "source" as const,
        localName: terminal.displayName,
        targetBindingId: rootBindingId,
        canonicalBindingId: rootBindingId,
        targetUnitId: terminal.id,
      }),
      Object.freeze({
        bindingId: exportBindingId,
        sourceId: exporterSource.id,
        declarationOrdinal: terminal.ordinal,
        bindingOrdinal: 0,
        kind: "export-alias" as const,
        localName: "exported",
        targetBindingId: rootBindingId,
        canonicalBindingId: rootBindingId,
        targetUnitId: terminal.id,
      }),
      Object.freeze({
        bindingId: importBindingId,
        sourceId: importerSource.id,
        declarationOrdinal: terminal.ordinal,
        bindingOrdinal: 0,
        kind: "import-alias" as const,
        localName: "imported",
        targetBindingId: exportBindingId,
        canonicalBindingId: rootBindingId,
        targetUnitId: terminal.id,
      }),
    ]),
  };
}

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

describe("#3525 aggregate prepared Program-ABI publication", () => {
  it("keeps an opaque module alias chain invisible until the session commit", () => {
    const f = fixture();
    const aliases = moduleCallableAliasRecords(f);
    const descriptor = describePreparedModuleCallableAliases({
      session: f.session,
      records: aliases.records,
      terminalUnitIds: [aliases.terminal.id],
    });
    expect(descriptor).toBeDefined();
    const aliasBindings = preparedModuleCallableAliasBindings(descriptor!);
    expect(aliases.importerSource.order).toBeLessThan(aliases.exporterSource.order);
    expect(aliasBindings.map(({ record }) => record.kind)).toEqual(["export-alias", "import-alias"]);
    expect(aliasBindings.map(({ aliasOf }) => aliasOf)).toEqual([aliases.rootBindingId, aliases.exportBindingId]);
    expect(aliasBindings.every(({ draft }) => draft.slotPolicy === "alias")).toBe(true);

    const before = sessionState(f.session);
    const scope = f.session.beginPreparedComponentScope("module-aliases", [aliases.terminal.id]);
    scope.stagePreparedComponentBatch({
      scopeId: "module-aliases",
      terminalUnitIds: [aliases.terminal.id],
      requestedStructuralReferenceKeys: [],
      moduleCallableAliases: descriptor,
    });
    expect(sessionState(f.session)).toEqual(before);
    expect(scope.abi.get(aliases.exportBindingId)).toBeDefined();
    expect(scope.abi.get(aliases.importBindingId)).toBeDefined();
    expect(scope.abi.getLocator(aliases.importBindingId)).toBe(scope.abi.getLocator(aliases.rootBindingId));
    expect(scope.abi.locatorObject(aliases.importBindingId)).toBe(aliases.rootFunction);

    const pending = scope.prepareSeal();
    expect(sessionState(f.session)).toEqual(before);
    expect(f.session.getDraft(aliases.importBindingId)).toBeUndefined();
    const [sealed] = f.session.commitPreparedScopes([pending]);
    expect(sealed!.canonicalId(aliases.importBindingId)).toBe(aliases.rootBindingId);
    expect(f.session.getDraft(aliases.exportBindingId)).toMatchObject({
      slotPolicy: "alias",
      aliasOf: aliases.rootBindingId,
      intent: { origin: "module-alias", targetUnitId: aliases.terminal.id },
    });
    expect(f.session.getDraft(aliases.importBindingId)).toMatchObject({
      slotPolicy: "alias",
      aliasOf: aliases.exportBindingId,
      intent: { origin: "module-alias", targetUnitId: aliases.terminal.id },
    });
    expect(f.session.locatorObjectForBinding(aliases.rootBindingId)).toBe(aliases.rootFunction);
  });

  it("consumes a claimed module alias descriptor on scope abort", () => {
    const f = fixture();
    const aliases = moduleCallableAliasRecords(f);
    const descriptor = describePreparedModuleCallableAliases({
      session: f.session,
      records: aliases.records,
      terminalUnitIds: [aliases.terminal.id],
    });
    const before = sessionState(f.session);
    const scope = f.session.beginPreparedComponentScope("aborted-module-aliases", [aliases.terminal.id]);
    scope.stagePreparedComponentBatch({
      scopeId: "aborted-module-aliases",
      terminalUnitIds: [aliases.terminal.id],
      requestedStructuralReferenceKeys: [],
      moduleCallableAliases: descriptor,
    });
    scope.abort();
    expect(sessionState(f.session)).toEqual(before);
    expect(f.session.getDraft(aliases.exportBindingId)).toBeUndefined();
    expect(f.session.getDraft(aliases.importBindingId)).toBeUndefined();
    expect(() => assertPreparedModuleCallableAliasDescriptorCurrent(descriptor!)).toThrowError(/already consumed/);
    const replay = f.session.beginPreparedComponentScope("replayed-module-aliases", [aliases.terminal.id]);
    expect(() =>
      replay.stagePreparedComponentBatch({
        scopeId: "replayed-module-aliases",
        terminalUnitIds: [aliases.terminal.id],
        requestedStructuralReferenceKeys: [],
        moduleCallableAliases: descriptor,
      }),
    ).toThrowError(ProgramAbiInvariantError);
    replay.abort();
  });

  it("commits disjoint pending scopes while sharing one immutable provider dependency", () => {
    const f = fixture();
    const first = stageProviderBatch(f, "pending-first", 0);
    const second = stageProviderBatch(f, "pending-second", 1);
    first.scope.includeBinding(first.providerId);
    second.scope.includeBinding(second.providerId);
    const before = sessionState(f.session);
    const firstPending = first.scope.prepareSeal();
    const secondPending = second.scope.prepareSeal();
    expect(sessionState(f.session)).toEqual(before);

    const sealed = f.session.commitPreparedScopes([secondPending, firstPending]);
    expect(sealed.map(({ scopeId }) => scopeId)).toEqual(["pending-second", "pending-first"]);
    expect(f.session.getDraft(first.providerId)).toBeDefined();
    expect(f.session.getDraft(second.providerId)).toEqual(f.session.getDraft(first.providerId));
    const sharedReverse = sessionState(f.session).preparedScopeIdsByBindingId.find(
      ([id]) => id === first.providerId,
    )?.[1] as Set<string>;
    expect([...sharedReverse].sort()).toEqual(["pending-first", "pending-second"]);
    expect(
      (f.session as unknown as { readonly preparedScopes: ReadonlyMap<string, unknown> }).preparedScopes.size,
    ).toBe(2);
  });

  it("aborts every recognized pending scope when forged or duplicate tokens are mixed in", () => {
    const forgedFirst = fixture();
    const forgedFirstBefore = sessionState(forgedFirst.session);
    const forgedFirstRegistries = registryState(forgedFirst);
    const forgedFirstStaged = stageProviderBatch(forgedFirst, "forged-first");
    forgedFirstStaged.scope.includeBinding(forgedFirstStaged.providerId);
    const forgedFirstPending = forgedFirstStaged.scope.prepareSeal();
    const throwingProxy = new Proxy(
      { kind: "forged-pending-scope" },
      {
        get() {
          throw undefined;
        },
      },
    ) as unknown as Parameters<ProgramAbiSession["commitPreparedScopes"]>[0][number];
    expect(() => forgedFirst.session.commitPreparedScopes([throwingProxy, forgedFirstPending])).toThrow();
    expect(forgedFirstStaged.scope.publicationState).toBe("aborted");
    expect(sessionState(forgedFirst.session)).toEqual(forgedFirstBefore);
    expect(registryState(forgedFirst)).toEqual(forgedFirstRegistries);

    const validFirst = fixture();
    const validFirstBefore = sessionState(validFirst.session);
    const validFirstRegistries = registryState(validFirst);
    const validFirstStaged = stageProviderBatch(validFirst, "valid-first");
    validFirstStaged.scope.includeBinding(validFirstStaged.providerId);
    const validFirstPending = validFirstStaged.scope.prepareSeal();
    expect(() => validFirst.session.commitPreparedScopes([validFirstPending, throwingProxy])).toThrow();
    expect(validFirstStaged.scope.publicationState).toBe("aborted");
    expect(sessionState(validFirst.session)).toEqual(validFirstBefore);
    expect(registryState(validFirst)).toEqual(validFirstRegistries);

    const duplicate = fixture();
    const duplicateBefore = sessionState(duplicate.session);
    const duplicateRegistries = registryState(duplicate);
    const duplicateStaged = stageProviderBatch(duplicate, "duplicate-pending");
    duplicateStaged.scope.includeBinding(duplicateStaged.providerId);
    const duplicatePending = duplicateStaged.scope.prepareSeal();
    expect(() => duplicate.session.commitPreparedScopes([duplicatePending, duplicatePending])).toThrow(
      ProgramAbiInvariantError,
    );
    expect(duplicateStaged.scope.publicationState).toBe("aborted");
    expect(sessionState(duplicate.session)).toEqual(duplicateBefore);
    expect(registryState(duplicate)).toEqual(duplicateRegistries);
  });

  it("rejects a stale overlapping scope after an intervening scope claims its unit", () => {
    const f = fixture();
    const first = stageProviderBatch(f, "stale-overlap-first");
    const second = stageProviderBatch(f, "stale-overlap-second");
    first.scope.includeBinding(first.providerId);
    second.scope.includeBinding(second.providerId);
    const firstPending = first.scope.prepareSeal();
    const secondPending = second.scope.prepareSeal();

    f.session.commitPreparedScopes([secondPending]);
    const committed = sessionState(f.session);
    const committedRegistries = registryState(f);
    let rejection: unknown;
    try {
      f.session.commitPreparedScopes([firstPending]);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ProgramAbiInvariantError);
    expect(rejection).toMatchObject({ code: "duplicate-session-draft" });
    expect((rejection as Error).message).toContain(
      `prepared ABI terminal ${first.terminal.id} is already sealed by scope stale-overlap-second`,
    );
    expect(first.scope.publicationState).toBe("aborted");
    expect(sessionState(f.session)).toEqual(committed);
    expect(registryState(f)).toEqual(committedRegistries);
    expect(
      (
        f.session as unknown as { readonly preparedScopeByUnitId: ReadonlyMap<IrUnitId, string> }
      ).preparedScopeByUnitId.get(first.terminal.id),
    ).toBe("stale-overlap-second");
  });

  it("rebases a pending disjoint scope after an intervening immutable-provider commit", () => {
    const f = fixture();
    const importDescriptor = f.imports.describePrepared(new Set([f.runtimeImport]));
    f.imports.publishPreparedDescriptor(importDescriptor);
    const providerId = f.providers.planPrepared(new Set([f.providerKey])).get(f.providerKey);
    if (!providerId) throw new Error("missing preplanned immutable provider");

    const firstTerminal = f.terminals[0]!;
    const firstScope = f.session.beginPreparedComponentScope("rebase-first", [firstTerminal.id]);
    firstScope.includeBinding(providerId);
    const firstPending = firstScope.prepareSeal();

    const secondTerminal = f.terminals[1]!;
    const secondScope = f.session.beginPreparedComponentScope("rebase-second", [secondTerminal.id]);
    secondScope.includeBinding(providerId);
    const secondPending = secondScope.prepareSeal();
    f.session.commitPreparedScopes([secondPending]);

    const [sealed] = f.session.commitPreparedScopes([firstPending]);
    expect(sealed!.scopeId).toBe("rebase-first");
    expect(f.session.getDraft(providerId)).toBeDefined();
    const sharedReverse = sessionState(f.session).preparedScopeIdsByBindingId.find(
      ([id]) => id === providerId,
    )?.[1] as Set<string>;
    expect([...sharedReverse].sort()).toEqual(["rebase-first", "rebase-second"]);
  });
});
