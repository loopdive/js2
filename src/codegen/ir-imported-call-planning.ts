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
import { irArgcGlobalRef, irSupportGlobalRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import { irImportFuncRef, irSupportFuncRef, irUnitFuncRef, sameIrCallableBinding } from "../ir/callable-bindings.js";
import type { IrAmbientClassCallResolver } from "../ir/host-extern.js";
import type { IrIdentityImportedFunctionResolver, IrImportedFunctionResolver } from "../ir/imported-functions.js";
import type { IrBindingId, IrSourceId, IrUnitId, IrNestedClassFieldCallAdmission } from "../ir/identity.js";
import type { IrClosureSignature, IrType } from "../ir/nodes.js";
import type { IrModuleInitEvaluationEntry, IrModuleInitPlanningEvidence } from "../ir/module-init-plan.js";
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
import { makeIrFunctionMemberClosures } from "./function-member-closure-planning.js";
import { computeClosureWrapperSig } from "./closures.js";
import { resolveIrDynamicCarrierType } from "./any-helpers.js";
import { irSelfGuardedConstructorValue } from "./ir-dynamic-construct.js"; // (#7106 S3c)

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

/**
 * (#7106 census arm 4) The signature of a RECEIVER-only function-object plan
 * whose target carries no parameter/result evidence. Only the IR type of the
 * accessor's result reads it (`callable<S>`, which lowers to externref for
 * every `S`), and that value is boxed into the dynamic carrier at once; every
 * member call/write on it dispatches dynamically. All-dynamic is the one
 * signature that claims nothing about the target's real ABI.
 */
function opaqueReceiverSignature(declaration: ts.FunctionDeclaration): IrClosureSignature {
  const dynamic: IrType = { kind: "dynamic" };
  return { params: declaration.parameters.map(() => dynamic), returnType: dynamic };
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
          // (#7106 S3c) A self-guarded constructor used as a value: the `new F(…)`
          // callee (`dyn.construct`) or the `x instanceof F` operand
          // (`dyn.instanceof_fn`, which reads the plan's exact unit target).
          const isSelfGuardedValue =
            ((ts.isNewExpression(access) && access.expression === node) ||
              (ts.isBinaryExpression(access) &&
                access.right === node &&
                access.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) &&
            irSelfGuardedConstructorValue(ctx, node);
          const target =
            (isReceiver || isSelfGuardedValue) && options.sourceOwnerUnitId(node) === ownerUnitId
              ? functionObjectValues.resolveTopLevelFunctionValueTarget(node)
              : undefined;
          if (target?.legacyProjection === "unambiguous") {
            const claim = identity.functionClaims.find((candidate) => candidate.unitId === target.targetUnitId);
            const returnNode = effectiveIrReturnTypeNode(target.declaration);
            const missingEvidence =
              target.declaration.parameters.some(
                (parameter, index) =>
                  effectiveIrParamTypeNode(parameter) === undefined && claim?.typeEntry.params[index] === undefined,
              ) ||
              (returnNode === undefined && claim?.typeEntry.returnType === undefined);
            // Missing flow evidence is not a dynamic signature, so a VALUE use
            // (the S3c self-guarded constructor) stays on the compatibility
            // route. A receiver-only use never reads the signature: the
            // accessor's externref is boxed straight into the dynamic carrier
            // and every member call/write dispatches dynamically, so it gets
            // the opaque all-dynamic signature (#7106 census arm 4).
            if (missingEvidence && !isReceiver) return;
            const signature = missingEvidence
              ? opaqueReceiverSignature(target.declaration)
              : {
                  params: target.declaration.parameters.map((parameter, index) =>
                    resolvePositionType(
                      effectiveIrParamTypeNode(parameter),
                      claim?.typeEntry.params[index],
                      classShapeSidecar,
                    ),
                  ),
                  returnType:
                    returnNode?.kind === ts.SyntaxKind.VoidKeyword
                      ? null
                      : resolvePositionType(returnNode, claim?.typeEntry.returnType, classShapeSidecar),
                };
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
  valueType: (type: ValType) => IrType,
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
  const functionMemberClosures = functionObjectValues
    ? makeIrFunctionMemberClosures(ctx, identityContext, functionObjectValues, {
        computeSignature: (expression) => computeClosureWrapperSig(ctx, expression),
        dynamicCarrierIsExternref: () => resolveIrDynamicCarrierType(ctx).kind === "externref",
        valueType,
        typeBindingKey: irTypeBindingKey,
      })
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
    functionMemberClosures,
    // Preserve the old projection's exact evaluation point at the selector call.
    functionValueSelectionOptions: () =>
      functionObjectValues
        ? {
            functionObjectValues: irOverlayIdentity.projectIrOverlayImportedResolver(functionObjectValues),
            ...(functionMemberClosures ? { functionMemberClosures } : {}),
          }
        : {},
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

export function preparedModuleInitEvaluationMatchesStatement(
  sourceId: IrSourceId,
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  evaluation: IrModuleInitEvaluationEntry,
  sourceOrdinal: number,
  kind: Extract<IrModuleInitEvaluationEntry["kind"], "variable-initializer" | "statement">,
  bindingIds: readonly IrBindingId[],
): boolean {
  const statementOrdinal = sourceFile.statements.indexOf(statement);
  const start = statement.getStart(sourceFile);
  return (
    statement.getSourceFile() === sourceFile &&
    statementOrdinal >= 0 &&
    evaluation.key === `${sourceId}:eval:${sourceOrdinal}` &&
    evaluation.kind === kind &&
    evaluation.sourceOrdinal === sourceOrdinal &&
    evaluation.statementOrdinal === statementOrdinal &&
    evaluation.nestedOrdinal === 0 &&
    evaluation.start === start &&
    evaluation.end === statement.end &&
    evaluation.classId === null &&
    evaluation.legacyKey === `statement:${start}:${statement.end}` &&
    evaluation.bindingIds.length === bindingIds.length &&
    evaluation.bindingIds.every((bindingId, index) => bindingId === bindingIds[index])
  );
}

interface PreparedMemberInitEvidence {
  readonly unitId: IrUnitId;
  readonly globalBindingIds: ReadonlySet<IrBindingId>;
  readonly invocationKind: "wasm-start" | "deferred-export";
}

/** Admit only a closed population of current, canonical function-object RHS writes. */
export function preparedMemberInit(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: {
    readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
    readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
    readonly functionMemberClosures?: ReturnType<typeof makeIrFunctionMemberClosures>;
  },
  selection: Pick<IrSelection, "funcs" | "moduleInit">,
  planning: IrModuleInitPlanningEvidence | undefined,
  sourceOwnerUnitId: (node: ts.Node) => IrUnitId,
): PreparedMemberInitEvidence | undefined {
  const identity = plan.identityPlan.identityContext;
  if (
    ctx.fast ||
    !ctx.nativeStrings ||
    !ctx.standalone ||
    ctx.wasi ||
    ctx.strictNoHostImports ||
    ctx.targetProfile.semanticProviders !== "native-first" ||
    ctx.runtimeEvalGlobalFunctionBindings === true ||
    identity.sourceFileBySourceId.size !== 1 ||
    ctx.programAbiSession?.inventory !== identity.inventory ||
    ctx.programAbiSourceCallables?.identityContext !== identity ||
    !plan.functionMemberClosures ||
    !planning ||
    selection.moduleInit?.reason !== null ||
    selection.moduleInit.stmtCount === 0
  ) {
    return undefined;
  }
  const sourceId = identity.sourceIdBySourceFile.get(sourceFile);
  const unitId = identity.moduleInitUnitIdBySourceFile.get(sourceFile);
  const terminal = unitId === undefined ? undefined : identity.terminalByUnitId.get(unitId);
  const population = identity.moduleInitPopulationBySourceFile.get(sourceFile);
  const invocationKind = planning.plan.invocation.kind;
  if (
    sourceId === undefined ||
    unitId === undefined ||
    !terminal ||
    !population ||
    identity.sourceFileBySourceId.get(sourceId) !== sourceFile ||
    identity.moduleInitUnitIdBySourceId.get(sourceId) !== unitId ||
    identity.unitByUnitId.get(unitId) !== terminal ||
    terminal.kind !== "module-init" ||
    terminal.sourceId !== sourceId ||
    terminal.terminalOwnerId !== unitId ||
    planning.plan.sourceId !== sourceId ||
    planning.plan.unitId !== unitId ||
    !planning.plan.executable ||
    planning.plan.gaps.length !== 0 ||
    planning.plan.bindings.length !== 0 ||
    planning.plan.liveSeeds.length !== 0 ||
    !planning.parity.aligned ||
    !planning.plan.invocation.exactlyOnce ||
    planning.plan.invocation.target !== "standalone" ||
    (invocationKind !== "wasm-start" && invocationKind !== "deferred-export") ||
    (ctx.deferTopLevelInit ? invocationKind !== "deferred-export" : invocationKind !== "wasm-start") ||
    population.length === 0 ||
    selection.moduleInit.stmtCount !== population.length ||
    planning.plan.evaluations.length !== population.length ||
    planning.parity.plannedEntryCount !== population.length ||
    planning.parity.legacyEntryCount !== population.length
  ) {
    return undefined;
  }
  // No class static work, import/re-export/default work, variable storage, or
  // unknown top-level operation can borrow this function-member certificate.
  const currentPopulation: ts.ExpressionStatement[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement)) currentPopulation.push(statement);
    else if (
      !(ts.isFunctionDeclaration(statement) && statement.name && statement.body) &&
      !ts.isEmptyStatement(statement) &&
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement)
    ) {
      return undefined;
    }
  }
  if (
    currentPopulation.length !== population.length ||
    currentPopulation.some((statement, ordinal) => statement !== population[ordinal])
  ) {
    return undefined;
  }
  for (let ordinal = 0; ordinal < population.length; ordinal++) {
    const statement = currentPopulation[ordinal];
    const evaluation = planning.plan.evaluations[ordinal];
    if (
      !statement ||
      !evaluation ||
      statement.parent !== sourceFile ||
      !preparedModuleInitEvaluationMatchesStatement(
        sourceId,
        sourceFile,
        statement,
        evaluation,
        ordinal,
        "statement",
        [],
      )
    ) {
      return undefined;
    }
    const assignment = statement.expression;
    if (
      !ts.isBinaryExpression(assignment) ||
      assignment.parent !== statement ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      assignment.left.parent !== assignment ||
      assignment.left.questionDotToken ||
      !ts.isIdentifier(assignment.left.expression) ||
      !ts.isIdentifier(assignment.left.name) ||
      !ts.isFunctionExpression(assignment.right) ||
      assignment.right.parent !== assignment
    ) {
      return undefined;
    }
    const receiver = assignment.left.expression;
    const value = plan.topLevelFunctionValues.get(receiver);
    if (
      !hasPreparedFunctionObjectReference(ctx, receiver, value, plan.identityPlan, unitId, sourceOwnerUnitId) ||
      value?.target.binding.kind !== "unit"
    ) {
      return undefined;
    }
    const targetUnitId = value.target.binding.unitId;
    const claim = plan.identityPlan.functionClaims.find((entry) => entry.unitId === targetUnitId);
    if (!claim || !selection.funcs.has(claim.legacyName) || !plan.identityPlan.safeFunctionUnitIds.has(targetUnitId)) {
      return undefined;
    }
    const rhs = plan.functionMemberClosures.resolve(assignment.right);
    const sourceUnit = rhs ? identity.unitByUnitId.get(rhs.sourceUnitId) : undefined;
    if (
      !rhs ||
      rhs.expression !== assignment.right ||
      rhs.ownerUnitId !== unitId ||
      !sourceUnit ||
      sourceUnit.terminal ||
      sourceUnit.kind !== "function-expression" ||
      sourceUnit.sourceId !== sourceId ||
      sourceUnit.terminalOwnerId !== unitId ||
      sourceUnit.lexicalOwnerId !== unitId ||
      identity.declarationByUnitId.get(rhs.sourceUnitId) !== assignment.right ||
      !rhs.isCurrent()
    ) {
      return undefined;
    }
  }
  // No module lexical binding is certified or minted by this initializer.
  return { unitId, globalBindingIds: new Set<IrBindingId>(), invocationKind };
}
