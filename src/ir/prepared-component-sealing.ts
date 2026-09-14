// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import type {
  PreparedSupportTypeDescriptor,
  PreparedUnitCallableDescriptor,
} from "../shared/contracts/prepared-component-tokens.js";
import type { PreparedComponentCandidateDemand } from "./program/component-candidate-demand.js";
import { irUnitCallableBindingId } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrFunction } from "./nodes.js";
import type { IrIntegrationDiagnosticVisibility } from "./integration-report.js";
import { IrInvariantError, IrUnsupportedError, PreparedProgramAbiCommitError } from "./outcomes.js";
import type { PreparedComponentModuleCallableAliasDescriptor } from "./prepared-component-publication.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentAbiEntry,
  type PreparedComponentDependencyEvidence,
  type PreparedComponentDependencyReport,
  type PreparedInstructionSupportSidecars,
} from "./prepared-component-dependencies.js";
import {
  mergeDynamicInstructionSupport,
  prepareDynamicInstructionSupportForUnits,
} from "./prepared-dynamic-support.js";
import { ProgramAbiInvariantError } from "./program-abi.js";
import type { ProgramAbiDerivedUnitRecord, ProgramAbiSlotSpace } from "./program-abi.js";
import type { Import, ValType } from "./types.js";

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
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
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
    "locatorObjectForBinding",
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

/**
 * Validate the exact source-callable boundary against one component-local
 * lookup.  This keeps scoped ABI resolution at the sealing seam; callers must
 * never borrow the first component's live session view for another component.
 */
export function assertPreparedComponentCallableBoundaryLookup(input: {
  readonly lookup: PreparedComponentScopeLookup;
  readonly componentId: string;
  readonly bindingId: IrBindingId;
  readonly allocator: object;
  readonly structuralReferenceKey: string;
}): void {
  assertPreparedComponentScopeLookup(input.lookup, input.componentId);
  if (input.lookup.locatorObject(input.bindingId) !== input.allocator) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `prepared component ${input.componentId} lost the exact callable allocator for ${input.bindingId}`,
    );
  }
  if (input.lookup.currentCallableContract(input.bindingId) === undefined) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `prepared component ${input.componentId} has no callable contract for ${input.bindingId}`,
    );
  }
  input.lookup.resolveCurrentIndex(input.bindingId, "function", input.structuralReferenceKey);
}

export interface PreparedComponentArtifactEntry {
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly fn: IrFunction;
  readonly derivedUnit?: ProgramAbiDerivedUnitRecord;
  readonly classMember?: boolean;
  readonly moduleInit?: boolean;
}

type PreparedSealFailureSelector =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | { readonly kind: "component"; readonly value: string }
  | { readonly kind: "terminal"; readonly value: IrUnitId };

export interface PreparedComponentBatchDescription {
  readonly supportTypes?: PreparedSupportTypeDescriptor;
  readonly unitCallables?: PreparedUnitCallableDescriptor;
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
  const preparation = ctx.programAbiComponentPreparation;
  if (!preparation) {
    throw new IrInvariantError("selection-preparation-mismatch", "resolve", "missing component candidate adapter");
  }
  preparation.assertContext(ctx);
  const candidates = preparation.observeCallables(entries, inventory);

  const derivedUnits = [
    ...new Map(
      entries.flatMap((entry) => (entry.derivedUnit ? ([[entry.derivedUnit.id, entry.derivedUnit]] as const) : [])),
    ).values(),
  ];
  // (#5297) The timer-shim sidecar names ONE synthetic unit; this generalizes
  // the same evidence to every prepared unit carrying the externref dynamic
  // surface. Populations are disjoint by construction, so an overlap is a
  // producer change, not a precedence question — fail closed.
  const dynamicInstructionSupport = mergeDynamicInstructionSupport(
    input.dynamicInstructionSupport,
    prepareDynamicInstructionSupportForUnits({ ctx, entries, callableImports: input.callableImports }),
    (unitId) => {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared dynamic instruction support is claimed twice for ${unitId}`,
      );
    },
  );
  const { abi: candidateAbi, supportAbi } = candidates.observeDependencies();
  const derive = (
    candidateTerminalUnitIds: ReadonlySet<IrUnitId>,
    abi: Pick<PreparedComponentScopeLookup, "get" | "bindingIdsForStructuralReference"> = candidateAbi,
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
      ...(dynamicInstructionSupport ? { dynamicInstructionSupport } : {}),
      abi,
    });
  const candidateTerminalUnitIds = new Set(terminalUnitIds);
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
    const demand: PreparedComponentCandidateDemand = {
      componentId: component.id,
      terminalUnitIds: component.terminalUnitIds,
      callableBindingIds: entries
        .filter(
          (entry) =>
            component.terminalUnitIds.includes(entry.terminalOwnerUnitId) &&
            (entry.artifactUnitId !== entry.terminalOwnerUnitId || entry.derivedUnit) &&
            !entry.classMember &&
            !entry.moduleInit,
        )
        .map((entry) => irUnitCallableBindingId(entry.artifactUnitId)),
      supportBindingIds: [
        ...new Set(
          component.abiDependencies.flatMap((dependency) =>
            [dependency.bindingId, dependency.canonicalBindingId].filter((id) => supportAbi.get(id) !== undefined),
          ),
        ),
      ],
    };
    let failure: IrUnsupportedError | undefined;
    let diagnosticVisibility: IrIntegrationDiagnosticVisibility = "report";
    try {
      const scope = session.beginPreparedComponentScope(component.id, component.terminalUnitIds);
      let sealStarted = false;
      try {
        const batch = candidates.describe(
          component,
          demand,
          input.callableImports,
          input.preparedModuleCallableAliasDescriptor,
        );
        let sealedComponent = component;
        if (batch) {
          scope.stagePreparedComponentBatch({
            scopeId: component.id,
            terminalUnitIds: component.terminalUnitIds,
            requestedStructuralReferenceKeys: batch.requestedStructuralReferenceKeys,
            unitCallables: batch.unitCallables,
            supportTypes: batch.supportTypes,
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
