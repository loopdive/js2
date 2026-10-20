// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type {
  IrImportedCallLoweringPlan,
  IrImportedOptionalParamPlan,
  IrTopLevelFunctionValueLoweringPlan,
} from "../ir/ast-lowering-plans.js";
import { planIrNestedClassFieldCalls } from "../ir/class-field-call-planning.js";
import type { MultiPreparedFunctionValueSupportReceipt } from "./multi-prepared-scalar-leaf.js";
import { collectIrClassInstanceInitializers } from "../ir/class-instance-initializers.js";
import { irArgcGlobalRef, irSupportGlobalRef } from "../ir/abi-bindings.js";
import { irImportFuncRef, irSupportFuncRef, irUnitFuncRef, sameIrCallableBinding } from "../ir/callable-bindings.js";
import type { IrAmbientClassCallResolver } from "../ir/host-extern.js";
import type { IrIdentityImportedFunctionResolver, IrImportedFunctionResolver } from "../ir/imported-functions.js";
import type { IrUnitId, IrNestedClassFieldCallAdmission } from "../ir/identity.js";
import type { IrType } from "../ir/nodes.js";
import { classifyIrFailure, IrInvariantError, IrUnsupportedError, type IrPreparationFailure } from "../ir/outcomes.js";
import type { LatticeType } from "../ir/propagate.js";
import {
  certifiedImportedHofCall,
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
import { readEnv } from "../env.js";
import { ensureFuncClosureSingletonAccessor } from "./closures/funcref-as-closure.js";
import { definedFuncAt, funcSignatureOf } from "./func-space.js";
import { sourceFunctionDeclarationForHandle } from "./program-abi-source-callable-planning.js";
import { localGlobalIdx } from "./registry/imports.js";
import { planProgramAbiFunctionValue } from "./program-abi-planning.js";

/** Apply the same live-binding exclusions as the canonical direct value reader. */
export function makeIrFunctionObjectValueResolver(
  ctx: CodegenContext,
  resolver: IrIdentityImportedFunctionResolver,
): IrIdentityImportedFunctionResolver {
  return {
    resolveImportedFunctionTarget: (node) => resolver.resolveImportedFunctionTarget(node),
    isImportBinding: (node) => resolver.isImportBinding(node),
    resolveTopLevelFunctionValueTarget(node) {
      if (ctx.runtimeEvalGlobalFunctionBindings === true) return undefined;
      const target = resolver.resolveTopLevelFunctionValueTarget(node);
      return target && !ctx.reassignedFunctionDeclarations?.has(target.declaration) ? target : undefined;
    },
  };
}

/** Revalidate a certified receiver against the current exact source/allocator tuple. */
export function hasPreparedFunctionObjectReference(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  plan: IrTopLevelFunctionValueLoweringPlan | undefined,
  identity: irOverlayIdentity.IrOverlayIdentityPlan,
  ownerUnitId: IrUnitId,
  sourceOwnerUnitId: (node: ts.Node) => IrUnitId,
): boolean {
  if (
    !plan?.objectReceiver ||
    !plan.accessor ||
    plan.ownerUnitId !== ownerUnitId ||
    ctx.runtimeEvalGlobalFunctionBindings === true ||
    plan.target.binding.kind !== "unit" ||
    plan.accessor.binding.kind !== "support" ||
    plan.trampoline.binding.kind !== "support" ||
    plan.cacheGlobal.binding.kind !== "support" ||
    sourceOwnerUnitId(identifier) !== ownerUnitId
  )
    return false;
  const access = identifier.parent;
  const use = access.parent;
  if (
    !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) ||
    access.expression !== identifier ||
    access.questionDotToken !== undefined ||
    !(
      (ts.isCallExpression(use) && use.expression === access && !use.questionDotToken) ||
      (ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    )
  )
    return false;
  const unitId = plan.target.binding.unitId;
  const declaration = identity.identityContext.declarationByUnitId.get(unitId);
  const resolved = ctx.oracle.valueDeclarationOf(identifier);
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    !resolved ||
    declaration.getSourceFile() !== identifier.getSourceFile() ||
    (declaration !== resolved &&
      (declaration.pos !== resolved.pos ||
        declaration.end !== resolved.end ||
        declaration.getSourceFile().fileName !== resolved.getSourceFile().fileName)) ||
    ctx.reassignedFunctionDeclarations?.has(declaration)
  )
    return false;
  const handle = ctx.programAbiSourceCallables?.handleForUnit(unitId);
  const target = ctx.programAbiSourceCallables?.functionForUnit(unitId);
  if (
    handle === undefined ||
    !target ||
    definedFuncAt(ctx, handle) !== target ||
    sourceFunctionDeclarationForHandle(ctx, handle) !== declaration
  )
    return false;
  const key = ctx.funcClosureSingletonKeyByFuncIdx.get(handle);
  const cacheIndex = key === undefined ? undefined : ctx.funcClosureGlobals.get(key);
  const trampolineIndex = key === undefined ? undefined : ctx.funcMap.get(`__fn_tramp_${key}_cached`);
  const accessorIndex = key === undefined ? undefined : ctx.funcMap.get(`__fn_value_${key}`);
  if (cacheIndex === undefined || trampolineIndex === undefined || accessorIndex === undefined) return false;
  const cache = ctx.mod.globals[localGlobalIdx(ctx, cacheIndex)];
  const trampoline = definedFuncAt(ctx, trampolineIndex);
  const accessor = definedFuncAt(ctx, accessorIndex);
  const signature = funcSignatureOf(ctx, accessorIndex);
  const session = ctx.programAbiSession;
  const expectedCache = irSupportGlobalRef(unitId, "function-value-cache", cache?.name ?? "unavailable");
  if (expectedCache.binding.kind !== "support") return false;
  if (
    !session ||
    !cache ||
    !trampoline ||
    !accessor ||
    cache.type.kind !== "externref" ||
    !cache.mutable ||
    !signature ||
    signature.params.length !== 0 ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref" ||
    !sameIrCallableBinding(
      plan.accessor.binding,
      irSupportFuncRef(unitId, "function-value-accessor", accessor.name).binding,
    ) ||
    !sameIrCallableBinding(
      plan.trampoline.binding,
      irSupportFuncRef(unitId, "function-value-trampoline", trampoline.name).binding,
    ) ||
    plan.cacheGlobal.binding.bindingId !== expectedCache.binding.bindingId ||
    accessor.name !== plan.accessor.name ||
    trampoline.name !== plan.trampoline.name ||
    cache.name !== plan.cacheGlobal.name
  )
    return false;
  return (
    session.hasPlan(plan.accessor.binding.bindingId) &&
    session.hasLocator(plan.accessor.binding.bindingId, accessor) &&
    session.hasPlan(plan.trampoline.binding.bindingId) &&
    session.hasLocator(plan.trampoline.binding.bindingId, trampoline) &&
    session.hasPlan(plan.cacheGlobal.binding.bindingId) &&
    session.hasLocator(plan.cacheGlobal.binding.bindingId, cache)
  );
}

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
  // (#7091) `externref` is the native-string lane's carrier for a `string` param.
  if (type.val.kind === "f64" || type.val.kind === "i32" || type.val.kind === "externref") return type.val;
  return undefined;
}

function ambientHostParamCarrier(type: IrType, nativeStrings: boolean): IrType {
  return nativeStrings && type.kind === "string" ? { kind: "val", val: { kind: "externref" } } : type;
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
        const graphUse = certifiedImportedHofCall(node, legacyImportedFunctions)
          ? undefined
          : programCallableBoundaryUse(ctx, identityPlan, ownerUnitId, node);
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
                readEnv("JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW") === "1" ||
                readEnv("JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW") === ownerName
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
                  accessor: irSupportFuncRef(
                    valueIdentity.target.binding.unitId,
                    "function-value-accessor",
                    `__fn_value_${functionArgument.target.targetName}`,
                  ),
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
  nativeStrings: boolean,
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
            // (#7091) Under native strings a `string` param crosses as the
            // externref carrier (`extern.convert_any`, exactly what legacy
            // passes); a `string` RESULT has no IR carrier conversion yet.
            const params = certified.declaration.parameters.map((parameter) =>
              ambientHostParamCarrier(
                resolvePositionType(effectiveIrParamTypeNode(parameter), undefined, classShapeSidecar),
                nativeStrings,
              ),
            );
            const returnType = resolvePositionType(
              effectiveIrReturnTypeNode(certified.declaration),
              undefined,
              classShapeSidecar,
            );
            if (nativeStrings && returnType?.kind === "string") {
              throw new IrUnsupportedError(
                "imported-call-planning-unsupported",
                "resolve",
                `ambient host call ${certified.targetName} returns a native string with no IR carrier conversion`,
              );
            }
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
  readonly sourceOwnerUnitId: (node: ts.Node) => IrUnitId;
  readonly ctx: CodegenContext;
  readonly identityImportedFunctions?: IrIdentityImportedFunctionResolver;
  readonly functionObjectValues?: IrIdentityImportedFunctionResolver;
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
    functionObjectValues,
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
  if (functionObjectValues && ctx.runtimeEvalGlobalFunctionBindings !== true) {
    const identity = options.identityPlan;
    const source = identity.identityContext.sourceFileBySourceId;
    const addOwner = (ownerName: string, ownerUnitId: IrUnitId, root: ts.Node): void => {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const access = node.parent;
          const use = access?.parent;
          const isReceiver =
            (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
            access.expression === node &&
            access.questionDotToken === undefined &&
            ((ts.isCallExpression(use) && use.expression === access) ||
              (ts.isBinaryExpression(use) &&
                use.left === access &&
                use.operatorToken.kind === ts.SyntaxKind.EqualsToken));
          const target =
            isReceiver && options.sourceOwnerUnitId(node) === ownerUnitId
              ? functionObjectValues.resolveTopLevelFunctionValueTarget(node)
              : undefined;
          if (target?.legacyProjection === "unambiguous") {
            const funcIdx = ctx.programAbiSourceCallables?.handleForUnit(target.targetUnitId);
            const prepared =
              funcIdx === undefined ? null : ensureFuncClosureSingletonAccessor(ctx, target.targetName, funcIdx);
            const accessor = prepared ? definedFuncAt(ctx, prepared.accessorFuncIdx) : undefined;
            const trampoline = prepared ? definedFuncAt(ctx, prepared.singleton.trampolineFuncIdx) : undefined;
            const cache = prepared
              ? ctx.mod.globals[localGlobalIdx(ctx, prepared.singleton.cacheGlobalIdx)]
              : undefined;
            if (!prepared || !accessor || !trampoline || !cache) {
              throw new IrUnsupportedError(
                "imported-call-planning-unsupported",
                "resolve",
                "canonical function-object support unavailable",
              );
            }
            const claim = identity.functionClaims.find((candidate) => candidate.unitId === target.targetUnitId);
            const params = target.declaration.parameters.map((parameter, index) =>
              resolvePositionType(
                effectiveIrParamTypeNode(parameter),
                claim?.typeEntry.params[index],
                classShapeSidecar,
              ),
            );
            const returnNode = effectiveIrReturnTypeNode(target.declaration);
            const signature = {
              params,
              returnType:
                returnNode?.kind === ts.SyntaxKind.VoidKeyword
                  ? null
                  : resolvePositionType(returnNode, claim?.typeEntry.returnType, classShapeSidecar),
            };
            const plan = {
              ownerName,
              ownerUnitId,
              objectReceiver: true,
              target: irUnitFuncRef({ unitId: target.targetUnitId, name: target.targetName }),
              signature,
              accessor: irSupportFuncRef(target.targetUnitId, "function-value-accessor", accessor.name),
              trampoline: irSupportFuncRef(target.targetUnitId, "function-value-trampoline", trampoline.name),
              cacheGlobal: irSupportGlobalRef(target.targetUnitId, "function-value-cache", cache.name),
              cacheGlobalName: cache.name,
            };
            if (!planProgramAbiFunctionValue(ctx, plan, trampoline, cache, accessor)) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "resolve",
                "function-object support lost its exact ABI",
              );
            }
            plans.topLevelFunctionValues.set(node, plan);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
    };
    for (const [ownerName, declaration] of identity.declarationByLegacyName) {
      if (safeSelection.funcs.has(ownerName) && declaration.body) {
        addOwner(ownerName, irOverlayIdentity.requireIrOverlayUnitId(identity, ownerName), declaration.body);
      }
    }
    const init = identity.identitySelection.moduleInit;
    if (init && safeSelection.moduleInit?.reason === null) {
      for (const file of source.values()) {
        if (identity.identityContext.moduleInitUnitIdBySourceFile.get(file) !== init.unitId) continue;
        for (const statement of file.statements) {
          if (!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement))
            addOwner(init.legacyMatchName, init.unitId, statement);
        }
      }
    }
  }
  if (resolveAmbientClassCall) {
    appendAmbientClassCalls(
      options,
      resolveAmbientClassCall,
      classShapeSidecar,
      safeSelection,
      plans.importedCalls,
      resolvePositionType,
      ctx.nativeStrings,
    );
  }
  return plans;
}

/** One current source resolver bundle, with the existing dormant class proof. */
export function planIrFunctionValueResolverState(
  ctx: CodegenContext,
  identityContext: irOverlayIdentity.IrOverlayIdentityPlan["identityContext"],
  options: {
    readonly importedFunctions?: IrIdentityImportedFunctionResolver;
    readonly resolver?: IrIdentityImportedFunctionResolver;
  },
  resolveIdentity: () => IrIdentityImportedFunctionResolver,
) {
  const identityImportedFunctions = options.importedFunctions;
  const legacyImportedFunctions = irOverlayIdentity.projectIrOverlayImportedResolver(identityImportedFunctions);
  // (#3522 F2/F4) ONE exact resolver per source, constructed before identity
  // selection and reused by direct-call projection and the field-call proof.
  const identityResolver = resolveIdentity();
  const functionObjectValues =
    ctx.targetProfile.semanticProviders === "native-first" &&
    (ctx.standalone || ctx.wasi) &&
    ctx.runtimeEvalGlobalFunctionBindings !== true
      ? makeIrFunctionObjectValueResolver(ctx, identityResolver)
      : undefined;
  // (#3522 F4) Validate the complete dormant F3 proof and derive the single
  // immutable admitted-class marker BEFORE local class-expression resolution
  // and identity selection. Every downstream consumer carries this object; none
  // recomputes it.
  const nestedClassFieldCallProofs = planIrNestedClassFieldCalls({ identityContext, resolver: identityResolver });
  const nestedClassFieldCallAdmission: IrNestedClassFieldCallAdmission =
    irOverlayIdentity.computeIrNestedClassFieldCallAdmission({
      identityContext,
      resolver: identityResolver,
      proofs: nestedClassFieldCallProofs,
    });
  return {
    identityImportedFunctions,
    legacyImportedFunctions,
    identityResolver,
    functionObjectValues,
    nestedClassFieldCallProofs,
    nestedClassFieldCallAdmission,
  };
}

/**
 * Allocate and freeze direct function-value singleton support before a target
 * body can seal through Prepared IR. A direct caller may still materialize the
 * value later, but it must reuse these exact allocator objects rather than
 * adding ABI drafts to an already sealed target component.
 */
export function prepareTopLevelFunctionValueTargetSupport(
  ctx: CodegenContext,
  plan: {
    readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
    readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, { readonly legacyName: string }>;
  },
  selectedLegacyNames: ReadonlySet<string>,
  collectValueTargetUnitIds: () => ReadonlySet<IrUnitId>,
): ReadonlyMap<IrUnitId, MultiPreparedFunctionValueSupportReceipt> {
  const receipts = new Map<IrUnitId, MultiPreparedFunctionValueSupportReceipt>();
  const selectedUnitIds = new Set(
    [...selectedLegacyNames].map((legacyName) =>
      irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName),
    ),
  );
  const valueTargetUnitIds = collectValueTargetUnitIds();
  for (const unitId of valueTargetUnitIds) {
    if (!selectedUnitIds.has(unitId)) continue;
    const claim = plan.functionClaimsByUnitId.get(unitId);
    const funcIdx = claim ? ctx.programAbiSourceCallables?.handleForUnit(unitId) : undefined;
    const target = claim ? irUnitFuncRef({ unitId, name: claim.legacyName }) : undefined;
    if (claim === undefined || funcIdx === undefined || target === undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} has no exact allocated source callable`,
      );
    }
    const access = ensureFuncClosureSingletonAccessor(ctx, claim.legacyName, funcIdx);
    const singleton = access?.singleton;
    const accessor = access ? definedFuncAt(ctx, access.accessorFuncIdx) : undefined;
    const trampoline = singleton ? definedFuncAt(ctx, singleton.trampolineFuncIdx) : undefined;
    const cache = singleton ? ctx.mod.globals[localGlobalIdx(ctx, singleton.cacheGlobalIdx)] : undefined;
    if (!singleton || !trampoline || !cache || !accessor) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} could not allocate its exact singleton support`,
      );
    }
    const functionValuePlan = {
      target,
      accessor: irSupportFuncRef(unitId, "function-value-accessor", accessor.name),
      trampoline: irSupportFuncRef(unitId, "function-value-trampoline", trampoline.name),
      cacheGlobal: irSupportGlobalRef(unitId, "function-value-cache", cache.name),
    };
    if (!planProgramAbiFunctionValue(ctx, functionValuePlan, trampoline, cache, accessor)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} could not freeze its singleton Program ABI`,
      );
    }
    if (
      functionValuePlan.trampoline.binding.kind !== "support" ||
      functionValuePlan.cacheGlobal.binding.kind !== "support"
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `prepared function-value target ${unitId} lost its exact support binding identities`,
      );
    }
    receipts.set(
      unitId,
      Object.freeze({
        targetFunction: ctx.programAbiSourceCallables!.functionForUnit(unitId)!,
        targetHandle: funcIdx,
        trampolineFunction: trampoline,
        trampolineHandle: singleton.trampolineFuncIdx,
        trampolineRef: functionValuePlan.trampoline,
        trampolineBindingId: functionValuePlan.trampoline.binding.bindingId,
        cacheGlobal: cache,
        cacheGlobalHandle: singleton.cacheGlobalIdx,
        cacheGlobalRef: functionValuePlan.cacheGlobal,
        cacheGlobalBindingId: functionValuePlan.cacheGlobal.binding.bindingId,
      }),
    );
  }
  return receipts;
}
