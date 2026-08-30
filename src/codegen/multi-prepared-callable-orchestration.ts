// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { MultiTypedAST } from "../checker/index.js";
import type { TypeFact } from "../checker/oracle.js";
import type { IrImportedCallLoweringPlan, IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import type { IrIntegrationError } from "../ir/integration.js";
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
import {
  prepareMultiPreparedCallableGroup,
  type MultiPreparedCallableCandidate,
} from "./multi-prepared-callable-components.js";
import type {
  MultiPreparedFunctionValueSupportReceipt,
  MultiPreparedScalarLeafGraphSafety,
} from "./multi-prepared-scalar-leaf.js";
import { closeIrBlockedComponentByIdentity } from "./ir-overlay-finalize.js";
import {
  collectMultiPreparedStringLeafShapes,
  type MultiPreparedStringLeafShape,
} from "./multi-prepared-string-leaf.js";

type ProgramCallableRecord = IrProgramCallableBindingGraph["records"][number];

interface CallableAttemptCensus {
  readonly graph: IrProgramCallableBindingGraph;
  readonly identityContext: IrPlanningIdentityContext;
  readonly attemptedUnitIds: ReadonlySet<IrUnitId>;
  readonly componentIndexByUnitId: ReadonlyMap<IrUnitId, number>;
}

/**
 * The graph-first census deliberately carries no source overlay plan. Plans
 * are cached before the census is published and are never used to define its
 * denominator; callable candidates are reconciled against those exact plans
 * only after the graph population has been frozen.
 */
interface CallablePreflightMember {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
}

type NestedCallableDeclarationMutation = "nested-return-expression" | "nested-binary-right";
type CallableDeclarationBodyMutation = "1" | NestedCallableDeclarationMutation | "nested-last-return-expression";

function snapshotCallableDeclarationNodes(declaration: ts.FunctionDeclaration): readonly ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return Object.freeze(nodes);
}

function replaceNestedCallableDeclarationNode(
  declaration: ts.FunctionDeclaration,
  mutation: NestedCallableDeclarationMutation,
): (() => void) | undefined {
  let restore: (() => void) | undefined;
  const visit = (node: ts.Node): void => {
    if (restore) return;
    if (mutation === "nested-return-expression" && ts.isReturnStatement(node) && node.expression) {
      const statement = node as ts.ReturnStatement & { expression: ts.Expression | undefined };
      const original = statement.expression;
      statement.expression = ts.factory.createNumericLiteral("0");
      restore = () => {
        statement.expression = original;
      };
      return;
    }
    if (mutation === "nested-binary-right" && ts.isBinaryExpression(node)) {
      const expression = node as ts.BinaryExpression & { right: ts.Expression };
      const original = expression.right;
      expression.right = ts.factory.createNumericLiteral("0");
      restore = () => {
        expression.right = original;
      };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return restore;
}

const callableAttemptCensusByContext = new WeakMap<CodegenContext, CallableAttemptCensus>();

function currentCallableAttemptCensus(
  ctx: CodegenContext,
  consumer: string,
  expectedIdentityContext?: IrPlanningIdentityContext,
): CallableAttemptCensus | undefined {
  const census = callableAttemptCensusByContext.get(ctx);
  const observed = ctx.irProgramCallableAttemptedUnitIds;
  if (!census) {
    if (observed !== undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `${consumer} observed a callable attempted set without its authoritative preflight census`,
      );
    }
    return undefined;
  }
  if (
    ctx.irProgramCallableBindingGraph !== census.graph ||
    ctx.irPlanningIdentityContext !== census.identityContext ||
    (expectedIdentityContext !== undefined && expectedIdentityContext !== census.identityContext) ||
    observed === undefined ||
    observed.size !== census.attemptedUnitIds.size ||
    [...census.attemptedUnitIds].some((unitId) => !observed.has(unitId))
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `${consumer} observed a mutated callable preflight authority`,
    );
  }
  return census;
}

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
  const census = currentCallableAttemptCensus(ctx, "callable call routing");
  const use =
    ctx.irProgramCallableCutoverEnabled === true
      ? ctx.irProgramCallableBindingGraph?.resolveCall(call, callPlan.ownerUnitId)
      : undefined;
  const componentIndex = census?.componentIndexByUnitId;
  return (
    use !== undefined &&
    census?.attemptedUnitIds.has(callPlan.ownerUnitId) === true &&
    census.attemptedUnitIds.has(use.targetUnitId) &&
    componentIndex !== undefined &&
    componentIndex.get(callPlan.ownerUnitId) !== undefined &&
    componentIndex.get(callPlan.ownerUnitId) === componentIndex.get(use.targetUnitId) &&
    callPlan.source === "module-import" &&
    callPlan.target.binding.kind === "unit" &&
    callPlan.target.binding.unitId === use.targetUnitId
  );
}

export function hasMultiIrProgramCallableBoundary(
  ctx: CodegenContext,
  identityContext: IrPlanningIdentityContext,
  unitId: IrUnitId,
): boolean {
  const graph = ctx.irProgramCallableCutoverEnabled ? ctx.irProgramCallableBindingGraph : undefined;
  const census = currentCallableAttemptCensus(ctx, "callable boundary routing", identityContext);
  if (!graph || !census?.attemptedUnitIds.has(unitId)) return false;
  const unitSourceId = identityContext.unitByUnitId.get(unitId)?.sourceId;
  const unitSourceFile = unitSourceId ? identityContext.sourceFileBySourceId.get(unitSourceId) : undefined;
  // Global-script declarations remain outside M1A's module-binding proof. A
  // checker-resolved cross-file edge from or to one must not bypass the
  // existing standalone conservative caller gate.
  if (!unitSourceFile || !ts.isExternalModule(unitSourceFile)) return false;
  const terminal = identityContext.terminalByUnitId.get(unitId);
  const declaration = identityContext.declarationByUnitId.get(unitId);
  return (
    terminal !== undefined &&
    terminal.sourceId === unitSourceId &&
    terminal.kind === "top-level-function" &&
    terminal.observedKind === "function" &&
    terminal.terminalOwnerId === unitId &&
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.parent === unitSourceFile
  );
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

function preflightMultiPreparedCallableComponents(
  input: MultiPreparedCallableOrchestrationInput,
  graph: IrProgramCallableBindingGraph,
): readonly (readonly CallablePreflightMember[])[] {
  const activeSourceFiles = new Set(input.multiAst.sourceFiles);
  const records = new Map<IrBindingId, ProgramCallableRecord>();
  for (const record of graph.records) {
    if (records.has(record.bindingId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight found duplicate graph binding ${record.bindingId}`,
      );
    }
    records.set(record.bindingId, record);
  }

  const canonicalSourceRecord = (record: ProgramCallableRecord): ProgramCallableRecord | undefined => {
    const seen = new Set<IrBindingId>();
    let current: ProgramCallableRecord | undefined = record;
    for (let depth = 0; current && depth < records.size + 1; depth++) {
      if (seen.has(current.bindingId)) return undefined;
      seen.add(current.bindingId);
      if (current.kind === "source") return current;
      current = records.get(current.targetBindingId);
    }
    return undefined;
  };

  const sourceMembersByUnitId = new Map<IrUnitId, CallablePreflightMember>();
  const sourceRecordByUnitId = new Map<IrUnitId, ProgramCallableRecord>();
  for (const record of graph.records) {
    const sourceFile = input.identityContext.sourceFileBySourceId.get(record.sourceId);
    if (!sourceFile || !activeSourceFiles.has(sourceFile)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight graph record ${record.bindingId} is outside the exact source set`,
      );
    }
    const targetRecord = records.get(record.targetBindingId);
    const canonicalRecord = records.get(record.canonicalBindingId);
    const targetUnit = input.identityContext.unitByUnitId.get(record.targetUnitId);
    const targetTerminal = input.identityContext.terminalByUnitId.get(record.targetUnitId);
    const targetDeclaration = input.identityContext.declarationByUnitId.get(record.targetUnitId);
    const sourceCanonicalRecord = canonicalSourceRecord(record);
    if (
      !targetRecord ||
      targetRecord.targetUnitId !== record.targetUnitId ||
      !canonicalRecord ||
      canonicalRecord.targetUnitId !== record.targetUnitId ||
      !sourceCanonicalRecord ||
      sourceCanonicalRecord.bindingId !== record.canonicalBindingId ||
      sourceCanonicalRecord.targetUnitId !== record.targetUnitId ||
      !targetUnit ||
      targetTerminal !== targetUnit ||
      input.identityContext.sourceFileBySourceId.get(targetUnit.sourceId) === undefined
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight graph record ${record.bindingId} has a dangling target join`,
      );
    }
    if (record.kind !== "source") continue;
    if (record.targetBindingId !== record.bindingId || record.canonicalBindingId !== record.bindingId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight source record ${record.bindingId} has an alias target`,
      );
    }
    const declaration = targetDeclaration;
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.body ||
      !targetTerminal ||
      targetTerminal.sourceId !== record.sourceId ||
      targetTerminal.kind !== "top-level-function" ||
      targetTerminal.observedKind !== "function" ||
      targetTerminal.terminalOwnerId !== record.targetUnitId ||
      input.identityContext.unitByUnitId.get(record.targetUnitId) !== targetTerminal ||
      input.identityContext.declarationByUnitId.get(record.targetUnitId) !== declaration ||
      input.identityContext.unitIdByDeclaration.get(declaration) !== record.targetUnitId ||
      declaration.parent !== sourceFile ||
      declaration.getSourceFile() !== sourceFile ||
      !sourceFile.statements.includes(declaration)
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight source record ${record.bindingId} is not its exact declaration/terminal join`,
      );
    }
    if (sourceRecordByUnitId.has(record.targetUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight found duplicate source record for ${record.targetUnitId}`,
      );
    }
    sourceRecordByUnitId.set(record.targetUnitId, record);
    const legacyName = declaration.name?.text;
    // The M1A.4a census is deliberately named-only. Anonymous defaults remain
    // in the graph oracle and are validated as exact joins above, but cannot
    // enter the compatibility namespace until the pure propagation/lowerer
    // seams land in their owning lanes.
    if (legacyName === undefined) continue;
    if (targetTerminal.legacyMatchName !== legacyName || record.localName !== legacyName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight source record ${record.bindingId} has a non-canonical compatibility name`,
      );
    }
    // Keep all exact source records for use validation. The component census
    // itself admits only external-module members with a stable compatibility
    // name, so global-script and anonymous non-default units remain outside.
    if (ts.isExternalModule(sourceFile)) {
      sourceMembersByUnitId.set(
        record.targetUnitId,
        Object.freeze({
          sourceFile,
          sourceId: record.sourceId,
          unitId: record.targetUnitId,
          legacyName,
          declaration,
        }),
      );
    }
  }

  const callBelongsToDeclaration = (call: ts.CallExpression, declaration: ts.FunctionDeclaration): boolean => {
    let current: ts.Node | undefined = call;
    while (current && current !== declaration) {
      if (current !== call && ts.isFunctionLike(current)) return false;
      current = current.parent;
    }
    return current === declaration;
  };
  const crossSourceEdges: Array<readonly [IrUnitId, IrUnitId]> = [];
  for (const use of graph.uses) {
    const ownerRecord = sourceRecordByUnitId.get(use.ownerUnitId);
    const targetRecord = sourceRecordByUnitId.get(use.targetUnitId);
    const owner = sourceMembersByUnitId.get(use.ownerUnitId);
    const target = sourceMembersByUnitId.get(use.targetUnitId);
    const record = records.get(use.bindingId);
    const ownerSourceFile = ownerRecord
      ? input.identityContext.sourceFileBySourceId.get(ownerRecord.sourceId)
      : undefined;
    const ownerDeclaration = input.identityContext.declarationByUnitId.get(use.ownerUnitId);
    if (
      !ownerRecord ||
      !targetRecord ||
      !record ||
      !ownerSourceFile ||
      !ownerDeclaration ||
      !ts.isFunctionDeclaration(ownerDeclaration) ||
      ownerDeclaration.parent !== ownerSourceFile ||
      use.sourceId !== ownerRecord.sourceId ||
      record.sourceId !== ownerRecord.sourceId ||
      record.sourceId !== use.sourceId ||
      use.node.getSourceFile() !== ownerSourceFile ||
      !callBelongsToDeclaration(use.node, ownerDeclaration) ||
      graph.resolveCall(use.node, use.ownerUnitId) !== use ||
      record.targetUnitId !== targetRecord.targetUnitId ||
      record.canonicalBindingId !== use.canonicalBindingId ||
      targetRecord.targetUnitId !== use.targetUnitId
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight found a non-exact graph edge ${use.ownerUnitId} -> ${use.targetUnitId}`,
      );
    }
    if (!owner || !target) continue;
    if (owner.sourceId !== target.sourceId) crossSourceEdges.push([owner.unitId, target.unitId]);
  }

  if (sourceMembersByUnitId.size < 2) return [];
  const parent = new Map<IrUnitId, IrUnitId>([...sourceMembersByUnitId.keys()].map((unitId) => [unitId, unitId]));
  const find = (unitId: IrUnitId): IrUnitId => {
    const parentId = parent.get(unitId);
    if (!parentId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable preflight lost structural unit ${unitId}`,
      );
    }
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
  for (const [owner, target] of crossSourceEdges) union(owner, target);
  // Local callable uses are graph evidence too. Closing them from the same
  // frozen use list avoids reintroducing a plan-derived identity authority.
  for (const use of graph.uses) {
    const owner = sourceMembersByUnitId.get(use.ownerUnitId);
    const target = sourceMembersByUnitId.get(use.targetUnitId);
    if (owner && target && owner.sourceId === target.sourceId) union(owner.unitId, target.unitId);
  }

  const groupsByRoot = new Map<IrUnitId, CallablePreflightMember[]>();
  for (const member of sourceMembersByUnitId.values()) {
    const root = find(member.unitId);
    const group = groupsByRoot.get(root) ?? [];
    group.push(member);
    groupsByRoot.set(root, group);
  }
  const order = new Map(input.identityContext.inventory.terminalUnits.map((unit, index) => [unit.id, index] as const));
  const compare = (left: CallablePreflightMember, right: CallablePreflightMember): number =>
    (order.get(left.unitId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.unitId) ?? Number.MAX_SAFE_INTEGER) ||
    left.unitId.localeCompare(right.unitId);
  return Object.freeze(
    [...groupsByRoot.values()]
      .map((group) => group.sort(compare))
      .filter((group) => {
        const unitIds = new Set(group.map(({ unitId }) => unitId));
        return (
          new Set(group.map(({ sourceId }) => sourceId)).size > 1 &&
          crossSourceEdges.some(([owner, target]) => unitIds.has(owner) && unitIds.has(target))
        );
      })
      .sort((left, right) => compare(left[0]!, right[0]!))
      .map((group) => Object.freeze(group)),
  );
}

interface CallableAttemptCensusPublication {
  readonly attempted: ReadonlySet<IrUnitId>;
  readonly preflightDeclarationNodesByUnitId: ReadonlyMap<IrUnitId, readonly ts.Node[]>;
}

/** Publish the graph denominator and capture the exact declaration prefix. */
function publishCallableAttemptCensus(
  input: MultiPreparedCallableOrchestrationInput,
  graph: IrProgramCallableBindingGraph,
  preflightComponents: readonly (readonly CallablePreflightMember[])[],
): CallableAttemptCensusPublication {
  if (input.ctx.irProgramCallableAttemptedUnitIds !== undefined) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "callable attempted census was already published before aggregate preflight",
    );
  }
  const attempted = new Set(preflightComponents.flatMap((group) => group.map(({ unitId }) => unitId)));
  const authoritativeAttempted = new Set(attempted);
  const componentIndexByUnitId = new Map(
    preflightComponents.flatMap((group, componentIndex) =>
      group.map(({ unitId }) => [unitId, componentIndex] as const),
    ),
  );
  callableAttemptCensusByContext.set(input.ctx, {
    graph,
    identityContext: input.identityContext,
    attemptedUnitIds: authoritativeAttempted,
    componentIndexByUnitId,
  });
  // Keep the compatibility projection separate from the private authority so
  // a consumer mutation cannot silently rewrite the trusted denominator.
  const publicAttemptedProjection = new Set(authoritativeAttempted);
  input.ctx.irProgramCallableAttemptedUnitIds = publicAttemptedProjection;
  const censusMutation = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_CENSUS;
  if (censusMutation === "drop") {
    publicAttemptedProjection.delete([...authoritativeAttempted][0]!);
  } else if (censusMutation === "foreign") {
    publicAttemptedProjection.add("ir-unit:v1:test-foreign-callable" as IrUnitId);
  } else if (censusMutation === "include-unanchored") {
    const unanchored = graph.records.find(
      (record) => record.kind === "source" && !authoritativeAttempted.has(record.targetUnitId),
    );
    if (!unanchored) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "callable include-unanchored mutation found no exact unanchored source unit",
      );
    }
    publicAttemptedProjection.add(unanchored.targetUnitId);
  } else if (censusMutation === "under-covered-neighbor") {
    const crossSourceEndpoints = new Set(
      graph.uses.flatMap((use) => {
        const owner = input.identityContext.unitByUnitId.get(use.ownerUnitId);
        const target = input.identityContext.unitByUnitId.get(use.targetUnitId);
        return owner && target && owner.sourceId !== target.sourceId ? [use.ownerUnitId, use.targetUnitId] : [];
      }),
    );
    const underCovered = [...attempted].find((unitId) => !crossSourceEndpoints.has(unitId));
    if (!underCovered) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "callable census under-coverage mutation found no source-local neighbor",
      );
    }
    // Keep the private authority and component index immutable. The public
    // projection is the only mutation seam; the next exact census check must
    // reject it before any callable plan can be accepted.
    publicAttemptedProjection.delete(underCovered);
  } else if (censusMutation !== undefined) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `unknown callable census mutation ${JSON.stringify(censusMutation)}`,
    );
  }
  const expectedAttemptedUnitIds = preflightComponents.flatMap((group) => group.map(({ unitId }) => unitId));
  const preflightDeclarationNodesByUnitId = new Map(
    preflightComponents.flatMap((group) =>
      group.map((member) => {
        return [member.unitId, snapshotCallableDeclarationNodes(member.declaration)] as const;
      }),
    ),
  );
  if (
    authoritativeAttempted.size !== expectedAttemptedUnitIds.length ||
    expectedAttemptedUnitIds.some((unitId) => !authoritativeAttempted.has(unitId)) ||
    componentIndexByUnitId.size !== expectedAttemptedUnitIds.length ||
    preflightComponents.some((group, groupIndex) =>
      group.some(({ unitId }) => componentIndexByUnitId.get(unitId) !== groupIndex),
    )
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "callable attempted census under-covered its immutable preflight component population",
    );
  }
  if (censusMutation === "under-covered-neighbor") {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "callable attempted census under-covered its immutable preflight component population",
    );
  }
  currentCallableAttemptCensus(input.ctx, "callable aggregate planning");
  return Object.freeze({ attempted, preflightDeclarationNodesByUnitId });
}

/** Reconcile every selected graph edge against its source overlay evidence. */
function assertCallableGraphUsesMatchCachedPlans(
  input: MultiPreparedCallableOrchestrationInput,
  graph: IrProgramCallableBindingGraph,
  records: ReadonlyMap<IrBindingId, ProgramCallableRecord>,
  plans: ReadonlyMap<ts.SourceFile, IrOverlayPlan>,
  preflightComponents: readonly (readonly CallablePreflightMember[])[],
): void {
  const selected = new Map(
    preflightComponents.flatMap((group) => group.map((member) => [member.unitId, member] as const)),
  );
  const localCalleesBySource = new Map<ts.SourceFile, ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>>();
  const importedCallsBySource = new Map<ts.SourceFile, ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>>();
  for (const [sourceFile, plan] of plans) {
    localCalleesBySource.set(sourceFile, plan.identityPlan.identitySelection.localCallees ?? new Map());
    importedCallsBySource.set(sourceFile, plan.importedCalls);
  }
  const mutation = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PLAN;
  let mutationApplied = false;
  for (const use of graph.uses) {
    const owner = selected.get(use.ownerUnitId);
    const target = selected.get(use.targetUnitId);
    if (!owner || !target) continue;
    const plan = plans.get(owner.sourceFile);
    if (!plan) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable graph use owner ${owner.unitId} has no exact cached source plan`,
      );
    }
    if (owner.sourceId === target.sourceId) {
      let localCallees = localCalleesBySource.get(owner.sourceFile);
      let targetUnitIds = localCallees?.get(owner.unitId);
      if (mutation === "missing-local-plan" && !mutationApplied) {
        if (!targetUnitIds?.has(target.unitId)) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            `callable missing-local-plan mutation found no selected same-source edge ${owner.unitId} -> ${target.unitId}`,
          );
        }
        const projected = new Map(localCallees ?? []);
        const projectedTargets = new Set(targetUnitIds);
        projectedTargets.delete(target.unitId);
        projected.set(owner.unitId, projectedTargets);
        localCalleesBySource.set(owner.sourceFile, projected);
        localCallees = projected;
        targetUnitIds = projectedTargets;
        mutationApplied = true;
      }
      if (!targetUnitIds?.has(target.unitId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable graph use ${owner.unitId} -> ${target.unitId} is missing its exact cached local call plan`,
        );
      }
      continue;
    }
    let importedCalls = importedCallsBySource.get(owner.sourceFile);
    const originalCallPlan = importedCalls?.get(use.node);
    if (mutation === "missing-imported-plan" && !mutationApplied) {
      if (!originalCallPlan) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable missing-imported-plan mutation found no selected cross-source call ${owner.unitId} -> ${target.unitId}`,
        );
      }
      const projected = new Map(importedCalls ?? []);
      projected.delete(use.node);
      importedCallsBySource.set(owner.sourceFile, projected);
      importedCalls = projected;
      mutationApplied = true;
    }
    const callPlan = importedCalls?.get(use.node);
    const plannedUse = callPlan
      ? aggregateProgramCallableUse(graph, records, use.node, owner.unitId, callPlan)
      : undefined;
    if (
      !callPlan ||
      callPlan.source !== "module-import" ||
      callPlan.ownerUnitId !== owner.unitId ||
      callPlan.target.binding.kind !== "unit" ||
      callPlan.target.binding.unitId !== target.unitId ||
      !plannedUse ||
      plannedUse.ownerUnitId !== use.ownerUnitId ||
      plannedUse.targetUnitId !== use.targetUnitId ||
      plannedUse.bindingId !== use.bindingId ||
      plannedUse.canonicalBindingId !== use.canonicalBindingId
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable graph use ${owner.unitId} -> ${target.unitId} is missing its exact cached imported call plan`,
      );
    }
  }
  if (mutation === "missing-local-plan" && !mutationApplied) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "callable missing-local-plan mutation found no selected same-source graph use",
    );
  }
  if (mutation === "missing-imported-plan" && !mutationApplied) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "callable missing-imported-plan mutation found no selected cross-source graph use",
    );
  }
  if (mutation !== undefined && mutation !== "missing-local-plan" && mutation !== "missing-imported-plan") {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `unknown callable cached-plan mutation ${JSON.stringify(mutation)}`,
    );
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
  const plans = new Map<ts.SourceFile, IrOverlayPlan>();
  for (const sourceFile of input.multiAst.sourceFiles) {
    const sourceId = input.identityContext.sourceIdBySourceFile.get(sourceFile);
    if (!sourceId) throw new IrInvariantError("selection-preparation-mismatch", "resolve", "missing source identity");
    plans.set(sourceFile, input.planSource(sourceFile));
  }
  // The graph and identity inventory are the attempted census authority. The
  // cached overlay plans above are consulted only after this immutable graph
  // population has been published below.
  const preflightComponents = preflightMultiPreparedCallableComponents(input, graph);
  if (preflightComponents.length === 0) return;
  const { attempted, preflightDeclarationNodesByUnitId } = publishCallableAttemptCensus(
    input,
    graph,
    preflightComponents,
  );
  assertCallableGraphUsesMatchCachedPlans(input, graph, records, plans, preflightComponents);

  // Dedicated planning runs before the aggregate census and can project a
  // same-spelled function out of its source selection. Re-open only the exact
  // graph-member claim that remains override-ready and has no preparation
  // failure. This preserves M1.3's name-invariant reconciliation without
  // making the source plan define the graph-first attempted denominator.
  for (const group of preflightComponents) {
    for (const member of group) {
      const plan = plans.get(member.sourceFile);
      const claim = plan?.functionClaimsByUnitId.get(member.unitId);
      if (
        plan &&
        claim?.declaration === member.declaration &&
        claim.legacyName === member.legacyName &&
        plan.overrideMapByUnitId.has(member.unitId) &&
        plan.identityPlan.identitySelection.funcs.has(member.unitId) &&
        !plan.preparationFailuresByUnitId.has(member.unitId)
      ) {
        plan.identityPlan.safeFunctionUnitIds.add(member.unitId);
      }
    }
  }
  const assertPreflightCurrent = (): void => {
    const bodyMutation = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_DECLARATION_BODY;
    if (
      bodyMutation !== undefined &&
      bodyMutation !== "1" &&
      bodyMutation !== "nested-return-expression" &&
      bodyMutation !== "nested-binary-right" &&
      bodyMutation !== "nested-last-return-expression"
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `unknown callable declaration-body mutation ${JSON.stringify(bodyMutation)}`,
      );
    }
    const stagedBodyMutation = process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_STAGED_BODY;
    if (stagedBodyMutation !== undefined && stagedBodyMutation !== "1") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `unknown staged callable body mutation ${JSON.stringify(stagedBodyMutation)}`,
      );
    }
    const stagedBodyDeclaration = stagedBodyMutation === "1" ? preflightComponents[0]?.[0]?.declaration : undefined;
    const stagedBodyTarget = stagedBodyDeclaration as { body: ts.Block | undefined } | undefined;
    const originalStagedBody = stagedBodyTarget?.body;
    if (stagedBodyTarget && originalStagedBody) stagedBodyTarget.body = undefined;
    const mutationTarget = bodyMutation === "1" ? preflightComponents[0]?.[0]?.declaration : undefined;
    const mutableMutationTarget = mutationTarget as { body: ts.Block | undefined } | undefined;
    const originalMutationBody = mutableMutationTarget?.body;
    const nestedMutation: NestedCallableDeclarationMutation | undefined =
      bodyMutation === "nested-return-expression" || bodyMutation === "nested-binary-right"
        ? bodyMutation
        : bodyMutation === "nested-last-return-expression"
          ? "nested-return-expression"
          : undefined;
    let restoreNestedMutation: (() => void) | undefined;
    if (mutableMutationTarget && originalMutationBody) {
      mutableMutationTarget.body = ts.factory.createBlock([...originalMutationBody.statements], true);
    } else if (nestedMutation) {
      const nestedMutationTarget =
        bodyMutation === "nested-last-return-expression"
          ? preflightComponents.at(-1)?.at(-1)?.declaration
          : preflightComponents[0]?.[0]?.declaration;
      restoreNestedMutation = nestedMutationTarget
        ? replaceNestedCallableDeclarationNode(nestedMutationTarget, nestedMutation)
        : undefined;
      if (!restoreNestedMutation) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable declaration-body mutation ${JSON.stringify(bodyMutation)} found no nested target`,
        );
      }
    }
    try {
      currentCallableAttemptCensus(input.ctx, "final callable publication", input.identityContext);
      for (const group of preflightComponents) {
        for (const member of group) {
          const terminal = input.identityContext.terminalByUnitId.get(member.unitId);
          const stagedNodes = preflightDeclarationNodesByUnitId.get(member.unitId);
          const currentNodes = snapshotCallableDeclarationNodes(member.declaration);
          if (
            input.identityContext.sourceIdBySourceFile.get(member.sourceFile) !== member.sourceId ||
            input.identityContext.sourceFileBySourceId.get(member.sourceId) !== member.sourceFile ||
            input.identityContext.unitByUnitId.get(member.unitId) !== terminal ||
            terminal?.sourceId !== member.sourceId ||
            terminal.kind !== "top-level-function" ||
            terminal.observedKind !== "function" ||
            terminal.terminalOwnerId !== member.unitId ||
            input.identityContext.declarationByUnitId.get(member.unitId) !== member.declaration ||
            input.identityContext.unitIdByDeclaration.get(member.declaration) !== member.unitId ||
            member.declaration.parent !== member.sourceFile ||
            member.declaration.name?.text !== member.legacyName ||
            !member.declaration.body ||
            stagedNodes === undefined ||
            currentNodes.length !== stagedNodes.length ||
            currentNodes.some((node, index) => node !== stagedNodes[index])
          ) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "resolve",
              `callable preflight unit ${member.unitId} changed before final publication`,
            );
          }
        }
      }
    } finally {
      if (mutableMutationTarget && originalMutationBody) mutableMutationTarget.body = originalMutationBody;
      if (stagedBodyTarget && originalStagedBody) stagedBodyTarget.body = originalStagedBody;
      restoreNestedMutation?.();
    }
  };

  const preflightMemberByUnitId = new Map(
    preflightComponents.flatMap((group) => group.map((member) => [member.unitId, member] as const)),
  );
  const candidates = new Map<IrUnitId, MultiPreparedCallableCandidate>();
  for (const [sourceFile, plan] of plans) {
    const sourceId = input.identityContext.sourceIdBySourceFile.get(sourceFile)!;
    const safeSelection = input.safeSelection(plan, sourceFile);
    for (const [unitId, claim] of plan.functionClaimsByUnitId) {
      const member = preflightMemberByUnitId.get(unitId);
      if (!attempted.has(unitId) || !member || member.sourceFile !== sourceFile) continue;
      const terminal = input.identityContext.terminalByUnitId.get(unitId);
      if (
        input.owner.existingRouteUnitIds.has(unitId) ||
        claim.declaration !== member.declaration ||
        claim.legacyName !== member.legacyName ||
        !plan.identityPlan.safeFunctionUnitIds.has(unitId) ||
        !safeSelection.funcs.has(claim.legacyName) ||
        terminal?.sourceId !== sourceId ||
        terminal.kind !== "top-level-function" ||
        terminal.observedKind !== "function" ||
        terminal.terminalOwnerId !== unitId ||
        !ownerIsEligible(input, graph, records, sourceFile, sourceId, plan, unitId, claim.declaration)
      ) {
        continue;
      }
      candidates.set(
        unitId,
        Object.freeze({
          sourceFile,
          sourceId,
          unitId,
          legacyName: claim.legacyName,
          declaration: claim.declaration,
          plan,
        }),
      );
    }
  }
  const components: MultiPreparedProgramCallableComponent[] = [];
  try {
    for (const [groupIndex, preflightGroup] of preflightComponents.entries()) {
      const group = preflightGroup
        .map(({ unitId }) => candidates.get(unitId))
        .filter((candidate) => candidate !== undefined);
      // The preflight census remains authoritative even when any member declines
      // later selection or route eligibility. Never regroup the surviving subset.
      if (group.length !== preflightGroup.length) continue;
      const component = prepareMultiPreparedCallableGroup({
        ctx: input.ctx,
        multiAst: input.multiAst,
        identityContext: input.identityContext,
        group,
        groupIndex,
        candidatePlans: plans,
        graph,
        recordsByBindingId: records,
        aggregateProgramCallableUse,
        rewriteAggregateCallableRef,
        assertPreflightCurrent,
      });
      if (component) {
        // Retain the receipt before any post-return validation so a malformed
        // current component is closed together with every earlier component.
        components.push(component);
        const expectedUnitIds = preflightGroup.map(({ unitId }) => unitId);
        const observedUnitIds = component.units.map(({ unitId }) => unitId);
        if (
          observedUnitIds.length !== expectedUnitIds.length ||
          observedUnitIds.some((unitId, index) => unitId !== expectedUnitIds[index])
        ) {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            `callable prepared component ${component.preparedComponentId} changed its immutable preflight population`,
          );
        }
      }
    }
    const prepared = new Set(components.flatMap((component) => component.units.map(({ unitId }) => unitId)));
    for (const unitId of prepared) {
      if (!attempted.has(unitId)) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `callable prepared unit ${unitId} was outside the immutable attempted census`,
        );
      }
    }
    currentCallableAttemptCensus(input.ctx, "callable owner staging");
    if (components.length > 0) input.owner.stageCallableComponents(components);
  } catch (error) {
    for (const component of components) {
      try {
        component.pendingReceipt.abort();
      } catch {
        // Preserve the primary pre-publication failure when a scope is already terminal.
      }
    }
    throw error;
  }
}

export function removeMultiIrAttemptedCallableUnits(
  ctx: CodegenContext,
  plan: IrOverlayPlan,
  selection: IrSelection,
): IrSelection {
  const census = currentCallableAttemptCensus(ctx, "ordinary overlay withdrawal", plan.identityPlan.identityContext);
  const attempted = census?.attemptedUnitIds;
  if (!attempted?.size) return selection;
  const retained = new Set(
    [...selection.funcs].map((name) => {
      const unitId = plan.identityPlan.functionUnitIdByLegacyName.get(name);
      if (!unitId) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "resolve",
          `ordinary overlay retained callable ${name} without exact source identity`,
        );
      }
      return unitId;
    }),
  );
  const sourceAttempted = new Set([...plan.functionClaimsByUnitId.keys()].filter((unitId) => attempted.has(unitId)));
  if (sourceAttempted.size === 0) return selection;
  const sourceIds = new Set(
    [...plan.functionClaimsByUnitId.keys()].map(
      (unitId) => plan.identityPlan.identityContext.unitByUnitId.get(unitId)?.sourceId,
    ),
  );
  if (sourceIds.size !== 1 || sourceIds.has(undefined)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "ordinary callable overlay has no exact single-source identity",
    );
  }
  const sourceFile = plan.identityPlan.identityContext.sourceFileBySourceId.get([...sourceIds][0]!);
  if (!sourceFile) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "ordinary callable overlay source identity has no active SourceFile",
    );
  }
  const closed = closeIrBlockedComponentByIdentity(
    sourceFile,
    plan.identityPlan.identityContext,
    retained,
    sourceAttempted,
  );
  for (const unitId of retained) {
    if (!attempted.has(unitId) && !closed.has(unitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `callable attempted census omitted source-local neighbor ${unitId}`,
      );
    }
  }
  const funcs = new Set(
    [...selection.funcs].filter((name) => {
      const unitId = plan.identityPlan.functionUnitIdByLegacyName.get(name);
      return unitId !== undefined && closed.has(unitId);
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
