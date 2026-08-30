// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Backend adapter for the bounded M1A cross-source callable component lane.
// Checker ownership stays in program-callable-bindings.ts; this module consumes
// only its frozen graph and the already-built source overlay plans.

import type { MultiTypedAST } from "../checker/index.js";
import { compilePreparedProgramComponent } from "../ir/integration.js";
import type {
  IrDirectCallLoweringPlan,
  IrImportedCallLoweringPlan,
  IrIntegrationLoweringPlans,
} from "../ir/ast-lowering-plans.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import type { IrProgramCallableBindingGraph, IrProgramCallableUse } from "../ir/program-callable-bindings.js";
import { IrInvariantError } from "../ir/outcomes.js";
import { buildIrLegacyUnitProjection, type IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrClosureSignature, IrFuncRef, IrType } from "../ir/nodes.js";
import type { IrSelection } from "../ir/select.js";
import { ts } from "../ts-api.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import type { CodegenContext } from "./context/types.js";
import type { IrOverlayPlan } from "./index.js";
import type { MultiPreparedProgramCallableComponent } from "./multi-prepared-program.js";
import { describePreparedModuleCallableAliases } from "./program-abi-module-callable-alias-planning.js";

export interface MultiPreparedCallableCandidate {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
  readonly plan: IrOverlayPlan;
}

export interface MultiPreparedCallableComponentPlanningInput {
  readonly ctx: CodegenContext;
  readonly multiAst: MultiTypedAST;
  readonly identityContext: IrPlanningIdentityContext;
  readonly group: readonly MultiPreparedCallableCandidate[];
  readonly groupIndex: number;
  readonly candidatePlans: ReadonlyMap<ts.SourceFile, IrOverlayPlan>;
  readonly graph: IrProgramCallableBindingGraph;
  readonly recordsByBindingId: ReadonlyMap<IrBindingId, IrProgramCallableBindingGraph["records"][number]>;
  readonly aggregateProgramCallableUse: (
    graph: IrProgramCallableBindingGraph,
    recordsByBindingId: ReadonlyMap<IrBindingId, IrProgramCallableBindingGraph["records"][number]>,
    call: ts.CallExpression,
    ownerUnitId: IrUnitId,
    callPlan: IrImportedCallLoweringPlan,
  ) => IrProgramCallableUse | undefined;
  readonly rewriteAggregateCallableRef: (ref: IrFuncRef, namesByUnitId: ReadonlyMap<IrUnitId, string>) => IrFuncRef;
  readonly assertPreflightCurrent: () => void;
}

export function prepareMultiPreparedCallableGroup(
  input: MultiPreparedCallableComponentPlanningInput,
): MultiPreparedProgramCallableComponent | undefined {
  const { group, groupIndex, candidatePlans, graph, recordsByBindingId } = input;

  let preparedComponent: MultiPreparedProgramCallableComponent | undefined;
  for (const candidateGroup of [group]) {
    const group = candidateGroup;
    const groupUnitIds = new Set(group.map((candidate) => candidate.unitId));
    let valid = true;
    for (const candidate of group) {
      for (const targetUnitId of candidate.plan.identityPlan.identitySelection.localCallees?.get(candidate.unitId) ??
        []) {
        if (!groupUnitIds.has(targetUnitId)) valid = false;
      }
      for (const [call, callPlan] of candidate.plan.importedCalls) {
        if (callPlan.ownerUnitId !== candidate.unitId) continue;
        const use = input.aggregateProgramCallableUse(graph, recordsByBindingId, call, candidate.unitId, callPlan);
        if (!use || !groupUnitIds.has(use.targetUnitId)) valid = false;
      }
    }
    if (!valid) continue;

    const namesByUnitId = new Map<IrUnitId, string>();
    const syntheticNames = new Set<string>();
    for (const [unitIndex, candidate] of group.entries()) {
      const syntheticName = `__ir_m1a_${groupIndex}_${unitIndex}_${candidate.legacyName}`;
      if (input.ctx.funcMap.has(syntheticName) || syntheticNames.has(syntheticName)) {
        valid = false;
        break;
      }
      namesByUnitId.set(candidate.unitId, syntheticName);
      syntheticNames.add(syntheticName);
    }
    if (!valid) continue;

    const signaturesByUnitId = new Map<IrUnitId, IrClosureSignature>();
    const overrides = new Map<string, { params: IrType[]; returnType: IrType | null }>();
    const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
    const importedCalls = new Map<ts.CallExpression, IrImportedCallLoweringPlan>();
    const sourceSelections = new Map<ts.SourceFile, IrSelection>();
    for (const candidate of group) {
      const override = candidate.plan.overrideMapByUnitId.get(candidate.unitId);
      const syntheticName = namesByUnitId.get(candidate.unitId);
      if (!override || !syntheticName) {
        valid = false;
        break;
      }
      signaturesByUnitId.set(candidate.unitId, override);
      overrides.set(syntheticName, override);
      const sourceSelection = sourceSelections.get(candidate.sourceFile) ?? { funcs: new Set<string>() };
      (sourceSelection.funcs as Set<string>).add(candidate.legacyName);
      sourceSelections.set(candidate.sourceFile, sourceSelection);
    }
    if (!valid) continue;

    for (const [sourceFile, sourceSelection] of sourceSelections) {
      const plan = candidatePlans.get(sourceFile);
      if (!plan) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          "callable component lost its source plan",
        );
      }
      const projected = irOverlayIdentity.projectIrIntegrationLoweringPlans(plan, sourceSelection);
      for (const [call, callPlan] of projected.directCalls) {
        if (!groupUnitIds.has(callPlan.ownerUnitId)) continue;
        if (callPlan.target.binding.kind === "unit" && !groupUnitIds.has(callPlan.target.binding.unitId)) {
          valid = false;
          break;
        }
        directCalls.set(call, {
          ...callPlan,
          target: input.rewriteAggregateCallableRef(callPlan.target, namesByUnitId),
        });
      }
      if (!valid) break;
      for (const [call, callPlan] of projected.importedCalls) {
        if (!groupUnitIds.has(callPlan.ownerUnitId)) continue;
        const use = input.aggregateProgramCallableUse(graph, recordsByBindingId, call, callPlan.ownerUnitId, callPlan);
        if (!use || !groupUnitIds.has(use.targetUnitId)) {
          valid = false;
          break;
        }
        const ownerName = namesByUnitId.get(callPlan.ownerUnitId);
        if (!ownerName) {
          valid = false;
          break;
        }
        importedCalls.set(call, {
          ...callPlan,
          ownerName,
          target: input.rewriteAggregateCallableRef(callPlan.target, namesByUnitId),
        });
      }
      if (!valid) break;
    }
    if (!valid) continue;

    const ownerProjection = buildIrLegacyUnitProjection(
      group.map((candidate) => ({ unitId: candidate.unitId, legacyName: namesByUnitId.get(candidate.unitId)! })),
    );
    const loweringPlans: IrIntegrationLoweringPlans = {
      identityContext: input.identityContext,
      ownerProjection,
      ownerUnitIdByLegacyName: new Map(ownerProjection.entries.map(({ legacyName, unitId }) => [legacyName, unitId])),
      signaturesByUnitId,
      directCalls,
      importedCalls,
      topLevelFunctionValues: new Map(),
      hostVoidCallbacks: new Map(),
      hostDateSnapshots: new Map(),
      hostDateGetters: new Map(),
      promiseDelays: { constructions: new Map(), timers: new Map(), resolves: new Map() },
      suspendingAsyncUnitIds: new Set(),
    };
    const aggregateSelection: IrSelection = { funcs: new Set(namesByUnitId.values()) };
    const integrationSourceFiles = input.multiAst.sourceFiles.filter((sourceFile) =>
      group.some((candidate) => candidate.sourceFile === sourceFile),
    );
    const declinedGroup = process.env.JS2WASM_TEST_DECLINE_MULTI_PREPARED_CALLABLE_COMPONENT;
    if (declinedGroup !== undefined) {
      if (!/^\d+$/.test(declinedGroup)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `invalid callable component decline selector ${JSON.stringify(declinedGroup)}`,
        );
      }
      if (Number(declinedGroup) === groupIndex) continue;
    }
    const session = input.ctx.programAbiSession;
    const sourceCallables = input.ctx.programAbiSourceCallables;
    if (
      !session ||
      !sourceCallables ||
      sourceCallables.session !== session ||
      sourceCallables.identityContext !== input.identityContext
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "cross-source callable component requires one exact source-callable ABI registry",
      );
    }
    // Source roots are the direct-owned allocator authority and remain valid
    // when this aggregate later declines. Only their module aliases are held
    // in the opaque, component-local descriptor below.
    sourceCallables.planUnits(group.map(({ unitId }) => unitId));
    const moduleCallableAliases = describePreparedModuleCallableAliases({
      session,
      graph,
      terminalUnitIds: group.map(({ unitId }) => unitId),
    });
    if (!moduleCallableAliases) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "cross-source callable component produced no exact module-alias descriptor",
      );
    }

    const result = compilePreparedProgramComponent(
      input.ctx,
      group[0]!.sourceFile,
      aggregateSelection,
      overrides,
      undefined,
      loweringPlans,
      {
        integrationSourceFiles,
        preparedModuleCallableAliasDescriptor: moduleCallableAliases,
      },
    );
    const { report, pendingReceipt } = result;
    const terminalFailures = (report.terminalEvidence ?? []).filter((evidence) => evidence.kind === "failed");
    const invariantFailure = [
      ...report.errors,
      ...terminalFailures.flatMap((evidence) => [evidence.error, ...(evidence.errors ?? [])]),
    ].find(({ outcome }) => outcome.kind === "invariant");
    if (invariantFailure?.outcome.kind === "invariant") {
      pendingReceipt?.abort();
      throw new IrInvariantError(
        invariantFailure.outcome.code,
        invariantFailure.outcome.stage,
        invariantFailure.outcome.detail,
        invariantFailure.outcome.cause,
      );
    }
    if (report.errors.length > 0 || terminalFailures.length > 0) {
      const failedUnitIds = terminalFailures.map(({ unitId }) => unitId);
      const terminalPublicErrors = terminalFailures.flatMap(({ diagnosticVisibility, errors }) =>
        diagnosticVisibility === "report" ? [...(errors ?? [])] : [],
      );
      if (
        pendingReceipt !== undefined ||
        (report.compiledArtifactEvidence?.length ?? 0) !== 0 ||
        report.compiled.length !== 0 ||
        (report.terminalEvidence?.length ?? 0) !== group.length ||
        (report.terminalCompiledOwners?.length ?? 0) !== 0 ||
        (report.syntheticCompiledArtifacts?.length ?? 0) !== 0 ||
        (report.preparedCountedStringAppendReceipts?.length ?? 0) !== 0 ||
        report.errors.length !== terminalPublicErrors.length ||
        report.errors.some((error, index) => error !== terminalPublicErrors[index]) ||
        new Set(report.errors).size !== report.errors.length ||
        terminalFailures.length !== group.length ||
        new Set(failedUnitIds).size !== group.length ||
        !group.every(({ unitId }) => failedUnitIds.includes(unitId)) ||
        terminalFailures.some(({ error, errors }) =>
          [error, ...(errors ?? [])].some(({ outcome }) => outcome.kind !== "unsupported"),
        )
      ) {
        pendingReceipt?.abort();
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "patch",
          "atomic callable component reported a non-exact failure population or pending artifact",
        );
      }
      continue;
    }

    const artifacts = report.compiledArtifactEvidence ?? [];
    const terminalEvidence = report.terminalEvidence ?? [];
    const componentId = pendingReceipt?.preparedComponentId;
    const expectedSyntheticNames = new Set(namesByUnitId.values());
    const reportIsExact =
      componentId !== undefined &&
      pendingReceipt !== undefined &&
      pendingReceipt.report === report &&
      pendingReceipt.terminalUnitIds.length === group.length &&
      pendingReceipt.terminalUnitIds.every((unitId, index) => unitId === group[index]?.unitId) &&
      report.compiled.length === group.length &&
      new Set(report.compiled).size === group.length &&
      [...expectedSyntheticNames].every((name) => report.compiled.includes(name)) &&
      report.terminalCompiledOwners?.length === group.length &&
      new Set(report.terminalCompiledOwners).size === group.length &&
      [...expectedSyntheticNames].every((name) => report.terminalCompiledOwners?.includes(name)) &&
      report.errors.length === 0 &&
      artifacts.length === group.length &&
      new Set(artifacts.map(({ artifactUnitId }) => artifactUnitId)).size === group.length &&
      group.every(({ unitId }) => artifacts.some(({ artifactUnitId }) => artifactUnitId === unitId)) &&
      artifacts.every(
        (artifact) =>
          artifact.artifactUnitId === artifact.terminalOwnerUnitId &&
          groupUnitIds.has(artifact.artifactUnitId) &&
          artifact.name === namesByUnitId.get(artifact.artifactUnitId) &&
          artifact.preparedComponentId === componentId,
      ) &&
      terminalEvidence.length === group.length &&
      new Set(terminalEvidence.map(({ unitId }) => unitId)).size === group.length &&
      group.every(({ unitId }) => terminalEvidence.some((evidence) => evidence.unitId === unitId)) &&
      terminalEvidence.every(
        (evidence) =>
          evidence.kind === "patched" &&
          groupUnitIds.has(evidence.unitId) &&
          evidence.legacyName === namesByUnitId.get(evidence.unitId) &&
          evidence.preparedComponentId === componentId,
      ) &&
      (report.syntheticCompiledArtifacts?.length ?? 0) === 0 &&
      (report.preparedCountedStringAppendReceipts?.length ?? 0) === 0;
    if (!reportIsExact) {
      pendingReceipt?.abort();
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        "atomic callable component did not return exact terminal and artifact evidence",
      );
    }

    const preparedComponentId = componentId;
    const populationMutation = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_COMPONENT_POPULATION;
    if (populationMutation !== undefined && !/^\d+$/.test(populationMutation)) {
      pendingReceipt.abort();
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `invalid callable component population mutation ${JSON.stringify(populationMutation)}`,
      );
    }
    const publishedGroup = Number(populationMutation) === groupIndex ? group.slice(0, -1) : group;
    preparedComponent = {
      preparedComponentId,
      units: publishedGroup.map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceId: candidate.sourceId,
        unitId: candidate.unitId,
        legacyName: candidate.legacyName,
        declaration: candidate.declaration,
      })),
      pendingReceipt,
      assertPreflightCurrent: input.assertPreflightCurrent,
    };
  }
  return preparedComponent;
}
