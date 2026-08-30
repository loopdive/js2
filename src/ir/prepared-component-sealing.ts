// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt } from "../codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../codegen/program-abi-planning.js";
import { irClassTypeRef, irTypeBindingKey } from "./abi-bindings.js";
import { irCallableBindingKey, irRuntimeFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import type { IrBindingId, IrClassId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrFunction } from "./nodes.js";
import type { IrIntegrationDiagnosticVisibility } from "./integration-report.js";
import { IrInvariantError, IrUnsupportedError, PreparedProgramAbiCommitError } from "./outcomes.js";
import type { PreparedComponentModuleCallableAliasDescriptor } from "./prepared-component-publication.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentAbiEntry,
  type PreparedComponentDependencyEvidence,
  type PreparedComponentDependencyFailure,
  type PreparedComponentDependencyReport,
  type PreparedInstructionSupportSidecars,
} from "./prepared-component-dependencies.js";
import { ProgramAbiInvariantError } from "./program-abi.js";
import type { ProgramAbiDerivedUnitRecord, ProgramAbiSlotSpace } from "./program-abi.js";
import type { Import, WasmFunction } from "./types.js";

type PreparedProgramAbiScopeTransaction = ReturnType<
  NonNullable<CodegenContext["programAbiSession"]>["beginPreparedComponentScope"]
>;

/**
 * Exact operations required by detached IR lowering.  Keep this adapter in
 * the sealing boundary so a Program-ABI lookup rename has one integration
 * point.  The aggregate lane validates all members at runtime before giving
 * the lookup to a resolver; it never falls back to the live session.
 */
export interface PreparedComponentScopeLookup {
  get(id: IrBindingId): PreparedComponentAbiEntry | undefined;
  bindingIdsForStructuralReference(key: string): readonly IrBindingId[];
  getLocator(id: IrBindingId): object | undefined;
  resolveCurrentIndex(id: IrBindingId, expectedSpace: ProgramAbiSlotSpace, structuralReferenceKey: string): number;
  currentCallableSignature(id: IrBindingId): PreparedComponentCallableContract | undefined;
  currentCallableContract(id: IrBindingId): PreparedComponentCallableContract | undefined;
  locatorObject(id: IrBindingId): object | undefined;
  locatorObjectForBinding(id: IrBindingId): object | undefined;
}

/** Opaque structural callable contract exposed only for validation seams. */
export interface PreparedComponentCallableContract {
  readonly params: readonly unknown[];
  readonly results: readonly unknown[];
}

export interface PreparedComponentOpenScope {
  readonly componentId: string;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly scope: PreparedProgramAbiScopeTransaction;
  readonly lookup: PreparedComponentScopeLookup;
}

export interface PreparedComponentSealingResult {
  readonly componentIds: ReadonlyMap<IrUnitId, string>;
  readonly openScopes: readonly PreparedComponentOpenScope[];
  readonly abortOpenScopes: () => void;
}

function assertPreparedComponentScopeLookup(lookup: PreparedComponentScopeLookup, componentId: string): void {
  for (const operation of [
    "get",
    "bindingIdsForStructuralReference",
    "getLocator",
    "resolveCurrentIndex",
    "currentCallableSignature",
    "locatorObject",
  ] as const) {
    if (typeof lookup[operation] !== "function") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared component ${componentId} ABI overlay is missing exact ${operation} lookup support`,
      );
    }
  }
}

export interface PreparedComponentArtifactEntry {
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly fn: IrFunction;
  readonly derivedUnit?: ProgramAbiDerivedUnitRecord;
  readonly classMember?: boolean;
  readonly moduleInit?: boolean;
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

type PreparedSealFailureSelector =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "component"; readonly value: string }
  | { readonly kind: "terminal"; readonly value: IrUnitId };

interface PreparedComponentBatchDescription {
  readonly requestedStructuralReferenceKeys: readonly string[];
  readonly callableImports?: ReturnType<NonNullable<CodegenContext["programAbiCallableImports"]>["describePrepared"]>;
  readonly callableProviders?: ReturnType<
    NonNullable<CodegenContext["programAbiCallableProviders"]>["describePrepared"]
  >;
  readonly classLayouts?: ReturnType<NonNullable<CodegenContext["programAbiTypes"]>["describePreparedClassLayouts"]>;
  readonly exportAliases?: ReturnType<NonNullable<CodegenContext["programAbiExports"]>["describePrepared"]>;
  /** Opaque module-callable-alias descriptor staged with the same scope. */
  readonly moduleCallableAliases?: PreparedComponentModuleCallableAliasDescriptor;
}

class InjectedPreparedComponentSealFailure extends Error {
  constructor(readonly componentId: string) {
    super(`injected prepared ABI seal failure for ${componentId}`);
    this.name = "InjectedPreparedComponentSealFailure";
  }
}

export type PreparedComponentSealFailureHandler = (
  terminalUnitId: IrUnitId,
  error: IrUnsupportedError,
  diagnosticVisibility?: IrIntegrationDiagnosticVisibility,
) => void;

function parsePreparedSealFailureSelector(
  value: string | undefined,
  envName = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE",
): PreparedSealFailureSelector {
  if (value === undefined) return Object.freeze({ kind: "none" });
  if (value === "1") return Object.freeze({ kind: "all" });
  const separator = value.indexOf(":");
  const kind = separator < 0 ? "" : value.slice(0, separator);
  const target = separator < 0 ? "" : value.slice(separator + 1);
  if (target.length > 0 && kind === "component") return Object.freeze({ kind, value: target });
  if (target.length > 0 && kind === "terminal") {
    return Object.freeze({ kind, value: target as IrUnitId });
  }
  throw new IrInvariantError(
    "selection-preparation-mismatch",
    "resolve",
    `invalid ${envName} selector ${JSON.stringify(value)}`,
  );
}

function resolvePreparedSealFailureTargets(
  selector: PreparedSealFailureSelector,
  report: PreparedComponentDependencyReport,
): ReadonlySet<string> {
  if (selector.kind === "none") return new Set();
  if (report.components.length === 0) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared seal failure selector matched no component",
    );
  }
  if (selector.kind === "all") return new Set(report.components.map(({ id }) => id));
  const matches = report.components.filter((component) =>
    selector.kind === "component"
      ? component.id === selector.value
      : component.terminalUnitIds.includes(selector.value),
  );
  if (matches.length !== 1) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `prepared seal failure selector ${selector.kind}:${selector.value} matched ${matches.length} components`,
    );
  }
  return new Set([matches[0]!.id]);
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
    for (const name of ["__typeof_number", "__unbox_number"] as const) {
      if (!dependencyKeys.has(irCallableBindingKey(irRuntimeFuncRef(name).binding))) continue;
      const index = ctx.funcMap.get(name);
      const helper = index === undefined ? undefined : definedFuncAt(ctx, index);
      if (helper) targets.add(helper);
    }
    return ctx.programAbiExports?.describePrepared(targets);
  };
  if (component.status === "complete") {
    const exportAliases = describeExportAliases();
    return exportAliases
      ? Object.freeze({ requestedStructuralReferenceKeys: Object.freeze([]), exportAliases })
      : undefined;
  }
  if (component.status !== "blocked" || component.failures.length === 0) return undefined;
  const importRegistry = ctx.programAbiCallableImports;
  const providerRegistry = ctx.programAbiCallableProviders;
  const typeRegistry = ctx.programAbiTypes;
  const selectedImports = new Set<Import>();
  const selectedProviderKeys = new Set<string>();
  const selectedClassIds = new Set<IrClassId>();
  const requestedKeys = new Set<string>();

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
    const uniqueFailureRequests = new Set(
      component.failures.map((failure) => {
        const classId = preparableClassLayoutId(ctx, classIdByBindingId, failure);
        if (classId !== undefined) {
          const record = ctx.programAbiSession!.inventory.classes.find(({ id }) => id === classId)!;
          return irTypeBindingKey(irClassTypeRef(classId, record.displayName).binding);
        }
        return failure.structuralReferenceKey!;
      }),
    );
    if (uniqueFailureRequests.size !== requestedStructuralReferenceKeys.length) return undefined;
  }
  return Object.freeze({
    requestedStructuralReferenceKeys,
    ...(exactImports ? { callableImports: exactImports } : {}),
    ...(exactProviders ? { callableProviders: exactProviders } : {}),
    ...(exactClasses ? { classLayouts: exactClasses } : {}),
    ...(exportAliases ? { exportAliases } : {}),
  });
}

function assertOverlaidComponent(
  expected: PreparedComponentDependencyEvidence,
  report: PreparedComponentDependencyReport,
  batch: PreparedComponentBatchDescription,
): PreparedComponentDependencyEvidence {
  if (report.components.length !== 1) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `prepared component ${expected.id} rederived as ${report.components.length} components through its ABI overlay`,
    );
  }
  const actual = report.components[0]!;
  if (
    actual.id !== expected.id ||
    actual.terminalUnitIds.length !== expected.terminalUnitIds.length ||
    actual.terminalUnitIds.some((id, index) => id !== expected.terminalUnitIds[index]) ||
    actual.status !== "complete"
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `prepared component ${expected.id} did not reach the identical complete overlaid fixed point`,
      actual.failures,
    );
  }
  const requestedKeys = new Set(batch.requestedStructuralReferenceKeys);
  for (const key of requestedKeys) {
    if (!actual.abiDependencies.some((dependency) => dependency.structuralReferenceKey === key)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared component ${expected.id} did not resolve staged request ${key}`,
      );
    }
  }
  const preexistingDependencies = new Set(expected.abiDependencies.map(({ bindingId }) => bindingId));
  const requestedCanonicalIds = new Set(
    actual.abiDependencies
      .filter(({ structuralReferenceKey }) => requestedKeys.has(structuralReferenceKey))
      .map(({ canonicalBindingId }) => canonicalBindingId),
  );
  for (const dependency of actual.abiDependencies) {
    if (
      !preexistingDependencies.has(dependency.bindingId) &&
      !requestedKeys.has(dependency.structuralReferenceKey) &&
      !requestedCanonicalIds.has(dependency.canonicalBindingId)
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared component ${expected.id} acquired unrelated overlaid dependency ${dependency.bindingId}`,
      );
    }
  }
  return actual;
}

function includePreparedDependencies(
  scope: PreparedProgramAbiScopeTransaction,
  component: PreparedComponentDependencyEvidence,
  explicitBindingIds: Iterable<IrBindingId> = [],
): void {
  const includedBindingIds = new Set<IrBindingId>();
  const includeBinding = (bindingId: IrBindingId): void => {
    if (includedBindingIds.has(bindingId)) return;
    scope.includeBinding(bindingId);
    includedBindingIds.add(bindingId);
  };
  const requestedDependencies = new Map<IrBindingId, typeof component.abiDependencies>();
  for (const dependency of component.abiDependencies) {
    if (
      dependency.borrowing === undefined &&
      !["external-callable", "external-global", "class-layout", "support"].includes(dependency.kind)
    ) {
      continue;
    }
    requestedDependencies.set(dependency.bindingId, [
      ...(requestedDependencies.get(dependency.bindingId) ?? []),
      dependency,
    ]);
  }
  for (const [bindingId, dependencies] of requestedDependencies) {
    const borrowed = dependencies.filter((dependency) => dependency.borrowing !== undefined);
    if (borrowed.length === 0) {
      includeBinding(bindingId);
      continue;
    }
    if (borrowed.length !== dependencies.length) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared component ${component.id} mixes borrowed and owned evidence for ${bindingId}`,
      );
    }
    const consumerUnitIds = [...new Set(borrowed.map(({ ownerUnitId }) => ownerUnitId))];
    const first = borrowed[0]!.borrowing!;
    if (borrowed.some(({ borrowing }) => borrowing?.kind !== first.kind)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared component ${component.id} has incompatible borrow proofs for ${bindingId}`,
      );
    }
    if (first.kind === "nested-accessor-class-layout") {
      scope.includeBorrowedBinding(bindingId, { kind: first.kind, consumerUnitIds });
    } else if (first.kind === "class-setter-writeback-global") {
      if (
        borrowed.some(
          ({ borrowing }) =>
            borrowing?.kind !== first.kind || borrowing.dynamicCarrierBindingId !== first.dynamicCarrierBindingId,
        )
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `prepared component ${component.id} has incompatible dynamic-carrier proofs for ${bindingId}`,
        );
      }
      scope.includeBorrowedBinding(bindingId, {
        kind: first.kind,
        consumerUnitIds,
        dynamicCarrierBindingId: first.dynamicCarrierBindingId,
      });
    } else {
      if (
        borrowed.some(
          ({ borrowing }) =>
            borrowing?.kind !== first.kind || borrowing.valueGlobalBindingId !== first.valueGlobalBindingId,
        )
      ) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `prepared component ${component.id} has incompatible TDZ proofs for ${bindingId}`,
        );
      }
      scope.includeBorrowedBinding(bindingId, {
        kind: first.kind,
        consumerUnitIds,
        valueGlobalBindingId: first.valueGlobalBindingId,
      });
    }
    includedBindingIds.add(bindingId);
  }
  for (const bindingId of explicitBindingIds) includeBinding(bindingId);
}

export function sealDependencyCompletePreparedComponents(
  input: PreparedInstructionSupportSidecars & {
    readonly ctx: CodegenContext;
    readonly entries: readonly PreparedComponentArtifactEntry[];
    readonly inventory: IrUnitInventory;
    readonly atomicTerminalPopulation?: boolean;
    readonly callableImports: ReadonlyMap<string, Import>;
    readonly preparedBindingIdsByTerminalUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
    readonly deferPublication?: boolean;
    readonly preparedModuleCallableAliasDescriptor?: PreparedComponentModuleCallableAliasDescriptor;
    readonly onSealFailure: PreparedComponentSealFailureHandler;
  },
): ReadonlyMap<IrUnitId, string> {
  return prepareDependencyCompletePreparedComponents(input).componentIds;
}

/**
 * Prepare dependency-complete scopes.  Ordinary callers use the map-only
 * wrapper above; aggregate callers request `deferPublication` and retain the
 * authenticated open scope for detached body publication.
 */
export function prepareDependencyCompletePreparedComponents(
  input: PreparedInstructionSupportSidecars & {
    readonly ctx: CodegenContext;
    readonly entries: readonly PreparedComponentArtifactEntry[];
    readonly inventory: IrUnitInventory;
    readonly atomicTerminalPopulation?: boolean;
    readonly callableImports: ReadonlyMap<string, Import>;
    readonly preparedBindingIdsByTerminalUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
    readonly deferPublication?: boolean;
    readonly preparedModuleCallableAliasDescriptor?: PreparedComponentModuleCallableAliasDescriptor;
    readonly onSealFailure: PreparedComponentSealFailureHandler;
  },
): PreparedComponentSealingResult {
  const { ctx, entries, inventory } = input;
  const session = ctx.programAbiSession;
  const failureSelector = parsePreparedSealFailureSelector(process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE);
  const internalErrorSelector = parsePreparedSealFailureSelector(
    process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_INTERNAL_ERROR,
    "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_INTERNAL_ERROR",
  );
  if (!session) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared-component sealing requires one production ProgramAbiSession",
    );
  }
  const terminalUnitIds = new Set(entries.map((entry) => entry.terminalOwnerUnitId));
  const callableAllocatorsByArtifactUnitId = new Map<IrUnitId, WasmFunction>();
  for (const entry of entries) {
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
    const bindingId = planProgramAbiUnitCallable(ctx, { ref: irUnitFuncRef(entry.fn), signature, func });
    if (bindingId !== irUnitCallableBindingId(entry.artifactUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency preparation could not plan the exact callable for artifact ${entry.artifactUnitId}`,
      );
    }
    callableAllocatorsByArtifactUnitId.set(entry.artifactUnitId, func);
  }

  const derivedUnits = [
    ...new Map(
      entries.flatMap((entry) => (entry.derivedUnit ? ([[entry.derivedUnit.id, entry.derivedUnit]] as const) : [])),
    ).values(),
  ];
  const committedAbi: Pick<PreparedComponentScopeLookup, "get" | "bindingIdsForStructuralReference"> = Object.freeze({
    get: (id: IrBindingId) => session.getDraft(id),
    bindingIdsForStructuralReference: (key: string) => session.bindingIdsForStructuralReference(key),
  });
  const derive = (
    candidateTerminalUnitIds: ReadonlySet<IrUnitId>,
    abi: Pick<PreparedComponentScopeLookup, "get" | "bindingIdsForStructuralReference"> = committedAbi,
  ): PreparedComponentDependencyReport =>
    derivePreparedComponentDependencies({
      module: { functions: entries.map((entry) => entry.fn) },
      terminalUnitIds: candidateTerminalUnitIds,
      ...(input.atomicTerminalPopulation ? { atomicTerminalPopulation: true } : {}),
      inventory,
      derivedUnits,
      ...(input.closureSupport ? { closureSupport: input.closureSupport } : {}),
      exceptionSupportPrepared: ctx.exnTagIdx >= 0,
      ...(input.classAccessorWritebacks ? { classAccessorWritebacks: input.classAccessorWritebacks } : {}),
      ...(input.dynamicInstructionSupport ? { dynamicInstructionSupport: input.dynamicInstructionSupport } : {}),
      abi,
    });
  const candidateTerminalUnitIds = new Set(terminalUnitIds);
  const classIdByBindingId = new Map(
    inventory.classes.map((record) => [irClassTypeRef(record.id, record.displayName).binding.bindingId, record.id]),
  );
  let report = derive(candidateTerminalUnitIds);
  const injectedComponentIds = resolvePreparedSealFailureTargets(failureSelector, report);
  const injectedInternalErrorComponentIds = resolvePreparedSealFailureTargets(internalErrorSelector, report);
  const componentIdByTerminalUnitId = new Map<IrUnitId, string>();
  const openScopes: PreparedComponentOpenScope[] = [];
  while (candidateTerminalUnitIds.size > 0) {
    const component = report.components[0];
    if (!component) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared dependency report omitted remaining candidate terminals",
      );
    }
    const describedBatch = describePreparedComponentBatch(
      ctx,
      component,
      entries,
      callableAllocatorsByArtifactUnitId,
      input.callableImports,
      classIdByBindingId,
    );
    const batch =
      input.preparedModuleCallableAliasDescriptor !== undefined
        ? {
            ...(describedBatch ?? { requestedStructuralReferenceKeys: Object.freeze([]) }),
            moduleCallableAliases: input.preparedModuleCallableAliasDescriptor,
          }
        : describedBatch;
    let failure: IrUnsupportedError | undefined;
    let diagnosticVisibility: IrIntegrationDiagnosticVisibility = "report";
    try {
      const scope = session.beginPreparedComponentScope(component.id, component.terminalUnitIds);
      let sealStarted = false;
      try {
        let sealedComponent = component;
        if (batch) {
          scope.stagePreparedComponentBatch({
            scopeId: component.id,
            terminalUnitIds: component.terminalUnitIds,
            requestedStructuralReferenceKeys: batch.requestedStructuralReferenceKeys,
            ...(batch.callableImports ? { callableImports: batch.callableImports } : {}),
            ...(batch.callableProviders ? { callableProviders: batch.callableProviders } : {}),
            ...(batch.classLayouts ? { classLayouts: batch.classLayouts } : {}),
            ...(batch.exportAliases ? { exportAliases: batch.exportAliases } : {}),
            ...(batch.moduleCallableAliases ? { moduleCallableAliases: batch.moduleCallableAliases } : {}),
          });
          sealedComponent = assertOverlaidComponent(
            component,
            derive(new Set(component.terminalUnitIds), scope.abi),
            batch,
          );
        } else if (component.status !== "complete") {
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
        includePreparedDependencies(
          scope,
          sealedComponent,
          component.terminalUnitIds.flatMap((terminalUnitId) => [
            ...(input.preparedBindingIdsByTerminalUnitId?.get(terminalUnitId) ?? []),
          ]),
        );
        if (injectedInternalErrorComponentIds.has(component.id)) {
          throw new Error(`injected internal prepared ABI seal error for ${component.id}`);
        }
        if (injectedComponentIds.has(component.id)) {
          throw new InjectedPreparedComponentSealFailure(component.id);
        }
        if (input.deferPublication) {
          const lookup = scope.abi as PreparedComponentScopeLookup;
          assertPreparedComponentScopeLookup(lookup, component.id);
          openScopes.push({
            componentId: component.id,
            terminalUnitIds: Object.freeze([...component.terminalUnitIds]),
            scope,
            lookup,
          });
        } else {
          sealStarted = true;
          scope.seal();
        }
      } catch (error) {
        if (!sealStarted) scope.abort();
        throw error;
      }
      for (const terminalUnitId of component.terminalUnitIds) {
        componentIdByTerminalUnitId.set(terminalUnitId, component.id);
      }
    } catch (error) {
      if (
        error instanceof PreparedProgramAbiCommitError ||
        error instanceof IrInvariantError ||
        error instanceof ProgramAbiInvariantError
      ) {
        throw error;
      }
      if (error instanceof InjectedPreparedComponentSealFailure) {
        diagnosticVisibility = "outcome-only";
        failure = new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          `dependency-complete component ${component.id} failed ABI sealing`,
          error,
        );
      } else if (error instanceof IrUnsupportedError) {
        failure = error;
      } else {
        throw error;
      }
    }
    if (failure) {
      for (const terminalUnitId of component.terminalUnitIds) {
        input.onSealFailure(terminalUnitId, failure, diagnosticVisibility);
      }
    }
    for (const terminalUnitId of component.terminalUnitIds) {
      candidateTerminalUnitIds.delete(terminalUnitId);
    }
    report = derive(candidateTerminalUnitIds);
  }
  return {
    componentIds: componentIdByTerminalUnitId,
    openScopes: Object.freeze(openScopes),
    abortOpenScopes: () => {
      for (const open of openScopes) open.scope.abort();
    },
  };
}
