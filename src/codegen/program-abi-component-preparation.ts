// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import { NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS } from "./any-helpers.js";
import { definedFuncAt } from "./func-space.js";
import {
  describeProgramAbiUnitCallable,
  planProgramAbiUnitCallable,
  type ProgramAbiUnitCallablePlan,
} from "./program-abi-planning.js";
import { describePreparedUnitCallables } from "./program-abi-unit-callable-preparation.js";
import { describePreparedSupportTypes } from "./program-abi-support-type-preparation.js";
import type { PreparedComponentCandidateDemand } from "../ir/program/component-candidate-demand.js";
import type { PreparedComponentAbiLookup } from "../ir/program/abi-lookup.js";
import type {
  PreparedComponentArtifactEntry,
  PreparedComponentBatchDescription,
} from "../ir/prepared-component-sealing.js";
import type { PreparedComponentModuleCallableAliasDescriptor } from "../ir/prepared-component-publication.js";
import type {
  PreparedComponentDependencyEvidence,
  PreparedComponentDependencyFailure,
} from "../ir/prepared-component-dependencies.js";
import { irClassTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import {
  irCallableBindingKey,
  irRuntimeFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../ir/callable-bindings.js";
import type { IrBindingId, IrClassId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import { IrInvariantError, IrUnsupportedError } from "../ir/outcomes.js";
import { IR_UNDEFINED_VALUE_FN } from "../ir/undefined-value-provider.js";
import type { Import, WasmFunction } from "../ir/types.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

function fail(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", detail);
}

function exactPopulation<T>(actual: readonly T[], expected: readonly T[], label: string): void {
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((id) => !actual.includes(id))
  )
    fail(`candidate ${label} population mismatch`);
}

function preparableClassLayoutId(
  ctx: CodegenContext,
  classIdByBindingId: ReadonlyMap<IrBindingId, IrClassId>,
  failure: PreparedComponentDependencyFailure,
): IrClassId | undefined {
  if (failure.code !== "unplanned-abi-binding" || failure.bindingId === undefined) return undefined;
  const classId = classIdByBindingId.get(failure.bindingId);
  return classId !== undefined && ctx.programAbiTypes?.canPrepareClassLayout(classId) === true ? classId : undefined;
}

function describePreparedComponentBatch(
  ctx: CodegenContext,
  component: PreparedComponentDependencyEvidence,
  entries: readonly PreparedComponentArtifactEntry[],
  callableAllocatorsByArtifactUnitId: ReadonlyMap<IrUnitId, WasmFunction>,
  callableImports: ReadonlyMap<string, Import>,
  classIdByBindingId: ReadonlyMap<IrBindingId, IrClassId>,
): PreparedComponentBatchDescription | undefined {
  const describeExportAliases = (preparedAllocatorTargets: Iterable<object> = []) => {
    const terminalIds = new Set(component.terminalUnitIds);
    const targets = new Set<object>();
    for (const { artifactUnitId, terminalOwnerUnitId } of entries) {
      if (!terminalIds.has(terminalOwnerUnitId)) continue;
      const allocator = callableAllocatorsByArtifactUnitId.get(artifactUnitId);
      if (allocator === undefined) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `prepared component ${component.id} lost callable allocator ${artifactUnitId} before export description`,
        );
      }
      targets.add(allocator);
    }
    for (const dependency of component.abiDependencies) {
      for (const bindingId of [dependency.bindingId, dependency.canonicalBindingId]) {
        const allocator = ctx.programAbiSession?.locatorObjectForBinding(bindingId);
        if (allocator !== undefined) targets.add(allocator);
      }
    }
    for (const allocator of preparedAllocatorTargets) targets.add(allocator);
    const dependencyKeys = new Set([
      ...component.abiDependencies.map(({ structuralReferenceKey }) => structuralReferenceKey),
      ...component.failures.flatMap(({ structuralReferenceKey }) =>
        structuralReferenceKey === undefined ? [] : [structuralReferenceKey],
      ),
    ]);
    for (const name of NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS) {
      if (!dependencyKeys.has(irCallableBindingKey(irRuntimeFuncRef(name).binding))) continue;
      const index = ctx.funcMap.get(name);
      const helper = index === undefined ? undefined : definedFuncAt(ctx, index);
      if (helper) targets.add(helper);
    }
    return ctx.programAbiExports?.describePrepared(targets);
  };
  // A committed binding closes dependency discovery, not resource authentication.
  // Retain the ordinary descriptor for each actual undefined consumer so its
  // allocator/resource checks survive deferred sealing and final commit.
  const undefinedKey = irCallableBindingKey(irRuntimeFuncRef(IR_UNDEFINED_VALUE_FN).binding);
  const consumedProviderKeys = new Set(
    component.externalCallables
      .filter(({ structuralReferenceKey }) => structuralReferenceKey === undefinedKey)
      .map(({ structuralReferenceKey }) => structuralReferenceKey),
  );
  if (component.status === "complete" && consumedProviderKeys.size === 0) {
    const exportAliases = describeExportAliases();
    return exportAliases
      ? Object.freeze({ requestedStructuralReferenceKeys: Object.freeze([]), exportAliases })
      : undefined;
  }
  if (component.status !== "complete" && (component.status !== "blocked" || component.failures.length === 0))
    return undefined;
  const importRegistry = ctx.programAbiCallableImports;
  const providerRegistry = ctx.programAbiCallableProviders;
  const typeRegistry = ctx.programAbiTypes;
  const selectedImports = new Set<Import>();
  const selectedProviderKeys = new Set(consumedProviderKeys);
  const selectedClassIds = new Set<IrClassId>();
  // Requests include authenticated reuse; do not fabricate unplanned failures
  // or change a complete component's dependency evidence to select a descriptor.
  const requestedKeys = new Set(consumedProviderKeys);
  if (consumedProviderKeys.size > 0) {
    const providerImports = providerRegistry?.importsForPreparedProviders(consumedProviderKeys);
    if (providerImports === undefined) fail("undefined consumers lost their authenticated provider reservation");
    for (const imported of providerImports) selectedImports.add(imported);
  }

  for (const failure of component.failures) {
    const classId = preparableClassLayoutId(ctx, classIdByBindingId, failure);
    if (classId !== undefined) {
      if (!typeRegistry) return undefined;
      const classRecord = ctx.programAbiSession?.inventory.classes.find(({ id }) => id === classId);
      if (!classRecord) return undefined;
      selectedClassIds.add(classId);
      requestedKeys.add(irTypeBindingKey(irClassTypeRef(classId, classRecord.displayName).binding));
      continue;
    }
    const key = failure.structuralReferenceKey;
    if (failure.code !== "unplanned-abi-binding" || key === undefined) return undefined;
    const imported = callableImports.get(key);
    const providerImports = providerRegistry?.importsForPreparedProviders(new Set([key]));
    if (imported === undefined && providerImports === undefined) return undefined;
    requestedKeys.add(key);
    if (imported) selectedImports.add(imported);
    if (providerImports) {
      selectedProviderKeys.add(key);
      for (const providerImport of providerImports) selectedImports.add(providerImport);
    }
  }

  if (selectedImports.size > 0 && !importRegistry) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared callable dependencies require one canonical callable-import registry",
    );
  }
  if (selectedProviderKeys.size > 0 && !providerRegistry) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared callable dependencies require one canonical callable-provider registry",
    );
  }
  const exactImports =
    selectedImports.size === 0
      ? undefined
      : importRegistry!.describePrepared(
          new Set(
            [...selectedImports].sort((left, right) => {
              const leftIndex = ctx.mod.imports.indexOf(left);
              const rightIndex = ctx.mod.imports.indexOf(right);
              return leftIndex - rightIndex;
            }),
          ),
        );
  const exactProviders =
    selectedProviderKeys.size === 0
      ? undefined
      : providerRegistry!.describePrepared(new Set([...selectedProviderKeys].sort()), exactImports);
  const exactClasses =
    selectedClassIds.size === 0
      ? undefined
      : typeRegistry!.describePreparedClassLayouts(new Set([...selectedClassIds].sort()));
  if (!exactImports && !exactProviders && !exactClasses) return undefined;
  const preparedExportTargets = new Set<object>(selectedImports);
  if (exactProviders) {
    for (const allocator of providerRegistry!.preparedDescriptorAllocatorObjects(exactProviders)) {
      preparedExportTargets.add(allocator);
    }
  }
  const exportAliases = describeExportAliases(preparedExportTargets);
  const requestedStructuralReferenceKeys = Object.freeze([...requestedKeys].sort());
  if (requestedStructuralReferenceKeys.length !== component.failures.length) {
    // Multiple identical failures are valid evidence, but the complete blocker
    // set must still project to one exact structural request per dependency.
    const uniqueDependencyRequests = new Set([
      ...consumedProviderKeys,
      ...component.failures.map((failure) => {
        const classId = preparableClassLayoutId(ctx, classIdByBindingId, failure);
        if (classId !== undefined) {
          const record = ctx.programAbiSession!.inventory.classes.find(({ id }) => id === classId)!;
          return irTypeBindingKey(irClassTypeRef(classId, record.displayName).binding);
        }
        return failure.structuralReferenceKey!;
      }),
    ]);
    if (uniqueDependencyRequests.size !== requestedStructuralReferenceKeys.length) return undefined;
  }
  return Object.freeze({
    requestedStructuralReferenceKeys,
    ...(exactImports ? { callableImports: exactImports } : {}),
    ...(exactProviders ? { callableProviders: exactProviders } : {}),
    ...(exactClasses ? { classLayouts: exactClasses } : {}),
    ...(exportAliases ? { exportAliases } : {}),
  });
}

function collectCallableCandidates(
  ctx: CodegenContext,
  session: ProgramAbiSession,
  entries: readonly PreparedComponentArtifactEntry[],
) {
  const callableAllocatorsByArtifactUnitId = new Map<IrUnitId, WasmFunction>();
  const callablePlans = new Map<IrUnitId, ProgramAbiUnitCallablePlan>();
  const callableContributions = new Map<IrBindingId, NonNullable<ReturnType<typeof describeProgramAbiUnitCallable>>>();
  const seen = new Set<IrUnitId>();
  for (const entry of entries) {
    const record =
      session.inventory.allUnits.find((unit) => unit.id === entry.artifactUnitId) ??
      session.registeredDerivedUnit(entry.artifactUnitId);
    if (
      !record ||
      record.terminalOwnerId !== entry.terminalOwnerUnitId ||
      entry.fn.unitId !== entry.artifactUnitId ||
      seen.has(entry.artifactUnitId)
    ) {
      fail("candidate callable has a missing, foreign or duplicate artifact");
    }
    seen.add(entry.artifactUnitId);
    const terminalUnitId = entry.terminalOwnerUnitId;
    const isTerminal = entry.artifactUnitId === terminalUnitId && !entry.derivedUnit;
    const func = isTerminal
      ? (() => {
          const funcIdx = entry.moduleInit
            ? ctx.programAbiModuleInitCallables?.handleForUnit(terminalUnitId)
            : entry.classMember
              ? ctx.programAbiClassCallables?.handleForUnit(terminalUnitId)
              : ctx.programAbiSourceCallables?.handleForUnit(terminalUnitId);
          return funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
        })()
      : ctx.irUnitFuncMap.get(entry.artifactUnitId);
    const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
    if (!func || !signature || signature.kind !== "func") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency preparation has no exact allocated callable for artifact ${entry.artifactUnitId}`,
      );
    }
    const plan = { ref: irUnitFuncRef(entry.fn), signature, func };
    const contribution = describeProgramAbiUnitCallable(ctx, plan);
    if (!contribution || contribution.draft.id !== irUnitCallableBindingId(entry.artifactUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency preparation could not plan the exact callable for artifact ${entry.artifactUnitId}`,
      );
    }
    if (isTerminal || entry.classMember || entry.moduleInit) {
      // Retained source allocator reservations predate this candidate and
      // remain authoritative for direct fallback and class-member lookup.
      planProgramAbiUnitCallable(ctx, plan);
    } else {
      callablePlans.set(entry.artifactUnitId, plan);
      callableContributions.set(contribution.draft.id, contribution);
    }
    callableAllocatorsByArtifactUnitId.set(entry.artifactUnitId, func);
  }

  return { callableAllocatorsByArtifactUnitId, callablePlans, callableContributions };
}

/** Session-bound migration adapter; all allocator observation stays in the backend. */
export class ProgramAbiComponentPreparation {
  constructor(
    private readonly session: ProgramAbiSession,
    private readonly ctx: CodegenContext,
  ) {
    this.assertContext(ctx);
  }

  assertContext(ctx: CodegenContext): void {
    if (ctx !== this.ctx || ctx.programAbiSession !== this.session)
      fail("component candidates crossed contexts or sessions");
    this.session.assertModule(ctx.mod);
  }

  observeCallables(entries: readonly PreparedComponentArtifactEntry[], inventory: IrUnitInventory) {
    this.assertContext(this.ctx);
    if (inventory !== this.session.inventory) fail("component candidates crossed inventories");
    return new ProgramAbiComponentCandidates(this, this.ctx, this.session, entries);
  }
}

/** One sealing attempt's existing candidate snapshots, never a publishing registry. */
class ProgramAbiComponentCandidates {
  private readonly entries: readonly PreparedComponentArtifactEntry[];
  private readonly callables: ReturnType<typeof collectCallableCandidates>;
  private support: ReturnType<NonNullable<CodegenContext["programAbiTypes"]>["provisionalSupportTypes"]> | undefined;

  constructor(
    private readonly owner: ProgramAbiComponentPreparation,
    private readonly ctx: CodegenContext,
    private readonly session: ProgramAbiSession,
    entries: readonly PreparedComponentArtifactEntry[],
  ) {
    this.entries = Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
    this.callables = collectCallableCandidates(ctx, session, this.entries);
  }

  /** Called after the existing dynamic-support preparation, preserving observation order. */
  observeDependencies(): {
    readonly abi: Required<Pick<PreparedComponentAbiLookup, "get" | "bindingIdsForStructuralReference">>;
    readonly supportAbi: PreparedComponentAbiLookup;
  } {
    this.owner.assertContext(this.ctx);
    if (this.support !== undefined) fail("component support candidates already observed");
    this.support = this.ctx.programAbiTypes?.provisionalSupportTypes() ?? [];
    const support = new Map(this.support.map((binding) => [binding.draft.id, binding]));
    if (support.size !== this.support.length) fail("duplicate support candidates");
    const callables = this.callables.callableContributions;
    return Object.freeze({
      abi: Object.freeze({
        get: (id: IrBindingId) => this.session.getDraft(id) ?? callables.get(id)?.draft ?? support.get(id)?.draft,
        bindingIdsForStructuralReference: (key: string) => [
          ...new Set([
            ...this.session.bindingIdsForStructuralReference(key),
            ...[...callables.values(), ...support.values()]
              .filter((binding) => binding.structuralReferenceKey === key)
              .map((binding) => binding.draft.id),
          ]),
        ],
      }),
      supportAbi: Object.freeze({ get: (id: IrBindingId) => support.get(id)?.draft }),
    });
  }

  describe(
    component: PreparedComponentDependencyEvidence,
    demand: PreparedComponentCandidateDemand,
    callableImports: ReadonlyMap<string, Import>,
    moduleCallableAliases?: PreparedComponentModuleCallableAliasDescriptor,
  ): PreparedComponentBatchDescription | undefined {
    this.owner.assertContext(this.ctx);
    const { candidatePlans, supportIds } = this.select(component, demand);
    const classIdByBindingId = new Map(
      this.session.inventory.classes.map((record) => [
        irClassTypeRef(record.id, record.displayName).binding.bindingId,
        record.id,
      ]),
    );
    const described = describePreparedComponentBatch(
      this.ctx,
      component,
      this.entries,
      this.callables.callableAllocatorsByArtifactUnitId,
      callableImports,
      classIdByBindingId,
    );
    const dependencyBatch =
      moduleCallableAliases !== undefined
        ? { ...(described ?? { requestedStructuralReferenceKeys: Object.freeze([]) }), moduleCallableAliases }
        : described;
    if (!dependencyBatch && component.status !== "complete") {
      const detail =
        component.failures.length === 0
          ? "dependency discovery returned no failure evidence"
          : component.failures.map((item) => `${item.code}: ${item.detail}`).join("; ");
      throw new IrUnsupportedError(
        "late-preparation-unsupported",
        "resolve",
        `prepared component ${component.id} has incomplete dependencies: ${detail}`,
        component.failures,
      );
    }
    if (candidatePlans.length === 0 && supportIds.length === 0) return dependencyBatch;
    return {
      ...(dependencyBatch ?? { requestedStructuralReferenceKeys: Object.freeze([]) }),
      ...(candidatePlans.length > 0
        ? {
            unitCallables: describePreparedUnitCallables(this.ctx, component.terminalUnitIds, candidatePlans),
          }
        : {}),
      ...(supportIds.length > 0
        ? {
            supportTypes: describePreparedSupportTypes(this.ctx, component.terminalUnitIds, supportIds),
          }
        : {}),
    };
  }

  private select(component: PreparedComponentDependencyEvidence, demand: PreparedComponentCandidateDemand) {
    if (!this.support) fail("component support candidates not observed");
    if (!component.id || demand.componentId !== component.id) fail("candidate component identity mismatch");
    const knownTerminals = new Set(this.entries.map((entry) => entry.terminalOwnerUnitId));
    if (component.terminalUnitIds.length === 0 || component.terminalUnitIds.some((id) => !knownTerminals.has(id)))
      fail("candidate component has foreign terminals");
    exactPopulation(component.terminalUnitIds, [...new Set(component.terminalUnitIds)], "component terminals");
    exactPopulation(demand.terminalUnitIds, component.terminalUnitIds, "terminal");
    exactPopulation(
      component.functionUnitIds,
      this.entries
        .filter((entry) => component.terminalUnitIds.includes(entry.terminalOwnerUnitId))
        .map((entry) => entry.artifactUnitId),
      "component artifacts",
    );
    const expectedEntries = this.entries.filter(
      (entry) =>
        component.terminalUnitIds.includes(entry.terminalOwnerUnitId) &&
        (entry.artifactUnitId !== entry.terminalOwnerUnitId || entry.derivedUnit) &&
        !entry.classMember &&
        !entry.moduleInit,
    );
    const callableIds = expectedEntries.map((entry) => irUnitCallableBindingId(entry.artifactUnitId));
    const supportCandidates = new Set(this.support.map((binding) => binding.draft.id));
    const supportIds = [
      ...new Set(
        component.abiDependencies.flatMap((dependency) =>
          [dependency.bindingId, dependency.canonicalBindingId].filter((id) => supportCandidates.has(id)),
        ),
      ),
    ];
    exactPopulation(demand.callableBindingIds, callableIds, "callable binding");
    exactPopulation(demand.supportBindingIds, supportIds, "support binding");
    const candidatePlans = expectedEntries.map((entry) => {
      const plan = this.callables.callablePlans.get(entry.artifactUnitId);
      if (!plan) fail("missing derived callable candidate");
      return plan;
    });
    return { candidatePlans, supportIds };
  }
}
