// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { MultiTypedAST } from "../checker/index.js";
import type { TypeFact } from "../checker/oracle.js";
import type { IrImportedCallLoweringPlan, IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import type { IrIntegrationError, IrIntegrationReport } from "../ir/integration.js";
import type { IrFuncRef } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import {
  planMultiPreparedModuleInit,
  type MultiPreparedModuleInitPlanningInput,
} from "./multi-prepared-module-init.js";
import {
  createMultiPreparedProgramOwner,
  type MultiPreparedProgramCallableComponent,
  type MultiPreparedProgramOwner,
} from "./multi-prepared-program.js";
import {
  buildIrProgramCallableBindingGraph,
  type IrProgramCallableBindingGraph,
  type IrProgramCallableUse,
} from "../ir/program-callable-bindings.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { effectiveIrParamTypeNode, irClosureSignatureFromFunctionTypeNode, type IrSelection } from "../ir/select.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, CodegenError, CodegenOptions } from "./context/types.js";
import type { IrOverlayPlan } from "./index.js";
import { collectMultiIrFunctionNameCollisions } from "./multi-prepared-scalar-leaf.js";
import {
  prepareMultiPreparedCallableGroup,
  type MultiPreparedCallableCandidate,
} from "./multi-prepared-callable-components.js";
import type {
  MultiPreparedFunctionValueSupportReceipt,
  MultiPreparedScalarLeafGraphSafety,
} from "./multi-prepared-scalar-leaf.js";
import {
  collectMultiPreparedStringLeafShapes,
  type MultiPreparedStringLeafShape,
} from "./multi-prepared-string-leaf.js";

type ProgramCallableRecord = IrProgramCallableBindingGraph["records"][number];

export function initializeMultiPreparedProgram(
  ctx: CodegenContext,
  multiAst: MultiTypedAST,
  options: CodegenOptions | undefined,
  explicitlyDisabled: (value: string | undefined) => boolean,
): MultiPreparedProgramOwner<IrOverlayPlan> | undefined {
  ctx.irProgramCallableCutoverEnabled =
    !!options?.experimentalIR &&
    multiAst.sourceFiles.length > 1 &&
    ctx.standalone &&
    !ctx.wasi &&
    !ctx.fast &&
    ctx.nativeStrings &&
    !explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER);
  return createMultiPreparedProgramOwner<IrOverlayPlan>(multiAst, options, ctx);
}

export function initializeIrProgramCallableBindingGraph(
  ctx: CodegenContext,
  multiAst: MultiTypedAST,
  identityContext: IrPlanningIdentityContext | undefined,
): void {
  if (!identityContext) return;
  ctx.irProgramCallableBindingGraph = buildIrProgramCallableBindingGraph({
    checker: multiAst.checker,
    sourceFiles: multiAst.sourceFiles,
    identityContext,
  });
}

export function programCallableSelectionOptions(
  ctx: CodegenContext,
  identityContext: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
): { readonly resolveProgramCallableUse?: (call: ts.CallExpression) => IrProgramCallableUse | undefined } {
  const resolveProgramCallableUse = createProgramCallableUseResolver(ctx, identityContext, sourceFile);
  return resolveProgramCallableUse ? { resolveProgramCallableUse } : {};
}

export function createProgramCallableUseResolver(
  ctx: CodegenContext,
  identityContext: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
): ((call: ts.CallExpression) => IrProgramCallableUse | undefined) | undefined {
  const graph = ctx.irProgramCallableCutoverEnabled ? ctx.irProgramCallableBindingGraph : undefined;
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (!graph || !sourceId) return undefined;
  const records = new Map(graph.records.map((record) => [record.bindingId, record] as const));
  const uses = new Map(graph.uses.filter((use) => use.sourceId === sourceId).map((use) => [use.node, use] as const));
  return (call) => {
    const use = uses.get(call);
    if (!use || records.get(use.bindingId)?.kind === "source" || !identityContext.unitByUnitId.has(use.targetUnitId)) {
      return undefined;
    }
    return use;
  };
}

export function isMultiIrProgramCallableCall(
  ctx: CodegenContext,
  call: ts.CallExpression,
  callPlan: IrImportedCallLoweringPlan,
): boolean {
  return (
    ctx.irProgramCallableCutoverEnabled === true &&
    callPlan.source === "module-import" &&
    ctx.irProgramCallableBindingGraph?.resolveCall(call, callPlan.ownerUnitId) !== undefined
  );
}

export function hasMultiIrProgramCallableBoundary(
  ctx: CodegenContext,
  identityContext: IrPlanningIdentityContext,
  unitId: IrUnitId,
): boolean {
  const graph = ctx.irProgramCallableCutoverEnabled ? ctx.irProgramCallableBindingGraph : undefined;
  if (!graph) return false;
  const unitSourceId = identityContext.unitByUnitId.get(unitId)?.sourceId;
  const unitSourceFile = unitSourceId ? identityContext.sourceFileBySourceId.get(unitSourceId) : undefined;
  // Global-script declarations remain outside M1A's module-binding proof. A
  // checker-resolved cross-file edge from or to one must not bypass the
  // existing standalone conservative caller gate.
  if (!unitSourceFile || !ts.isExternalModule(unitSourceFile)) return false;
  const ownerSourceId = identityContext.unitByUnitId.get(unitId)?.sourceId;
  return graph.uses.some((use) => {
    const useSourceFile = identityContext.sourceFileBySourceId.get(use.sourceId);
    if (!useSourceFile || !ts.isExternalModule(useSourceFile)) return false;
    if (use.ownerUnitId === unitId) return true;
    return use.targetUnitId === unitId && ownerSourceId !== undefined && use.sourceId !== ownerSourceId;
  });
}

function typeFactCouldBeCallable(fact: TypeFact): boolean {
  if (fact.kind === "function") return true;
  if (fact.kind === "union") return fact.parts.some(typeFactCouldBeCallable);
  return fact.kind === "any" || fact.kind === "unknown" || fact.kind === "unresolvable";
}

export function functionHasCallableBoundary(ctx: CodegenContext, declaration: ts.FunctionDeclaration): boolean {
  for (const parameter of declaration.parameters) {
    const typeNode = effectiveIrParamTypeNode(parameter);
    if (typeNode && ts.isFunctionTypeNode(typeNode) && irClosureSignatureFromFunctionTypeNode(typeNode)) continue;
    if (typeFactCouldBeCallable(ctx.oracle.typeFactOf(parameter))) return true;
  }
  const signature = ctx.oracle.signatureOf(declaration);
  return signature === undefined || typeFactCouldBeCallable(signature.returns);
}

export function multiIrFunctionValueLeafHasForeignLateProvider(
  plan: IrOverlayPlan,
  unitId: IrUnitId,
  functionValueTarget: boolean,
  valueTargets: ReadonlySet<IrUnitId>,
  directActivationTargets: ReadonlySet<IrUnitId>,
  timerOwnerUnitIds: ReadonlySet<IrUnitId>,
): boolean {
  return (
    (functionValueTarget ? valueTargets.size !== 1 || !valueTargets.has(unitId) : valueTargets.has(unitId)) ||
    directActivationTargets.has(unitId) ||
    [...plan.importedCalls.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.topLevelFunctionValues.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostVoidCallbacks.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateSnapshots.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateGetters.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.promiseDelays.constructions.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    plan.suspendingAsyncUnitIds.has(unitId) ||
    timerOwnerUnitIds.has(unitId)
  );
}

function aggregateProgramCallableUse(
  graph: IrProgramCallableBindingGraph,
  records: ReadonlyMap<IrBindingId, ProgramCallableRecord>,
  call: ts.CallExpression,
  ownerUnitId: IrUnitId,
  callPlan: IrImportedCallLoweringPlan,
): IrProgramCallableUse | undefined {
  const use = graph.resolveCall(call, ownerUnitId);
  const record = use ? records.get(use.bindingId) : undefined;
  return callPlan.source === "module-import" &&
    use &&
    record?.kind !== "source" &&
    callPlan.target.binding.kind === "unit" &&
    callPlan.target.binding.unitId === use.targetUnitId
    ? use
    : undefined;
}

function rewriteAggregateCallableRef(ref: IrFuncRef, namesByUnitId: ReadonlyMap<IrUnitId, string>): IrFuncRef {
  if (ref.binding.kind !== "unit") return ref;
  const name = namesByUnitId.get(ref.binding.unitId);
  return name === undefined ? ref : irUnitFuncRef({ unitId: ref.binding.unitId, name });
}

export interface MultiPreparedCallableOrchestrationInput {
  readonly owner: MultiPreparedProgramOwner<IrOverlayPlan>;
  readonly multiAst: MultiTypedAST;
  readonly ctx: CodegenContext;
  readonly identityContext: IrPlanningIdentityContext;
  readonly planSource: (sourceFile: ts.SourceFile, stringShape?: MultiPreparedStringLeafShape) => IrOverlayPlan;
  readonly safeSelection: (plan: IrOverlayPlan, sourceFile: ts.SourceFile) => IrSelection;
  readonly directCallerActivationTargets: (plan: IrOverlayPlan, sourceFile: ts.SourceFile) => ReadonlySet<IrUnitId>;
  readonly preparedFunctionValueTargets: (plan: IrOverlayPlan, sourceFile: ts.SourceFile) => ReadonlySet<IrUnitId>;
  readonly timerOwnerUnitIds: (plan: IrOverlayPlan) => ReadonlySet<IrUnitId>;
  readonly formatFailure: (error: IrIntegrationError) => Pick<CodegenError, "message" | "severity">;
}

function ownerIsEligible(
  input: MultiPreparedCallableOrchestrationInput,
  graph: IrProgramCallableBindingGraph,
  records: ReadonlyMap<IrBindingId, ProgramCallableRecord>,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  plan: IrOverlayPlan,
  unitId: IrUnitId,
  declaration: ts.FunctionDeclaration,
): boolean {
  if (
    !ts.isExternalModule(sourceFile) ||
    !declaration.body ||
    declaration.parent !== sourceFile ||
    !declaration.name ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.typeParameters?.length ||
    declaration.parameters.some(
      (parameter) =>
        !ts.isIdentifier(parameter.name) ||
        !!parameter.questionToken ||
        !!parameter.dotDotDotToken ||
        !!parameter.initializer,
    ) ||
    functionHasCallableBoundary(input.ctx, declaration)
  ) {
    return false;
  }
  if (
    input.identityContext.moduleInitUnitIdBySourceId.has(sourceId) ||
    input.identityContext.inventory.classes.some((record) => record.sourceId === sourceId)
  ) {
    return false;
  }
  if (
    plan.identityPlan.identitySelection.countedStringAppendPlans?.has(unitId) ||
    plan.identityPlan.identitySelection.fnctorAdmissions?.has(unitId) ||
    plan.identityPlan.identitySelection.fnctorArgumentProjections?.some(
      (projection) =>
        projection.callerUnitId === unitId ||
        projection.calleeUnitId === unitId ||
        projection.constructorUnitId === unitId,
    ) ||
    plan.suspendingAsyncUnitIds.has(unitId) ||
    [...plan.topLevelFunctionValues.values()].some((candidate) => candidate.ownerUnitId === unitId)
  ) {
    return false;
  }
  if (
    input.directCallerActivationTargets(plan, sourceFile).has(unitId) ||
    input.preparedFunctionValueTargets(plan, sourceFile).has(unitId) ||
    input.timerOwnerUnitIds(plan).has(unitId)
  ) {
    return false;
  }
  if (
    [...plan.hostVoidCallbacks.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateSnapshots.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.hostDateGetters.values()].some((candidate) => candidate.ownerUnitId === unitId) ||
    [...plan.promiseDelays.constructions.values()].some((candidate) => candidate.ownerUnitId === unitId)
  ) {
    return false;
  }
  for (const [call, callPlan] of plan.importedCalls) {
    if (callPlan.ownerUnitId === unitId && !aggregateProgramCallableUse(graph, records, call, unitId, callPlan)) {
      return false;
    }
  }
  return plan.overrideMapByUnitId.get(unitId)?.params.length === declaration.parameters.length;
}

function recordAggregateFailure(
  input: MultiPreparedCallableOrchestrationInput,
  report: IrIntegrationReport,
  originalNameBySyntheticName: ReadonlyMap<string, string>,
): void {
  for (const error of report.errors) {
    const originalName = originalNameBySyntheticName.get(error.func) ?? error.func;
    const adjusted = originalName === error.func ? error : { ...error, func: originalName };
    (input.ctx.irPostClaimErrors ??= []).push({ kind: adjusted.kind, func: originalName, message: adjusted.message });
    input.ctx.errors.push({ ...input.formatFailure(adjusted), line: 0, column: 0 });
  }
}

export function planMultiPreparedCallableComponents(input: MultiPreparedCallableOrchestrationInput): void {
  const graph = input.ctx.irProgramCallableBindingGraph;
  if (!graph || input.ctx.irProgramCallableCutoverEnabled !== true) return;
  // Dedicated Prepared owners freeze graph-wide allocator/support identity.
  // Generic component composition remains fail-closed until that shared
  // transaction is certified rather than shifting an established route.
  if (input.owner.existingRouteUnitIds.size > 0) return;
  const records = new Map(graph.records.map((record) => [record.bindingId, record] as const));
  const candidates = new Map<IrUnitId, MultiPreparedCallableCandidate>();
  const plans = new Map<ts.SourceFile, IrOverlayPlan>();
  const collidingFunctionNames = collectMultiIrFunctionNameCollisions(input.multiAst.sourceFiles);
  for (const sourceFile of input.multiAst.sourceFiles) {
    const sourceId = input.identityContext.sourceIdBySourceFile.get(sourceFile);
    if (!sourceId) throw new IrInvariantError("selection-preparation-mismatch", "resolve", "missing source identity");
    const plan = input.planSource(sourceFile);
    plans.set(sourceFile, plan);
    const safeSelection = input.safeSelection(plan, sourceFile);
    for (const [unitId, claim] of plan.functionClaimsByUnitId) {
      const terminal = input.identityContext.terminalByUnitId.get(unitId);
      if (
        input.owner.existingRouteUnitIds.has(unitId) ||
        !plan.identityPlan.safeFunctionUnitIds.has(unitId) ||
        !safeSelection.funcs.has(claim.legacyName) ||
        // The aggregate component rewrites cross-source refs, but its body
        // seam still uses source-local legacy names. Keep the existing
        // flat-name collision exclusion intact for this bounded route.
        collidingFunctionNames.has(claim.legacyName) ||
        terminal?.sourceId !== sourceId ||
        terminal.kind !== "top-level-function" ||
        terminal.observedKind !== "function" ||
        terminal.terminalOwnerId !== unitId ||
        !ownerIsEligible(input, graph, records, sourceFile, sourceId, plan, unitId, claim.declaration)
      ) {
        continue;
      }
      candidates.set(unitId, {
        sourceFile,
        sourceId,
        unitId,
        legacyName: claim.legacyName,
        declaration: claim.declaration,
        plan,
      });
    }
  }
  if (candidates.size < 2) return;

  const parent = new Map<IrUnitId, IrUnitId>([...candidates.keys()].map((unitId) => [unitId, unitId]));
  const find = (unitId: IrUnitId): IrUnitId => {
    const parentId = parent.get(unitId);
    if (!parentId) throw new IrInvariantError("selection-preparation-mismatch", "resolve", "lost callable candidate");
    if (parentId === unitId) return unitId;
    const root = find(parentId);
    parent.set(unitId, root);
    return root;
  };
  const union = (left: IrUnitId, right: IrUnitId): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };
  for (const candidate of candidates.values()) {
    for (const target of candidate.plan.identityPlan.identitySelection.localCallees?.get(candidate.unitId) ?? []) {
      if (candidates.has(target)) union(candidate.unitId, target);
    }
  }
  const crossSourceEdges: Array<readonly [IrUnitId, IrUnitId]> = [];
  for (const use of graph.uses) {
    const owner = candidates.get(use.ownerUnitId);
    const target = candidates.get(use.targetUnitId);
    if (!owner || !target) continue;
    union(owner.unitId, target.unitId);
    if (owner.sourceId !== target.sourceId) crossSourceEdges.push([owner.unitId, target.unitId]);
  }
  const groupsByRoot = new Map<IrUnitId, MultiPreparedCallableCandidate[]>();
  for (const candidate of candidates.values()) {
    const group = groupsByRoot.get(find(candidate.unitId)) ?? [];
    group.push(candidate);
    groupsByRoot.set(find(candidate.unitId), group);
  }
  const order = new Map(input.identityContext.inventory.terminalUnits.map((unit, index) => [unit.id, index] as const));
  const compare = (left: MultiPreparedCallableCandidate, right: MultiPreparedCallableCandidate): number =>
    (order.get(left.unitId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.unitId) ?? Number.MAX_SAFE_INTEGER) ||
    left.unitId.localeCompare(right.unitId);
  const groups = [...groupsByRoot.values()]
    .map((group) => group.sort(compare))
    .filter((group) => {
      const unitIds = new Set(group.map(({ unitId }) => unitId));
      return (
        new Set(group.map(({ sourceId }) => sourceId)).size > 1 &&
        crossSourceEdges.some(([owner, target]) => unitIds.has(owner) && unitIds.has(target))
      );
    })
    .sort((left, right) => compare(left[0]!, right[0]!));
  const componentCutoverEnabled = input.multiAst.sourceFiles.every(
    (sourceFile) => collectModuleInitPopulation(sourceFile).length === 0,
  );
  if (!componentCutoverEnabled) {
    const attempted = new Set(input.ctx.irProgramCallableAttemptedUnitIds ?? []);
    for (const group of groups) for (const candidate of group) attempted.add(candidate.unitId);
    if (attempted.size > 0) input.ctx.irProgramCallableAttemptedUnitIds = attempted;
    return;
  }
  const components: MultiPreparedProgramCallableComponent[] = [];
  const attempted = new Set(input.ctx.irProgramCallableAttemptedUnitIds ?? []);
  for (const [groupIndex, group] of groups.entries()) {
    const component = prepareMultiPreparedCallableGroup({
      ctx: input.ctx,
      multiAst: input.multiAst,
      identityContext: input.identityContext,
      group,
      groupIndex,
      candidatePlans: plans,
      graph,
      recordsByBindingId: records,
      attempted,
      aggregateProgramCallableUse,
      recordMultiPreparedCallableAggregateFailure: (_ctx, report, names) =>
        recordAggregateFailure(input, report, names),
      rewriteAggregateCallableRef,
    });
    if (component) components.push(component);
  }
  if (components.length > 0) input.owner.registerCallableComponents(components);
}

export function removeMultiIrAttemptedCallableUnits(
  ctx: CodegenContext,
  plan: IrOverlayPlan,
  selection: IrSelection,
): IrSelection {
  const attempted = ctx.irProgramCallableAttemptedUnitIds;
  if (!attempted?.size) return selection;
  const funcs = new Set(
    [...selection.funcs].filter((name) => {
      const unitId = plan.identityPlan.functionUnitIdByLegacyName.get(name);
      return !unitId || !attempted.has(unitId);
    }),
  );
  return funcs.size === selection.funcs.size
    ? selection
    : { ...selection, funcs, classMembers: new Set(), classMemberUnitIds: new Set(), moduleInit: undefined };
}

export interface MultiPreparedProgramRoutePlanningInput {
  readonly owner: MultiPreparedProgramOwner<IrOverlayPlan>;
  readonly multiAst: MultiTypedAST;
  readonly options?: CodegenOptions;
  readonly identityContext: IrPlanningIdentityContext;
  readonly ctx: CodegenContext;
  readonly explicitlyDisabled: (value: string | undefined) => boolean;
  readonly planSource: (sourceFile: ts.SourceFile, stringShape?: MultiPreparedStringLeafShape) => IrOverlayPlan;
  readonly planResolvedModuleInitSource: (sourceFile: ts.SourceFile) => IrOverlayPlan;
  readonly buildSafety: () => MultiPreparedScalarLeafGraphSafety;
  readonly safeSelection: (
    plan: IrOverlayPlan,
    sourceFile: ts.SourceFile,
    safety: MultiPreparedScalarLeafGraphSafety,
  ) => IrSelection;
  readonly lateProviderOwnerUnitIds: (plan: IrOverlayPlan, sourceFile: ts.SourceFile) => ReadonlySet<IrUnitId>;
  readonly hasForeignLateProvider: (
    plan: IrOverlayPlan,
    sourceFile: ts.SourceFile,
    unitId: IrUnitId,
    functionValueTarget: boolean,
  ) => boolean;
  readonly prepareFunctionValueSupport: (
    plan: IrOverlayPlan,
    sourceFile: ts.SourceFile,
    unitId: IrUnitId,
    legacyName: string,
  ) => MultiPreparedFunctionValueSupportReceipt | undefined;
  readonly projectLoweringPlans: (plan: IrOverlayPlan, selection: IrSelection) => IrIntegrationLoweringPlans;
  readonly moduleInit?: Omit<
    MultiPreparedModuleInitPlanningInput,
    | "ctx"
    | "multiAst"
    | "identityContext"
    | "options"
    | "planSource"
    | "planResolvedSource"
    | "safeSelection"
    | "projectLoweringPlans"
  >;
  readonly callable: Omit<
    MultiPreparedCallableOrchestrationInput,
    "owner" | "multiAst" | "ctx" | "identityContext" | "planSource" | "safeSelection"
  >;
}

export function planMultiPreparedProgramEarlyRoutes(input: MultiPreparedProgramRoutePlanningInput): void {
  const plans = new Map<ts.SourceFile, IrOverlayPlan>();
  const stringProofContext = { checker: input.multiAst.checker, oracle: input.ctx.oracle };
  const stringShapes = input.explicitlyDisabled(process.env.JS2WASM_IR_STRING_BUILDER)
    ? []
    : collectMultiPreparedStringLeafShapes({
        proofContext: stringProofContext,
        sourceFiles: input.multiAst.sourceFiles,
      });
  const stringShapeBySource = new Map(stringShapes.map((shape) => [shape.sourceFile, shape] as const));
  const planSource = (sourceFile: ts.SourceFile, stringShape?: MultiPreparedStringLeafShape): IrOverlayPlan => {
    const cached = plans.get(sourceFile);
    if (cached) return cached;
    const plan = input.planSource(sourceFile, stringShape ?? stringShapeBySource.get(sourceFile));
    plans.set(sourceFile, plan);
    return plan;
  };
  let cachedSafety: MultiPreparedScalarLeafGraphSafety | undefined;
  const safety = (): MultiPreparedScalarLeafGraphSafety => (cachedSafety ??= input.buildSafety());
  const active =
    !!input.options?.experimentalIR &&
    !input.options.disableIrFirst &&
    !input.explicitlyDisabled(process.env.JS2WASM_IR_FIRST) &&
    input.ctx.standalone &&
    !input.ctx.wasi &&
    !input.ctx.fast &&
    input.multiAst.sourceFiles.length > 1;
  if (input.multiAst.sourceFiles.some((sourceFile) => collectModuleInitPopulation(sourceFile).length > 0)) {
    input.ctx.irProgramCallableCutoverEnabled = false;
  }
  input.owner.planExistingRoutes({
    active,
    scalarCutoverEnabled: !input.explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER),
    arrayCutoverEnabled: !input.explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER),
    stringCutoverEnabled: !input.explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_STRING_CUTOVER),
    stringProofContext,
    functionValueLeafCutoverEnabled: !input.explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER),
    fibonacciPairCutoverEnabled: !input.explicitlyDisabled(process.env.JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER),
    ctx: input.ctx,
    sourceFiles: input.multiAst.sourceFiles,
    entryFile: input.multiAst.entryFile,
    safety,
    planSource,
    safeSelection: input.safeSelection,
    lateProviderOwnerUnitIds: input.lateProviderOwnerUnitIds,
    hasForeignLateProvider: input.hasForeignLateProvider,
    prepareFunctionValueSupport: input.prepareFunctionValueSupport,
    projectLoweringPlans: input.projectLoweringPlans,
    stringShapes,
  });
  const preparedModuleInit = input.moduleInit
    ? planMultiPreparedModuleInit({
        ...input.moduleInit,
        ctx: input.ctx,
        multiAst: input.multiAst,
        identityContext: input.identityContext,
        ...(input.options ? { options: input.options } : {}),
        planSource,
        planResolvedSource: input.planResolvedModuleInitSource,
        safeSelection: (plan, sourceFile) => input.safeSelection(plan, sourceFile, safety()),
        projectLoweringPlans: input.projectLoweringPlans,
      })
    : undefined;
  if (preparedModuleInit) input.owner.registerPreparedModuleInit(preparedModuleInit);
  if (input.ctx.irProgramCallableCutoverEnabled && !preparedModuleInit) {
    planMultiPreparedCallableComponents({
      owner: input.owner,
      multiAst: input.multiAst,
      ctx: input.ctx,
      identityContext: input.identityContext,
      planSource,
      safeSelection: (plan, sourceFile) => input.safeSelection(plan, sourceFile, safety()),
      ...input.callable,
    });
  }
  input.owner.sealBodyBoundary();
}
