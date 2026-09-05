// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import {
  catalogProgramAbiCallableImports,
  planProgramAbiCallableImports,
} from "../src/codegen/program-abi-import-planning.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irCallableBindingKey, irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { IR_STRING_COMPARE_FN } from "../src/ir/from-ast.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type Import,
  type WasmFunction,
  type WasmModule,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const F64_TO_F64: FuncTypeDef = {
  kind: "func",
  params: [{ kind: "f64" }],
  results: [{ kind: "f64" }],
};

function source(fileName = "/repo/entry.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, "export function main() {}", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function fixture(module: WasmModule) {
  const entryFile = source();
  const inventory = buildIrUnitInventory([entryFile], { entrySource: entryFile });
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
  ctx.numImportFuncs = module.imports.filter((value) => value.desc.kind === "func").length;
  const providers = ctx.programAbiCallableProviders;
  if (!providers) throw new Error("missing callable-provider registry");
  return { ctx, providers, session };
}

type CallableProviderRegistry = ReturnType<typeof fixture>["providers"];
type PreparedProviderDescriptor = ReturnType<CallableProviderRegistry["describePrepared"]>;
type CallableImportRegistry = NonNullable<ReturnType<typeof fixture>["ctx"]["programAbiCallableImports"]>;
type PreparedImportDescriptor = ReturnType<CallableImportRegistry["describePrepared"]>;

function sessionPublicationCardinalities(session: ProgramAbiSession) {
  const state = session as unknown as Record<string, ReadonlyMap<unknown, unknown>>;
  return [
    "drafts",
    "draftOrderOwners",
    "locators",
    "locatorOwners",
    "structuralReferenceKeys",
    "callableTypeContracts",
  ].map((key) => state[key]!.size);
}

function providerPublicationSnapshot(registry: CallableProviderRegistry, session: ProgramAbiSession) {
  const state = registry as unknown as {
    readonly observed: ReadonlyMap<string, unknown>;
    readonly observationOrder: readonly string[] | undefined;
    readonly appendedOrder: readonly string[];
    readonly plannedByKey: ReadonlyMap<string, unknown>;
    readonly plannedValue: ReadonlyMap<string, unknown> | undefined;
  };
  return {
    observedKeys: [...state.observed.keys()],
    observationOrder: state.observationOrder ? [...state.observationOrder] : null,
    appendedOrder: [...state.appendedOrder],
    plannedKeys: [...state.plannedByKey.keys()],
    plannedValueSize: state.plannedValue?.size ?? null,
    session: sessionPublicationCardinalities(session),
  };
}

function callableImportPublicationSnapshot(registry: CallableImportRegistry, session: ProgramAbiSession) {
  const state = registry as unknown as {
    readonly sealedEntries: readonly unknown[] | undefined;
    readonly plannedByImport: ReadonlyMap<Import, unknown>;
    readonly plannedValue: ReadonlyMap<string, unknown> | undefined;
  };
  return {
    sealedEntryCount: state.sealedEntries?.length ?? null,
    plannedImports: [...state.plannedByImport.keys()],
    plannedValueSize: state.plannedValue?.size ?? null,
    session: sessionPublicationCardinalities(session),
  };
}

function withoutProviderPublication<T>(
  registry: CallableProviderRegistry,
  session: ProgramAbiSession,
  action: () => T,
): T {
  const before = providerPublicationSnapshot(registry, session);
  try {
    return action();
  } finally {
    expect(providerPublicationSnapshot(registry, session)).toEqual(before);
  }
}

function describePreparedProvidersWithoutPublishing(
  registry: CallableProviderRegistry,
  session: ProgramAbiSession,
  keys: ReadonlySet<string>,
  exactImportDescriptor?: Parameters<CallableProviderRegistry["describePrepared"]>[1],
): PreparedProviderDescriptor {
  return withoutProviderPublication(registry, session, () => registry.describePrepared(keys, exactImportDescriptor));
}

function expectPreparedProviderFailureWithoutPublishing(
  registry: CallableProviderRegistry,
  session: ProgramAbiSession,
  action: () => unknown,
): void {
  expect(() => withoutProviderPublication(registry, session, action)).toThrowError(ProgramAbiInvariantError);
}

function functionImport(module: string, name: string, typeIdx: number): Import {
  return { module, name, desc: { kind: "func", typeIdx } };
}

function definedFunction(name: string, typeIdx: number): WasmFunction {
  return {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "f64.const", value: 0 }],
    exported: false,
  };
}

function definedProviderFixture(...names: readonly string[]) {
  const module = createEmptyModule();
  module.types.push(F64_TO_F64);
  const functions = names.map((name) => definedFunction(name, 0));
  module.functions.push(...functions);
  return { ...fixture(module), functions, module };
}

function observeRuntimeProvider(providers: CallableProviderRegistry, name: string, index: number): string {
  const ref = irRuntimeFuncRef(name);
  providers.observe(ref, index);
  return irCallableBindingKey(ref.binding);
}

function planForeignProviderOrder(session: ProgramAbiSession, derivedOrdinal: number, label: string) {
  const entrySource = session.inventory.sources.find(({ kind }) => kind === "entry")!;
  const id = createIrBindingId({
    ownerId: entrySource.id,
    domain: "callable",
    role: `foreign-${label}`,
    ordinal: derivedOrdinal,
  });
  session.plan({
    id,
    structuralOrder: session.structuralOrder.forSource(entrySource.id, {
      domain: "callable",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.callableProvider,
      derivedOrdinal,
    }),
    structuralReferenceKey: `foreign:${label}`,
    displayName: label,
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "runtime", signature: { params: [], results: [] } },
  });
  return id;
}

function sealedProviderSuffixFixture() {
  const result = definedProviderFixture("middle", "z-appended", "a-appended");
  const middleKey = observeRuntimeProvider(result.providers, "middle", 0);
  expect(result.providers.planPrepared(new Set())).toEqual(new Map());
  const sealedSnapshot = providerPublicationSnapshot(result.providers, result.session);
  const zKey = observeRuntimeProvider(result.providers, "z-appended", 1);
  const aKey = observeRuntimeProvider(result.providers, "a-appended", 2);
  return { ...result, aKey, middleKey, sealedSnapshot, zKey };
}

function providerFixture(reverseObservation: boolean) {
  const module = createEmptyModule();
  module.types.push(F64_TO_F64);
  const runtimeImport = functionImport("env", "Math_sin", 0);
  const intrinsicFunction = definedFunction("__fmod", 0);
  module.imports.push(runtimeImport);
  module.functions.push(intrinsicFunction);
  const { ctx, providers, session } = fixture(module);
  const runtimeRef = irRuntimeFuncRef("Math_sin", "__misleading_runtime_label");
  const intrinsicRef = irIntrinsicFuncRef("__fmod", "__misleading_intrinsic_label");

  const observations = reverseObservation
    ? ([
        [intrinsicRef, 1],
        [runtimeRef, 0],
      ] as const)
    : ([
        [runtimeRef, 0],
        [intrinsicRef, 1],
      ] as const);
  for (const [ref, index] of observations) providers.observe(ref, index);

  // Shift every prior function index without touching either provider object.
  const lateImport = functionImport("late", "before-providers", 0);
  module.imports.unshift(lateImport);
  ctx.numImportFuncs++;
  expect(providers.resolveCurrentIndex(irRuntimeFuncRef("Math_sin", "another-label"))).toBe(1);
  expect(providers.resolveCurrentIndex(irIntrinsicFuncRef("__fmod", "another-label"))).toBe(2);

  planProgramAbiCallableImports(ctx);
  const providerIds = providers.planRetained();
  const publication = session.publish(module);
  return {
    intrinsicFunction,
    intrinsicRef,
    module,
    providerIds,
    publication,
    runtimeImport,
    runtimeRef,
    session,
  };
}

describe("#3520 runtime/intrinsic callable-provider Program ABI", () => {
  it("tracks exact provider objects through shifts and plans deterministic provider identities", () => {
    const forward = providerFixture(false);
    const reverse = providerFixture(true);
    const runtimeKey = irCallableBindingKey(forward.runtimeRef.binding);
    const intrinsicKey = irCallableBindingKey(forward.intrinsicRef.binding);

    expect([...forward.providerIds]).toEqual([...reverse.providerIds]);
    expect([...forward.providerIds.keys()]).toEqual([intrinsicKey, runtimeKey].sort());

    const runtimeId = forward.providerIds.get(runtimeKey)!;
    const intrinsicId = forward.providerIds.get(intrinsicKey)!;
    expect(runtimeId).not.toBe(intrinsicId);
    expect(forward.session.getDraft(runtimeId)).toMatchObject({
      structuralReferenceKey: runtimeKey,
      displayName: "Math_sin",
      slotPolicy: "alias",
      intent: {
        kind: "callable",
        origin: "runtime",
      },
    });
    expect(forward.session.getDraft(intrinsicId)).toMatchObject({
      structuralReferenceKey: intrinsicKey,
      displayName: "__fmod",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "intrinsic",
      },
    });
    expect(forward.session.hasLocator(runtimeId)).toBe(false);
    expect(forward.session.hasLocator(intrinsicId, forward.intrinsicFunction)).toBe(true);
    expect(forward.publication.abi.resolveFinalIndex(runtimeId)).toEqual({ space: "function", index: 1 });
    expect(forward.publication.abi.resolveFinalIndex(intrinsicId)).toEqual({ space: "function", index: 2 });
    expect(forward.module.imports[1]).toBe(forward.runtimeImport);
    expect(forward.module.functions[0]).toBe(forward.intrinsicFunction);
  });

  it("makes one deterministic provider own a shared object and aliases every other semantic binding", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    const shared = definedFunction("shared-provider", 0);
    module.functions.push(shared);
    const { providers, session } = fixture(module);
    const runtimeRef = irRuntimeFuncRef("runtime-shared");
    const intrinsicRef = irIntrinsicFuncRef("intrinsic-shared");

    providers.observe(runtimeRef, 0);
    providers.observe(intrinsicRef, 0);
    const ids = providers.planRetained();
    const runtimeId = ids.get(irCallableBindingKey(runtimeRef.binding))!;
    const intrinsicId = ids.get(irCallableBindingKey(intrinsicRef.binding))!;
    const publication = session.publish(module);

    expect(session.hasLocator(intrinsicId, shared)).toBe(true);
    expect(session.hasLocator(runtimeId)).toBe(false);
    expect(publication.abi.canonicalId(runtimeId)).toBe(intrinsicId);
    expect(publication.abi.resolveFinalIndex(runtimeId)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(intrinsicId)).toEqual({ space: "function", index: 0 });
  });

  it("rejects one structural provider changing allocator ownership", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.functions.push(definedFunction("first", 0), definedFunction("second", 0));
    const { providers } = fixture(module);
    const ref = irRuntimeFuncRef("provider", "first-label");
    providers.observe(ref, 0);

    expect(() => providers.observe(irRuntimeFuncRef("provider", "second-label"), 1)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "callable-provider-mismatch" }),
    );
  });

  it("keeps an abandoned provider preview out of ordering and matches the unpreviewed control", () => {
    const run = (preview: boolean) => {
      const { module, providers, session } = definedProviderFixture("z-provider", "a-provider");
      const zKey = observeRuntimeProvider(providers, "z-provider", 0);
      const descriptor = preview
        ? describePreparedProvidersWithoutPublishing(providers, session, new Set([zKey]))
        : undefined;

      // If description had sealed the order, this lexically earlier provider
      // would be appended and the two runs would mint different ordinals.
      const aKey = observeRuntimeProvider(providers, "a-provider", 1);
      if (descriptor) {
        expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
          providers.publishPreparedDescriptor(descriptor),
        );
      }
      const ids = providers.planRetained();
      const entries = session.publish(module).abi.entries();
      return {
        ids: [...ids],
        entries,
        aOrdinal: session.getDraft(ids.get(aKey)!)?.structuralOrder.derivedOrdinal,
        zOrdinal: session.getDraft(ids.get(zKey)!)?.structuralOrder.derivedOrdinal,
      };
    };

    const previewed = run(true);
    const control = run(false);
    expect(previewed).toEqual(control);
    expect(previewed.aOrdinal).toBe(0);
    expect(previewed.zOrdinal).toBe(1);
    expect(previewed.ids).toHaveLength(2);
  });

  it("authenticates provider descriptors without changing provider or session state", () => {
    const target = definedProviderFixture("target");
    const targetKey = observeRuntimeProvider(target.providers, "target", 0);
    const descriptor = describePreparedProvidersWithoutPublishing(
      target.providers,
      target.session,
      new Set([targetKey]),
    );
    const forged = Object.freeze({ kind: "prepared-callable-provider-descriptor" }) as PreparedProviderDescriptor;

    const foreign = definedProviderFixture("foreign");
    const foreignKey = observeRuntimeProvider(foreign.providers, "foreign", 0);
    const foreignDescriptor = describePreparedProvidersWithoutPublishing(
      foreign.providers,
      foreign.session,
      new Set([foreignKey]),
    );

    for (const candidate of [forged, foreignDescriptor]) {
      expectPreparedProviderFailureWithoutPublishing(target.providers, target.session, () =>
        target.providers.assertPreparedDescriptorCurrent(candidate),
      );
      expectPreparedProviderFailureWithoutPublishing(target.providers, target.session, () =>
        target.providers.publishPreparedDescriptor(candidate),
      );
    }
    target.providers.assertPreparedDescriptorCurrent(descriptor);
  });

  it("rejects occupied prepared-provider order slots without sealing and tolerates unrelated order", () => {
    {
      const { providers, session } = definedProviderFixture("selected");
      const key = observeRuntimeProvider(providers, "selected", 0);
      planForeignProviderOrder(session, 0, "before-provider-description");
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.describePrepared(new Set([key])),
      );
    }

    {
      const { providers, session } = definedProviderFixture("selected");
      const key = observeRuntimeProvider(providers, "selected", 0);
      const descriptor = describePreparedProvidersWithoutPublishing(providers, session, new Set([key]));
      planForeignProviderOrder(session, 0, "after-provider-description");
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.assertPreparedDescriptorCurrent(descriptor),
      );
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.publishPreparedDescriptor(descriptor),
      );
    }

    {
      const { functions, providers, session } = definedProviderFixture("selected");
      const key = observeRuntimeProvider(providers, "selected", 0);
      const descriptor = describePreparedProvidersWithoutPublishing(providers, session, new Set([key]));
      const foreignId = planForeignProviderOrder(session, 1, "unrelated-provider-order");
      const beforeCurrentness = providerPublicationSnapshot(providers, session);
      providers.assertPreparedDescriptorCurrent(descriptor);
      expect(providerPublicationSnapshot(providers, session)).toEqual(beforeCurrentness);
      const ids = providers.publishPreparedDescriptor(descriptor);
      expect(session.getDraft(foreignId)?.structuralOrder.derivedOrdinal).toBe(1);
      expect(session.hasLocator(ids.get(key)!, functions[0])).toBe(true);
    }
  });

  it("freezes the sorted provider prefix and retains the appended discovery-order suffix", () => {
    const { aKey, middleKey, providers, sealedSnapshot, session, zKey } = sealedProviderSuffixFixture();
    expect(sealedSnapshot).toMatchObject({
      observationOrder: [middleKey],
      appendedOrder: [],
      plannedKeys: [],
    });
    const descriptor = describePreparedProvidersWithoutPublishing(providers, session, new Set([middleKey, zKey, aKey]));
    const beforeCurrentness = providerPublicationSnapshot(providers, session);
    providers.assertPreparedDescriptorCurrent(descriptor);
    expect(providerPublicationSnapshot(providers, session)).toEqual(beforeCurrentness);
    const ids = providers.publishPreparedDescriptor(descriptor);

    expect(session.getDraft(ids.get(middleKey)!)?.structuralOrder.derivedOrdinal).toBe(0);
    expect(session.getDraft(ids.get(zKey)!)?.structuralOrder.derivedOrdinal).toBe(1);
    expect(session.getDraft(ids.get(aKey)!)?.structuralOrder.derivedOrdinal).toBe(2);
    expect(providerPublicationSnapshot(providers, session)).toMatchObject({
      observationOrder: [middleKey],
      appendedOrder: [zKey, aKey],
      plannedKeys: [middleKey, zKey, aKey],
    });
  });

  it("rejects an appended suffix reorder and provider contract drift without publishing", () => {
    {
      const { providers, session } = definedProviderFixture("present");
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.describePrepared(new Set([irCallableBindingKey(irRuntimeFuncRef("missing").binding)])),
      );
    }

    {
      const { aKey, middleKey, providers, session, zKey } = sealedProviderSuffixFixture();
      const descriptor = describePreparedProvidersWithoutPublishing(
        providers,
        session,
        new Set([middleKey, zKey, aKey]),
      );
      const state = providers as unknown as { readonly appendedOrder: string[] };
      state.appendedOrder.reverse();
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.publishPreparedDescriptor(descriptor),
      );
    }

    const mutations: readonly [string, (module: WasmModule, providers: CallableProviderRegistry) => void][] = [
      ["removed locator", (module) => (module.functions = [])],
      ["replaced locator", (module) => (module.functions[0] = definedFunction("replacement", 0))],
      ["changed signature", (module) => (module.functions[0]!.typeIdx = 1)],
      [
        "changed structural key",
        (_module, providers) => {
          const state = providers as unknown as {
            readonly observed: Map<string, { readonly structuralReferenceKey: string }>;
          };
          const [key, row] = [...state.observed.entries()][0]!;
          state.observed.set(key, Object.freeze({ ...row, structuralReferenceKey: `${key}|drift` }));
        },
      ],
    ];
    for (const [, mutate] of mutations) {
      const { module, providers, session } = definedProviderFixture("selected");
      module.types.push({ kind: "func", params: [{ kind: "i32" }], results: [] });
      const key = observeRuntimeProvider(providers, "selected", 0);
      const descriptor = describePreparedProvidersWithoutPublishing(providers, session, new Set([key]));
      mutate(module, providers);
      expectPreparedProviderFailureWithoutPublishing(providers, session, () =>
        providers.publishPreparedDescriptor(descriptor),
      );
    }
  });

  it("closes every same-locator sibling and rejects a sibling discovered after description", () => {
    const positive = definedProviderFixture("shared");
    const shared = positive.functions[0]!;
    const runtimeRef = irRuntimeFuncRef("runtime-shared");
    const intrinsicRef = irIntrinsicFuncRef("intrinsic-shared");
    const runtimeKey = irCallableBindingKey(runtimeRef.binding);
    const intrinsicKey = irCallableBindingKey(intrinsicRef.binding);
    positive.providers.observe(runtimeRef, 0);
    positive.providers.observe(intrinsicRef, 0);
    const descriptor = describePreparedProvidersWithoutPublishing(
      positive.providers,
      positive.session,
      new Set([runtimeKey]),
    );
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(positive.module.types[0])).toBe(false);
    positive.module.imports.unshift(functionImport("late", "index-shift", 0));
    positive.ctx.numImportFuncs++;
    const beforeIndexShiftCheck = providerPublicationSnapshot(positive.providers, positive.session);
    positive.providers.assertPreparedDescriptorCurrent(descriptor);
    expect(providerPublicationSnapshot(positive.providers, positive.session)).toEqual(beforeIndexShiftCheck);
    const ids = positive.providers.publishPreparedDescriptor(descriptor);
    expect([...ids.keys()].sort()).toEqual([intrinsicKey, runtimeKey].sort());
    const canonicalKey = [intrinsicKey, runtimeKey].sort()[0]!;
    const aliasKey = canonicalKey === intrinsicKey ? runtimeKey : intrinsicKey;
    expect(positive.session.hasLocator(ids.get(canonicalKey)!, shared)).toBe(true);
    expect(positive.session.getDraft(ids.get(aliasKey)!)).toMatchObject({
      slotPolicy: "alias",
      aliasOf: ids.get(canonicalKey),
    });

    const control = definedProviderFixture("shared");
    control.providers.observe(runtimeRef, 0);
    control.providers.observe(intrinsicRef, 0);
    control.module.imports.unshift(functionImport("late", "index-shift", 0));
    control.ctx.numImportFuncs++;
    const compatibilityIds = control.providers.planPrepared(new Set([runtimeKey]));
    expect([...ids]).toEqual([...compatibilityIds]);
    const retained = control.providers.planRetained();
    const retainedSnapshot = providerPublicationSnapshot(control.providers, control.session);
    expect(control.providers.planPrepared(new Set([runtimeKey])).get(runtimeKey)).toBe(retained.get(runtimeKey));
    expect(providerPublicationSnapshot(control.providers, control.session)).toEqual(retainedSnapshot);
    expect(positive.session.publish(positive.module).abi.entries()).toEqual(
      control.session.publish(control.module).abi.entries(),
    );

    const stale = definedProviderFixture("shared");
    stale.providers.observe(runtimeRef, 0);
    const staleDescriptor = describePreparedProvidersWithoutPublishing(
      stale.providers,
      stale.session,
      new Set([runtimeKey]),
    );
    stale.providers.observe(intrinsicRef, 0);
    expectPreparedProviderFailureWithoutPublishing(stale.providers, stale.session, () =>
      stale.providers.publishPreparedDescriptor(staleDescriptor),
    );
  });

  it("requires the exact provisional import owner and rejects its locator drift", () => {
    const createImportBackedFixture = () => {
      const module = createEmptyModule();
      module.types.push(F64_TO_F64);
      const targetImport = functionImport("env", "runtime_target", 0);
      const siblingImport = functionImport("env", "sibling", 0);
      module.imports.push(targetImport, siblingImport);
      const result = fixture(module);
      const key = observeRuntimeProvider(result.providers, "runtime_target", 0);
      catalogProgramAbiCallableImports(result.ctx);
      const imports = result.ctx.programAbiCallableImports;
      if (!imports) throw new Error("missing callable-import registry");
      return { ...result, imports, key, module, siblingImport, targetImport };
    };

    const positive = createImportBackedFixture();
    const forgedImportDescriptor = Object.freeze({
      kind: "prepared-callable-import-descriptor",
    }) as PreparedImportDescriptor;
    expectPreparedProviderFailureWithoutPublishing(positive.providers, positive.session, () =>
      positive.providers.describePrepared(new Set([positive.key]), forgedImportDescriptor),
    );
    const foreign = createImportBackedFixture();
    const foreignImportDescriptor = foreign.imports.describePrepared(new Set([foreign.targetImport]));
    expectPreparedProviderFailureWithoutPublishing(positive.providers, positive.session, () =>
      positive.providers.describePrepared(new Set([positive.key]), foreignImportDescriptor),
    );
    expectPreparedProviderFailureWithoutPublishing(positive.providers, positive.session, () =>
      positive.providers.describePrepared(new Set([positive.key])),
    );
    const wrongImportBefore = callableImportPublicationSnapshot(positive.imports, positive.session);
    const wrongImportDescriptor = positive.imports.describePrepared(new Set([positive.siblingImport]));
    expect(callableImportPublicationSnapshot(positive.imports, positive.session)).toEqual(wrongImportBefore);
    expectPreparedProviderFailureWithoutPublishing(positive.providers, positive.session, () =>
      positive.providers.describePrepared(new Set([positive.key]), wrongImportDescriptor),
    );
    const importBefore = callableImportPublicationSnapshot(positive.imports, positive.session);
    const importDescriptor = positive.imports.describePrepared(new Set([positive.targetImport]));
    expect(callableImportPublicationSnapshot(positive.imports, positive.session)).toEqual(importBefore);
    const providerDescriptor = describePreparedProvidersWithoutPublishing(
      positive.providers,
      positive.session,
      new Set([positive.key]),
      importDescriptor,
    );
    positive.imports.publishPreparedDescriptor(importDescriptor);
    const importId = positive.imports.preparedDescriptorBindingId(importDescriptor, positive.targetImport)!;
    const providerIds = positive.providers.publishPreparedDescriptor(providerDescriptor);
    const providerId = providerIds.get(positive.key)!;
    expect(positive.session.getDraft(providerId)).toMatchObject({
      slotPolicy: "alias",
      aliasOf: importId,
    });
    expect(positive.session.hasLocator(importId, positive.targetImport)).toBe(true);
    expect(positive.session.hasLocator(providerId)).toBe(false);

    const stale = createImportBackedFixture();
    const staleImportBefore = callableImportPublicationSnapshot(stale.imports, stale.session);
    const staleImportDescriptor = stale.imports.describePrepared(new Set([stale.targetImport]));
    expect(callableImportPublicationSnapshot(stale.imports, stale.session)).toEqual(staleImportBefore);
    const staleProviderDescriptor = describePreparedProvidersWithoutPublishing(
      stale.providers,
      stale.session,
      new Set([stale.key]),
      staleImportDescriptor,
    );
    stale.module.imports[0] = functionImport("env", "runtime_target", 0);
    expectPreparedProviderFailureWithoutPublishing(stale.providers, stale.session, () =>
      stale.providers.publishPreparedDescriptor(staleProviderDescriptor),
    );
  });

  it("discards a dead import observed only by an IR candidate that later withdrew", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.imports.push(functionImport("env", "__candidate_only", 0));
    const { ctx, providers, session } = fixture(module);
    const ref = irRuntimeFuncRef("__candidate_only");
    providers.observe(ref, 0);

    // Mirror dead-import elimination after the candidate's body is withdrawn:
    // no final Wasm body refers to this import, so it is absent from the
    // retained callable population and must not become a required ABI entry.
    module.imports = [];
    ctx.numImportFuncs = 0;
    expect(planProgramAbiCallableImports(ctx).size).toBe(0);
    expect(providers.planRetained().size).toBe(0);
    expect(session.publish(module).abi.entries()).toEqual([]);
  });

  it("prepares a required defined provider without retaining a withdrawn candidate import", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.imports.push(functionImport("env", "__candidate_only", 0));
    const fmod = definedFunction("__fmod", 0);
    module.functions.push(fmod);
    const { ctx, providers, session } = fixture(module);
    const deadRef = irRuntimeFuncRef("__candidate_only");
    const fmodRef = irIntrinsicFuncRef("__fmod");
    const deadKey = irCallableBindingKey(deadRef.binding);
    const fmodKey = irCallableBindingKey(fmodRef.binding);
    providers.observe(deadRef, 0);
    providers.observe(fmodRef, 1);

    expect(providers.canPlanPrepared(new Set([deadKey]))).toBe(false);
    expect(providers.canPlanPrepared(new Set([fmodKey]))).toBe(true);
    const prepared = providers.planPrepared(new Set([fmodKey]));
    expect([...prepared.keys()]).toEqual([fmodKey]);
    expect(session.hasLocator(prepared.get(fmodKey)!, fmod)).toBe(true);
    const lateRef = irRuntimeFuncRef("__late_provider");
    const lateKey = irCallableBindingKey(lateRef.binding);
    expect(providers.observe(lateRef, 1)).toBe(1);

    module.imports = [];
    ctx.numImportFuncs = 0;
    expect(planProgramAbiCallableImports(ctx).size).toBe(0);
    expect([...providers.planRetained().keys()].sort()).toEqual([fmodKey, lateKey].sort());
    expect(session.publish(module).abi.resolveFinalIndex(prepared.get(fmodKey)!)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("aliases a prepared import-backed provider to its canonical import while discarding a dead sibling", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    const deadImport = functionImport("env", "__candidate_only", 0);
    const targetImport = functionImport("env", "runtime_target", 0);
    module.imports.push(deadImport, targetImport);
    const { ctx, providers, session } = fixture(module);
    const deadRef = irRuntimeFuncRef("__candidate_only");
    const targetRef = irRuntimeFuncRef("runtime_target");
    const deadKey = irCallableBindingKey(deadRef.binding);
    const targetKey = irCallableBindingKey(targetRef.binding);
    providers.observe(deadRef, 0);
    providers.observe(targetRef, 1);

    catalogProgramAbiCallableImports(ctx);
    const providerImports = providers.importsForPreparedProviders(new Set([targetKey]));
    if (!providerImports || !ctx.programAbiCallableImports) throw new Error("missing prepared import population");
    ctx.programAbiCallableImports.planPrepared(providerImports);
    expect(providers.canPlanPrepared(new Set([targetKey]))).toBe(true);
    const providerId = providers.planPrepared(new Set([targetKey])).get(targetKey)!;
    const importId = session.locatorBindingId(targetImport)!;
    expect(session.getDraft(providerId)).toMatchObject({
      structuralReferenceKey: targetKey,
      slotPolicy: "alias",
      aliasOf: importId,
      intent: { kind: "callable", origin: "runtime" },
    });
    expect(session.getDraft(importId)).toMatchObject({
      slotPolicy: "required",
      intent: { kind: "callable", origin: "import" },
    });

    module.imports = [targetImport];
    ctx.numImportFuncs = 1;
    planProgramAbiCallableImports(ctx);
    expect([...providers.planRetained().keys()]).toEqual([targetKey]);
    expect(session.bindingIdsForStructuralReference(deadKey)).toEqual([]);
    const { abi } = session.publish(module);
    expect(abi.canonicalId(providerId)).toBe(importId);
    expect(abi.resolveFinalIndex(providerId)).toEqual({ space: "function", index: 0 });
  });

  it("publishes production Math and remainder providers without compatibility labels owning their slots", () => {
    const ast = analyzeSource(
      `
        export function main(a: number, b: number): number {
          return Math.sin(a) + (a % b);
        }
      `,
      "callable-provider-abi.ts",
    );
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("main");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    for (const ref of [irIntrinsicFuncRef("math.sin"), irIntrinsicFuncRef("__fmod")]) {
      const key = irCallableBindingKey(ref.binding);
      const entries = result.programAbi!.abi.entries().filter((entry) => entry.structuralReferenceKey === key);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({
        structuralReferenceKey: key,
        displayName: ref.binding.symbol,
        intent: {
          kind: "callable",
          origin: ref.binding.kind,
        },
      });
      const finalIndex = result.programAbi!.abi.resolveFinalIndex(entry.id);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
    }
  });

  it("binds one string-compare intrinsic to the mode-selected import or definition", () => {
    const sourceText = `
      export function main(left: string, right: string): boolean {
        return left < right;
      }
    `;
    const host = generateModule(analyzeSource(sourceText, "provider-host.ts"), {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const native = generateModule(analyzeSource(sourceText, "provider-native.ts"), {
      experimentalIR: true,
      nativeStrings: true,
      trackIrOutcomes: true,
    });
    for (const result of [host, native]) {
      const hardErrors = result.errors.filter((error) => error.severity !== "warning");
      expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
      expect(result.irCompiledFuncs).toContain("main");
      expect(result.irPostClaimErrors).toEqual([]);
    }

    const key = irCallableBindingKey(irIntrinsicFuncRef(IR_STRING_COMPARE_FN, "misleading-label").binding);
    const hostEntry = host.programAbi!.abi.entries().find((entry) => entry.structuralReferenceKey === key);
    const nativeEntry = native.programAbi!.abi.entries().find((entry) => entry.structuralReferenceKey === key);
    expect(hostEntry).toMatchObject({
      displayName: IR_STRING_COMPARE_FN,
      slotPolicy: "alias",
      intent: { kind: "callable", origin: "intrinsic" },
    });
    expect(nativeEntry).toMatchObject({
      displayName: IR_STRING_COMPARE_FN,
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic" },
    });

    const hostIndex = host.programAbi!.abi.resolveFinalIndex(hostEntry!.id);
    const nativeIndex = native.programAbi!.abi.resolveFinalIndex(nativeEntry!.id);
    expect(hostIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(nativeIndex).toEqual(expect.objectContaining({ space: "function" }));
    if (!hostIndex || hostIndex.space !== "function" || !nativeIndex || nativeIndex.space !== "function") {
      throw new Error("missing mode-selected string compare provider");
    }
    const hostImport = host.module.imports.filter((value) => value.desc.kind === "func")[hostIndex.index];
    const nativeImportCount = native.module.imports.filter((value) => value.desc.kind === "func").length;
    const nativeFunction = native.module.functions[nativeIndex.index - nativeImportCount];
    expect(hostImport).toMatchObject({ module: "env", name: "string_compare", desc: { kind: "func" } });
    expect(nativeFunction?.name).toBe("__str_compare");
  });
});
