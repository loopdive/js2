// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrImportedCallLoweringPlan, IrImportedOptionalParamPlan } from "../ir/ast-lowering-plans.js";
import { collectIrClassInstanceInitializers } from "../ir/class-instance-initializers.js";
import { irArgcGlobalRef, irSupportGlobalRef } from "../ir/abi-bindings.js";
import { irImportFuncRef, irSupportFuncRef, irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrAmbientClassCallResolver } from "../ir/host-extern.js";
import type { IrIdentityImportedFunctionResolver, IrImportedFunctionResolver } from "../ir/imported-functions.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrType } from "../ir/nodes.js";
import { classifyIrFailure, IrInvariantError, IrUnsupportedError, type IrPreparationFailure } from "../ir/outcomes.js";
import type { LatticeType } from "../ir/propagate.js";
import {
  certifyImportedIrCall,
  effectiveIrParamTypeNode,
  effectiveIrReturnTypeNode,
  type IrSelection,
} from "../ir/select.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import type { IrClassShapeLookup } from "./ir-class-shapes.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import {
  planIrCompilerTimerShimCall,
  shouldVisitIrImportedCallBody,
  type IrPreparedTimerShimResolver,
} from "./ir-timer-shim-planning.js";

export interface IrImportedCallPlanningState {
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly preparationFailuresByUnitId: Map<IrUnitId, IrPreparationFailure>;
}

export interface IrImportedCallOverlayPlan extends IrImportedCallPlanningState {
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
}

export interface IrMutableCallSelection {
  funcs: Set<string>;
  classMembers?: ReadonlySet<string>;
  moduleInit?: IrSelection["moduleInit"];
}

type IrPositionTypeResolver = (
  node: ts.TypeNode | undefined,
  mapped: LatticeType | undefined,
  classShapes: IrClassShapeLookup,
) => IrType;

export function recordIrOverlayPreparationFailure(
  plan: IrImportedCallPlanningState,
  legacyName: string,
  failure: IrPreparationFailure,
): void {
  const unitId = irOverlayIdentity.requireIrOverlayUnitId(plan.identityPlan, legacyName);
  const previous = plan.preparationFailuresByUnitId.get(unitId);
  if (previous && previous !== failure) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `IR unit ${unitId} / ${legacyName} received more than one preparation result`,
    );
  }
  plan.preparationFailuresByUnitId.set(unitId, failure);
}

function ambientHostValType(type: IrType | null): ValType | null | undefined {
  if (type === null) return null;
  if (type.kind === "string") return { kind: "externref" };
  if (type.kind !== "val") return undefined;
  if (type.val.kind === "f64" || type.val.kind === "i32") return type.val;
  return undefined;
}

function sameAmbientHostValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

function hasPreparedAmbientHostImport(ctx: CodegenContext, plan: IrImportedCallLoweringPlan): boolean {
  if (plan.source !== "ambient-host" || plan.target.binding.kind !== "import" || plan.target.binding.module !== "env") {
    return false;
  }
  const params = plan.params.map(ambientHostValType);
  const result = ambientHostValType(plan.returnType);
  if (params.some((param) => param === undefined) || result === undefined) return false;

  const targetName = plan.target.binding.field;
  const funcIdx = ctx.funcMap.get(targetName);
  if (funcIdx === undefined || funcIdx < 0 || funcIdx >= ctx.numImportFuncs) return false;
  let importFuncIdx = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (importFuncIdx++ !== funcIdx) continue;
    if (imported.module !== plan.target.binding.module || imported.name !== targetName) return false;
    const type = ctx.mod.types[imported.desc.typeIdx];
    const expectedParams = params as ValType[];
    const expectedResults = result === null ? [] : [result];
    return (
      type?.kind === "func" &&
      type.params.length === expectedParams.length &&
      type.results.length === expectedResults.length &&
      type.params.every((param, index) => sameAmbientHostValType(param, expectedParams[index]!)) &&
      type.results.every((actual, index) => sameAmbientHostValType(actual, expectedResults[index]!))
    );
  }
  return false;
}

/**
 * Prove declaration collection materialized every certified class-member
 * ambient call as the exact env import before lowering.
 */
export function prepareIrAmbientClassCallLowering(
  ctx: CodegenContext,
  plan: IrImportedCallOverlayPlan,
  selection: IrSelection,
): IrSelection {
  const classMembers = new Set(selection.classMembers ?? []);
  if (classMembers.size === 0) return selection;
  const blocked = new Set<string>();
  for (const callPlan of plan.importedCalls.values()) {
    if (
      callPlan.source === "ambient-host" &&
      classMembers.has(callPlan.ownerName) &&
      !hasPreparedAmbientHostImport(ctx, callPlan)
    ) {
      blocked.add(callPlan.ownerName);
    }
  }
  if (blocked.size === 0) return selection;
  for (const ownerName of blocked) {
    classMembers.delete(ownerName);
    recordIrOverlayPreparationFailure(plan, ownerName, {
      kind: "unsupported",
      code: "late-preparation-unsupported",
      stage: "resolve",
      detail: "the checker-certified ambient function is absent from the final env import manifest",
    });
  }
  return { ...selection, classMembers };
}

function importedVoidCallIsDiscarded(call: ts.CallExpression, owner: ts.FunctionDeclaration): boolean {
  let current: ts.Expression = call;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isVoidExpression(parent) && parent.expression === current) return true;
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === current || parent.whenFalse === current)) {
      current = parent;
      continue;
    }
    if (ts.isCommaListExpression(parent) && parent.elements.some((element) => element === current)) {
      current = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      (parent.left === current || parent.right === current)
    ) {
      current = parent;
      continue;
    }
    break;
  }
  const parent = current.parent;
  if (ts.isExpressionStatement(parent) && parent.expression === current) return true;
  return (
    ts.isReturnStatement(parent) &&
    parent.expression === current &&
    effectiveIrReturnTypeNode(owner)?.kind === ts.SyntaxKind.VoidKeyword
  );
}

function programCallableBoundaryUse(
  ctx: CodegenContext,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
  ownerUnitId: IrUnitId,
  call: ts.CallExpression,
): import("../ir/program-callable-bindings.js").IrProgramCallableUse | undefined {
  const graph = ctx.irProgramCallableCutoverEnabled ? ctx.irProgramCallableBindingGraph : undefined;
  if (!graph) return undefined;
  const use = graph.resolveCall(call, ownerUnitId);
  if (!use) return undefined;
  const record = graph.records.find((candidate) => candidate.bindingId === use.bindingId);
  const ownerUnit = identityPlan.identityContext.unitByUnitId.get(ownerUnitId);
  const targetUnit = identityPlan.identityContext.unitByUnitId.get(use.targetUnitId);
  if (!record || !ownerUnit || !targetUnit) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `callable graph use for ${ownerUnitId} has no exact binding/unit join`,
    );
  }
  // Source bindings are handled by the ordinary local call graph. Only
  // explicit alias bindings cross the M1A boundary; this keeps global-script
  // calls on the legacy path until their route is migrated separately.
  if (record.kind === "source") return undefined;
  return use;
}

function targetBodyUsesArguments(declaration: ts.FunctionDeclaration): boolean {
  if (!declaration.body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && node.text === "arguments") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

function planProgramCallableCall(
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
  ownerName: string,
  owner: ts.FunctionDeclaration,
  call: ts.CallExpression,
  use: import("../ir/program-callable-bindings.js").IrProgramCallableUse,
  classShapeSidecar: IrClassShapeLookup,
  resolvePositionType: IrPositionTypeResolver,
): IrImportedCallLoweringPlan {
  if (call.questionDotToken || call.typeArguments?.length || call.arguments.some(ts.isSpreadElement)) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      "optional, generic, and spread callable calls are outside the fixed-target M1A surface",
    );
  }
  const target = identityPlan.identityContext.declarationByUnitId.get(use.targetUnitId);
  const terminal = identityPlan.identityContext.terminalByUnitId.get(use.targetUnitId);
  const targetUnit = identityPlan.identityContext.unitByUnitId.get(use.targetUnitId);
  if (
    !target ||
    !ts.isFunctionDeclaration(target) ||
    !target.body ||
    !terminal ||
    terminal.observedKind !== "function" ||
    !targetUnit
  ) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} has no exact source function body`,
    );
  }
  const targetSourceId = targetUnit?.sourceId;
  const ownerSourceId = identityPlan.identityContext.unitByUnitId.get(use.ownerUnitId)?.sourceId;
  const targetSourceFile = targetSourceId
    ? identityPlan.identityContext.sourceFileBySourceId.get(targetSourceId)
    : undefined;
  const ownerSourceFile = ownerSourceId
    ? identityPlan.identityContext.sourceFileBySourceId.get(ownerSourceId)
    : undefined;
  if (
    !targetSourceId ||
    !ownerSourceId ||
    !targetSourceFile ||
    !ownerSourceFile ||
    target.getSourceFile() !== targetSourceFile ||
    call.getSourceFile() !== ownerSourceFile ||
    use.sourceId !== ownerSourceId
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      `callable target ${use.targetUnitId} is not joined to its graph source`,
    );
  }
  if (
    target.typeParameters?.length ||
    target.asteriskToken ||
    target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} is generic, async, or generator-owned`,
    );
  }
  if (targetBodyUsesArguments(target)) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} reads arguments`,
    );
  }
  if (call.arguments.length !== target.parameters.length) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} has a non-fixed arity at the call site`,
    );
  }
  const params = target.parameters.map((parameter) =>
    resolvePositionType(effectiveIrParamTypeNode(parameter), undefined, classShapeSidecar),
  );
  if (params.some((parameter) => parameter.kind === "callable")) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} has a callable parameter`,
    );
  }
  const returnNode = effectiveIrReturnTypeNode(target);
  const returnType =
    returnNode?.kind === ts.SyntaxKind.VoidKeyword
      ? null
      : resolvePositionType(returnNode, undefined, classShapeSidecar);
  if (returnType?.kind === "callable") {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      `callable target ${use.targetUnitId} returns a callable value`,
    );
  }
  if (returnType === null && !importedVoidCallIsDiscarded(call, owner)) {
    throw new IrUnsupportedError(
      "imported-call-planning-unsupported",
      "resolve",
      "void callable result is used in a value context",
    );
  }
  const compatibilityName = target.name?.text ?? terminal.legacyMatchName ?? use.targetUnitId;
  return {
    source: "module-import",
    ownerUnitId: use.ownerUnitId,
    ownerName,
    target: irUnitFuncRef({ unitId: use.targetUnitId, name: compatibilityName }),
    params,
    returnType,
    optionalParams: new Map(),
    needsArgc: false,
  };
}

interface IrImportedOverlayPlans {
  readonly importedCalls: Map<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: Map<
    ts.Identifier,
    import("../ir/ast-lowering-plans.js").IrTopLevelFunctionValueLoweringPlan
  >;
}

function planSourceUnitImportedCalls(
  ctx: CodegenContext,
  state: IrImportedCallPlanningState,
  identityImportedFunctions: IrIdentityImportedFunctionResolver | undefined,
  legacyImportedFunctions: IrImportedFunctionResolver | undefined,
  resolvePreparedTimerShim: IrPreparedTimerShimResolver | undefined,
  classShapeSidecar: IrClassShapeLookup,
  safeSelection: IrMutableCallSelection,
  resolvePositionType: IrPositionTypeResolver,
): IrImportedOverlayPlans {
  const { identityPlan } = state;
  const importedCalls = new Map<ts.CallExpression, IrImportedCallLoweringPlan>();
  const topLevelFunctionValues = new Map<
    ts.Identifier,
    import("../ir/ast-lowering-plans.js").IrTopLevelFunctionValueLoweringPlan
  >();
  const planIdentity = identityImportedFunctions
    ? irOverlayIdentity.makeIrFeaturePlanIdentity(identityPlan, identityImportedFunctions)
    : undefined;
  const entrySourceId = identityPlan.identityContext.inventory.sources.find((source) => source.kind === "entry")?.id;
  if (identityImportedFunctions && !entrySourceId) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "imported lowering requires one exact entry-source identity",
    );
  }
  for (const [ownerName, declaration] of identityPlan.declarationByLegacyName) {
    if (!safeSelection.funcs.has(ownerName) || !declaration.body) continue;
    const ownerUnitId = irOverlayIdentity.requireIrOverlayUnitId(identityPlan, ownerName);
    let planningFailure: IrPreparationFailure | undefined;
    let preparedTimerShim: ReturnType<typeof planIrCompilerTimerShimCall>;
    try {
      preparedTimerShim = planIrCompilerTimerShimCall(resolvePreparedTimerShim, declaration, ownerName, identityPlan);
      if (preparedTimerShim) importedCalls.set(preparedTimerShim.call, preparedTimerShim.plan);
    } catch (error) {
      planningFailure = classifyIrFailure(error, "resolve");
    }
    const visit = (node: ts.Node): void => {
      if (planningFailure) return;
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const graphUse = programCallableBoundaryUse(ctx, identityPlan, ownerUnitId, node);
        if (graphUse) {
          try {
            importedCalls.set(
              node,
              planProgramCallableCall(
                identityPlan,
                ownerName,
                declaration,
                node,
                graphUse,
                classShapeSidecar,
                resolvePositionType,
              ),
            );
          } catch (error) {
            planningFailure = classifyIrFailure(error, "resolve");
            return;
          }
        } else if (planIdentity) {
          const certified = certifyImportedIrCall(node, legacyImportedFunctions);
          if (certified) {
            try {
              if (
                process.env.JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW === "1" ||
                process.env.JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW === ownerName
              ) {
                throw new Error(`injected imported-call planning failure for ${ownerName}`);
              }
              const params = certified.target.declaration.parameters.map((parameter) =>
                resolvePositionType(effectiveIrParamTypeNode(parameter), undefined, classShapeSidecar),
              );
              const returnNode = effectiveIrReturnTypeNode(certified.target.declaration);
              const returnType =
                returnNode?.kind === ts.SyntaxKind.VoidKeyword
                  ? null
                  : resolvePositionType(returnNode, undefined, classShapeSidecar);
              if (returnType === null && !importedVoidCallIsDiscarded(node, declaration)) {
                throw new IrUnsupportedError(
                  "imported-call-planning-unsupported",
                  "resolve",
                  "void imported result is used in a value context",
                );
              }
              if (returnType?.kind === "callable") {
                throw new IrUnsupportedError(
                  "imported-call-planning-unsupported",
                  "resolve",
                  "callable imported results are outside A+B1",
                );
              }
              const optionalParams = new Map<number, IrImportedOptionalParamPlan>();
              for (const optional of ctx.funcOptionalParams.get(certified.target.targetName) ?? []) {
                optionalParams.set(optional.index, {
                  ...(optional.constantDefault ? { constantDefault: optional.constantDefault } : {}),
                  ...(optional.hasExpressionDefault ? { hasExpressionDefault: true } : {}),
                });
              }
              const importedIdentity = planIdentity.imported(ownerName, node.expression, certified.target);
              const needsArgc =
                ctx.funcUsesArguments.has(certified.target.targetName) ||
                ctx.funcOptionalParams.has(certified.target.targetName);
              importedCalls.set(node, {
                source: "module-import",
                ...importedIdentity,
                ownerName,
                params,
                returnType,
                optionalParams,
                needsArgc,
                ...(needsArgc ? { argcGlobal: irArgcGlobalRef(entrySourceId!) } : {}),
              });
              for (const functionArgument of certified.functionArguments) {
                const valueIdentity = planIdentity.value(ownerName, functionArgument.argument, functionArgument.target);
                if (valueIdentity.target.binding.kind !== "unit") {
                  throw new IrInvariantError(
                    "selection-preparation-mismatch",
                    "resolve",
                    `function-value target ${valueIdentity.target.name} has no exact source-unit binding`,
                  );
                }
                const trampolineName = `__fn_tramp_${functionArgument.target.targetName}_cached`;
                const cacheGlobalName = `__fn_closure_${functionArgument.target.targetName}`;
                topLevelFunctionValues.set(functionArgument.argument, {
                  ...valueIdentity,
                  ownerName,
                  signature: functionArgument.signature,
                  trampoline: irSupportFuncRef(
                    valueIdentity.target.binding.unitId,
                    "function-value-trampoline",
                    trampolineName,
                  ),
                  cacheGlobal: irSupportGlobalRef(
                    valueIdentity.target.binding.unitId,
                    "function-value-cache",
                    cacheGlobalName,
                  ),
                  cacheGlobalName,
                });
              }
            } catch (error) {
              planningFailure = classifyIrFailure(error, "resolve");
              return;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (
      shouldVisitIrImportedCallBody(
        planIdentity !== undefined ||
          (ctx.irProgramCallableCutoverEnabled === true && ctx.irProgramCallableBindingGraph !== undefined),
        preparedTimerShim !== undefined,
      )
    ) {
      visit(declaration.body);
    }
    if (planningFailure) {
      recordIrOverlayPreparationFailure(state, ownerName, planningFailure);
      safeSelection.funcs.delete(ownerName);
      irOverlayIdentity.dropIrSafeFunctionByLegacyName(identityPlan, ownerName);
      for (const [call, plan] of importedCalls) {
        if (plan.ownerName === ownerName) importedCalls.delete(call);
      }
      for (const [identifier, plan] of topLevelFunctionValues) {
        if (plan.ownerName === ownerName) topLevelFunctionValues.delete(identifier);
      }
    }
  }
  return { importedCalls, topLevelFunctionValues };
}

function appendAmbientClassCalls(
  state: IrImportedCallPlanningState,
  resolveAmbientClassCall: IrAmbientClassCallResolver,
  classShapeSidecar: IrClassShapeLookup,
  safeSelection: IrMutableCallSelection,
  importedCalls: Map<ts.CallExpression, IrImportedCallLoweringPlan>,
  resolvePositionType: IrPositionTypeResolver,
): void {
  const { identityPlan } = state;
  const retainedClassMembers = new Set(safeSelection.classMembers ?? []);
  if (retainedClassMembers.size === 0) return;

  for (const [ownerUnitId, owner] of identityPlan.identitySelection.classMembers ?? []) {
    const ownerName = owner.legacyMatchName;
    if (!retainedClassMembers.has(ownerName)) continue;
    const declaration = identityPlan.identityContext.declarationByUnitId.get(ownerUnitId);
    const implicitConstructor =
      identityPlan.identityContext.terminalByUnitId.get(ownerUnitId)?.kind === "class-implicit-constructor";
    const executableRoots =
      implicitConstructor && declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
        ? collectIrClassInstanceInitializers(declaration)?.map(({ expression }) => expression)
        : declaration &&
            (ts.isMethodDeclaration(declaration) ||
              ts.isGetAccessorDeclaration(declaration) ||
              ts.isSetAccessorDeclaration(declaration) ||
              ts.isConstructorDeclaration(declaration)) &&
            declaration.body
          ? [declaration.body]
          : undefined;
    if (!executableRoots) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `ambient class-call owner ${ownerUnitId} / ${ownerName} has no exact executable declaration`,
      );
    }

    let planningFailure: IrPreparationFailure | undefined;
    const visit = (node: ts.Node): void => {
      if (planningFailure) return;
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const certified = resolveAmbientClassCall(node);
        if (certified) {
          try {
            const params = certified.declaration.parameters.map((parameter) =>
              resolvePositionType(effectiveIrParamTypeNode(parameter), undefined, classShapeSidecar),
            );
            const returnType = resolvePositionType(
              effectiveIrReturnTypeNode(certified.declaration),
              undefined,
              classShapeSidecar,
            );
            if (importedCalls.has(node)) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "resolve",
                `ambient and source-unit imported-call plans overlap at ${node.getSourceFile().fileName}:${node.pos}`,
              );
            }
            importedCalls.set(node, {
              source: "ambient-host",
              ownerUnitId,
              ownerName,
              target: irImportFuncRef("env", certified.targetName),
              params,
              returnType,
              optionalParams: new Map(),
              needsArgc: false,
            });
          } catch (error) {
            planningFailure = classifyIrFailure(error, "resolve");
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const root of executableRoots) visit(root);
    if (planningFailure) {
      recordIrOverlayPreparationFailure(state, ownerName, planningFailure);
      retainedClassMembers.delete(ownerName);
      for (const [call, plan] of importedCalls) {
        if (plan.source === "ambient-host" && plan.ownerUnitId === ownerUnitId) importedCalls.delete(call);
      }
    }
  }
  safeSelection.classMembers = retainedClassMembers;
}

export interface PlanIrImportedCallsOptions extends IrImportedCallPlanningState {
  readonly ctx: CodegenContext;
  readonly identityImportedFunctions?: IrIdentityImportedFunctionResolver;
  readonly legacyImportedFunctions?: IrImportedFunctionResolver;
  readonly resolvePreparedTimerShim?: IrPreparedTimerShimResolver;
  readonly resolveAmbientClassCall?: IrAmbientClassCallResolver;
  readonly classShapeSidecar: IrClassShapeLookup;
  readonly safeSelection: IrMutableCallSelection;
  readonly resolvePositionType: IrPositionTypeResolver;
}

export function planIrImportedCalls(options: PlanIrImportedCallsOptions): IrImportedOverlayPlans {
  const {
    ctx,
    identityImportedFunctions,
    legacyImportedFunctions,
    resolvePreparedTimerShim,
    resolveAmbientClassCall,
    classShapeSidecar,
    safeSelection,
    resolvePositionType,
  } = options;
  const plans =
    identityImportedFunctions || resolvePreparedTimerShim || ctx.irProgramCallableBindingGraph
      ? planSourceUnitImportedCalls(
          ctx,
          options,
          identityImportedFunctions,
          legacyImportedFunctions,
          resolvePreparedTimerShim,
          classShapeSidecar,
          safeSelection,
          resolvePositionType,
        )
      : {
          importedCalls: new Map<ts.CallExpression, IrImportedCallLoweringPlan>(),
          topLevelFunctionValues: new Map<
            ts.Identifier,
            import("../ir/ast-lowering-plans.js").IrTopLevelFunctionValueLoweringPlan
          >(),
        };
  if (resolveAmbientClassCall) {
    appendAmbientClassCalls(
      options,
      resolveAmbientClassCall,
      classShapeSidecar,
      safeSelection,
      plans.importedCalls,
      resolvePositionType,
    );
  }
  return plans;
}
