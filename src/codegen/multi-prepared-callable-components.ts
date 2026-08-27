// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Backend adapter for the bounded M1A cross-source callable component lane.
// Checker ownership stays in program-callable-bindings.ts; this module consumes
// only its frozen graph and the already-built source overlay plans.

import type { MultiTypedAST } from "../checker/index.js";
import { compileIrPathFunctions, type IrIntegrationReport } from "../ir/integration.js";
import type {
  IrDirectCallLoweringPlan,
  IrImportedCallLoweringPlan,
  IrIntegrationLoweringPlans,
} from "../ir/ast-lowering-plans.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import type {
  IrProgramCallableBindingGraph,
  IrProgramCallableBindingRecord,
  IrProgramCallableUse,
} from "../ir/program-callable-bindings.js";
import { IrInvariantError } from "../ir/outcomes.js";
import { buildIrLegacyUnitProjection, type IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrClosureSignature, IrFuncRef, IrType } from "../ir/nodes.js";
import { planProgramAbiModuleCallableAlias } from "./program-abi-planning.js";
import type { IrSelection } from "../ir/select.js";
import { ts } from "../ts-api.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import type { CodegenContext } from "./context/types.js";
import type { IrOverlayPlan } from "./index.js";
import type { MultiPreparedProgramCallableComponent } from "./multi-prepared-program.js";

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
  readonly attempted: Set<IrUnitId>;
  readonly aggregateProgramCallableUse: (
    graph: IrProgramCallableBindingGraph,
    recordsByBindingId: ReadonlyMap<IrBindingId, IrProgramCallableBindingGraph["records"][number]>,
    call: ts.CallExpression,
    ownerUnitId: IrUnitId,
    callPlan: IrImportedCallLoweringPlan,
  ) => IrProgramCallableUse | undefined;
  readonly recordMultiPreparedCallableAggregateFailure: (
    ctx: CodegenContext,
    report: IrIntegrationReport,
    originalNameBySyntheticName: ReadonlyMap<string, string>,
  ) => void;
  readonly rewriteAggregateCallableRef: (ref: IrFuncRef, namesByUnitId: ReadonlyMap<IrUnitId, string>) => IrFuncRef;
}

function planAggregateModuleCallableAliases(
  ctx: CodegenContext,
  group: readonly MultiPreparedCallableCandidate[],
  graph: IrProgramCallableBindingGraph,
  recordsByBindingId: ReadonlyMap<IrBindingId, IrProgramCallableBindingRecord>,
): ReadonlySet<IrBindingId> {
  const sourceCallables = ctx.programAbiSourceCallables;
  if (!sourceCallables) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "cross-source callable component requires the canonical source callable registry",
    );
  }
  const groupUnitIds = new Set(group.map((candidate) => candidate.unitId));
  sourceCallables.planUnits([...groupUnitIds]);

  const aliasesById = new Map<IrBindingId, IrProgramCallableBindingRecord>();
  for (const use of graph.uses) {
    if (!groupUnitIds.has(use.ownerUnitId) || !groupUnitIds.has(use.targetUnitId)) continue;
    let record = recordsByBindingId.get(use.bindingId);
    const visited = new Set<IrBindingId>();
    while (record && record.kind !== "source") {
      if (visited.has(record.bindingId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable component encountered an alias cycle at ${record.bindingId}`,
        );
      }
      visited.add(record.bindingId);
      if (record.targetUnitId !== use.targetUnitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable alias ${record.bindingId} changed canonical target from ${use.targetUnitId} to ${record.targetUnitId}`,
        );
      }
      aliasesById.set(record.bindingId, record);
      record = recordsByBindingId.get(record.targetBindingId);
    }
    if (!record || record.kind !== "source" || record.targetUnitId !== use.targetUnitId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable alias ${use.bindingId} has no exact source target for ${use.targetUnitId}`,
      );
    }
  }

  const signatureForUnit = (unitId: IrUnitId) => {
    const func = sourceCallables.functionForUnit(unitId);
    const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
    if (!func || !signature || signature.kind !== "func") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable alias target ${unitId} has no exact source callable signature`,
      );
    }
    return signature;
  };
  const planned = new Set<IrBindingId>();
  const visiting = new Set<IrBindingId>();
  const planAlias = (record: IrProgramCallableBindingRecord): void => {
    if (planned.has(record.bindingId)) return;
    if (visiting.has(record.bindingId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable component encountered an alias cycle at ${record.bindingId}`,
      );
    }
    visiting.add(record.bindingId);
    const target = recordsByBindingId.get(record.targetBindingId);
    if (!target) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable alias ${record.bindingId} targets missing graph binding ${record.targetBindingId}`,
      );
    }
    if (target.kind !== "source") planAlias(target);
    planProgramAbiModuleCallableAlias(ctx, {
      record,
      aliasOf: record.targetBindingId,
      signature: signatureForUnit(record.targetUnitId),
    });
    visiting.delete(record.bindingId);
    planned.add(record.bindingId);
  };
  for (const record of aliasesById.values()) planAlias(record);
  return new Set(planned);
}

export function prepareMultiPreparedCallableGroup(
  input: MultiPreparedCallableComponentPlanningInput,
): MultiPreparedProgramCallableComponent | undefined {
  const { group, groupIndex, candidatePlans, graph, recordsByBindingId, attempted } = input;

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
    const originalNameBySyntheticName = new Map<string, string>();
    for (const [unitIndex, candidate] of group.entries()) {
      const syntheticName = `__ir_m1a_${groupIndex}_${unitIndex}_${candidate.legacyName}`;
      if (input.ctx.funcMap.has(syntheticName) || originalNameBySyntheticName.has(syntheticName)) {
        valid = false;
        break;
      }
      namesByUnitId.set(candidate.unitId, syntheticName);
      originalNameBySyntheticName.set(syntheticName, candidate.legacyName);
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
    const moduleAliasBindingIds = planAggregateModuleCallableAliases(input.ctx, group, graph, recordsByBindingId);
    const preparedBindingIdsByTerminalUnitId = new Map<IrUnitId, ReadonlySet<IrBindingId>>([
      [group[0]!.unitId, moduleAliasBindingIds],
    ]);
    for (const candidate of group) attempted.add(candidate.unitId);
    input.ctx.irProgramCallableAttemptedUnitIds = attempted;

    const report = compileIrPathFunctions(
      input.ctx,
      group[0]!.sourceFile,
      aggregateSelection,
      overrides,
      undefined,
      loweringPlans,
      {
        sealPreparedComponents: true,
        integrationSourceFiles,
        atomicComponent: true,
        preparedBindingIdsByTerminalUnitId,
      },
    );
    if (report.errors.length > 0) {
      if ((report.compiledArtifactEvidence?.length ?? 0) !== 0 || report.compiled.length !== 0) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "patch",
          "atomic callable component reported both a failure and an installed artifact",
        );
      }
      input.recordMultiPreparedCallableAggregateFailure(input.ctx, report, originalNameBySyntheticName);
      continue;
    }

    const artifacts = report.compiledArtifactEvidence ?? [];
    const terminalEvidence = report.terminalEvidence ?? [];
    const componentId = artifacts[0]?.preparedComponentId;
    const expectedSyntheticNames = new Set(namesByUnitId.values());
    const reportIsExact =
      componentId !== undefined &&
      report.compiled.length === group.length &&
      new Set(report.compiled).size === group.length &&
      [...expectedSyntheticNames].every((name) => report.compiled.includes(name)) &&
      report.terminalCompiledOwners?.length === group.length &&
      new Set(report.terminalCompiledOwners).size === group.length &&
      [...expectedSyntheticNames].every((name) => report.terminalCompiledOwners?.includes(name)) &&
      report.errors.length === 0 &&
      artifacts.length === group.length &&
      artifacts.every(
        (artifact) =>
          artifact.artifactUnitId === artifact.terminalOwnerUnitId &&
          groupUnitIds.has(artifact.artifactUnitId) &&
          artifact.name === namesByUnitId.get(artifact.artifactUnitId) &&
          artifact.preparedComponentId === componentId,
      ) &&
      terminalEvidence.length === group.length &&
      terminalEvidence.every(
        (evidence) =>
          evidence.kind === "patched" &&
          groupUnitIds.has(evidence.unitId) &&
          evidence.legacyName === namesByUnitId.get(evidence.unitId) &&
          evidence.preparedComponentId === componentId,
      );
    if (!reportIsExact) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        "atomic callable component did not return exact terminal and artifact evidence",
      );
    }

    const preparedComponentId = componentId;
    preparedComponent = {
      preparedComponentId,
      units: group.map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceId: candidate.sourceId,
        unitId: candidate.unitId,
        legacyName: candidate.legacyName,
        declaration: candidate.declaration,
      })),
      assertCurrent: () => {
        const sourceCallables = input.ctx.programAbiSourceCallables;
        if (!sourceCallables) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "patch",
            `prepared callable component ${preparedComponentId} lost its source callable registry`,
          );
        }
        for (const candidate of group) {
          const current = input.ctx.irUnitFuncMap.get(candidate.unitId);
          const observed = sourceCallables.functionForUnit(candidate.unitId);
          if (!current || observed !== current || current.name !== candidate.legacyName || current.body.length === 0) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "patch",
              `prepared callable component ${preparedComponentId} lost exact unit ${candidate.unitId}`,
            );
          }
        }
      },
    };
  }
  return preparedComponent;
}
