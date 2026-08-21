// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { requireValidImportedCallTarget, type IrImportedCallLoweringPlan } from "../ir/ast-lowering-plans.js";
import { irImportFuncRef } from "../ir/callable-bindings.js";
import {
  certifyExactInjectedTimerShim,
  isPreparedInjectedTimerShimOwner,
  type IrInjectedTimerShimCertification,
} from "../ir/injected-timer-shim.js";
import type { IrUnitId } from "../ir/identity.js";
import { asVal, irDynamic, type IrType } from "../ir/nodes.js";
import { IrInvariantError, type IrPreparationFailure } from "../ir/outcomes.js";
import type { IrSelection } from "../ir/select.js";
import type { CodegenContext } from "./context/types.js";
import { applyIrFinalContextFunctionRetention, closeIrBlockedComponentByIdentity } from "./ir-overlay-finalize.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import type { IrExactFunctionClaim } from "./ir-overlay-safety.js";

export type IrPreparedTimerShimResolver = (
  declaration: ts.FunctionDeclaration,
) => IrInjectedTimerShimCertification | undefined;

interface IrTimerShimPlanningState {
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly preparationFailuresByUnitId: Map<IrUnitId, IrPreparationFailure>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
}

interface IrTimerShimRoutingPlan {
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly hostVoidCallbacks: { readonly size: number };
  readonly hostDateImportsByOwnerUnitId: { readonly size: number };
  readonly promiseDelays: { readonly constructions: { readonly size: number } };
}

export interface IrTimerShimRoutingSummary {
  readonly ownerUnitIds: ReadonlySet<IrUnitId>;
  readonly hasOtherLateFeaturePreparation: boolean;
  readonly owners: (
    moduleInit: unknown,
    defaultNames: ReadonlySet<string>,
    classMemberUnitIds: ReadonlySet<IrUnitId>,
  ) => ReadonlySet<string> | undefined;
  readonly withdrewNonTimerOwner: (
    preliminaryNames: ReadonlySet<string>,
    finalizedNames: ReadonlySet<string>,
  ) => boolean;
}

function exactSelfOwnedTimerTerminal(
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
  unitId: IrUnitId,
  declaration?: ts.FunctionDeclaration,
): boolean {
  const context = identityPlan.identityContext;
  const terminal = context.terminalByUnitId.get(unitId);
  return (
    context.inventory.sources.length === 1 &&
    terminal?.kind === "synthetic-support" &&
    terminal.syntheticRole === "compiler-unit:timer-shim:set-timeout" &&
    terminal.terminalOwnerId === unitId &&
    terminal.lexicalOwnerId === null &&
    context.unitByUnitId.get(unitId) === terminal &&
    (declaration === undefined || context.declarationByUnitId.get(unitId) === declaration)
  );
}

export function timerShimResolver(
  checker: ts.TypeChecker,
  ctx: Pick<CodegenContext, "fast">,
  resolveModuleBindings: boolean | undefined,
): IrPreparedTimerShimResolver | undefined {
  if (
    ctx.fast ||
    resolveModuleBindings === false ||
    process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER === "0" ||
    process.env.JS2WASM_PREPARED_TIMER_SHIM_CUTOVER === "false"
  ) {
    return undefined;
  }
  return (declaration) =>
    isPreparedInjectedTimerShimOwner(declaration, checker)
      ? certifyExactInjectedTimerShim(declaration, checker)
      : undefined;
}

export function preparedTimerShimSelectionOption(
  resolve: IrPreparedTimerShimResolver | undefined,
): { readonly isPreparedInjectedTimerShim: (declaration: ts.FunctionDeclaration) => boolean } | object {
  return resolve
    ? { isPreparedInjectedTimerShim: (declaration: ts.FunctionDeclaration) => resolve(declaration) !== undefined }
    : {};
}

export function shouldVisitIrImportedCallBody(hasSourceImportPlan: boolean, hasTimerPlan: boolean): boolean {
  return hasSourceImportPlan && !hasTimerPlan;
}

export function planIrCompilerTimerShimCall(
  resolve: IrPreparedTimerShimResolver | undefined,
  declaration: ts.FunctionDeclaration,
  ownerName: string,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
): { readonly call: ts.CallExpression; readonly plan: IrImportedCallLoweringPlan } | undefined {
  const certification = resolve?.(declaration);
  if (!certification) return undefined;
  const ownerUnitId = identityPlan.identityContext.unitIdByDeclaration.get(declaration);
  if (
    !ownerUnitId ||
    certification.declaration !== declaration ||
    !identityPlan.safeFunctionUnitIds.has(ownerUnitId) ||
    !exactSelfOwnedTimerTerminal(identityPlan, ownerUnitId, declaration)
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "compiler timer shim plan has no exact self-owned synthetic terminal",
    );
  }
  return {
    call: certification.call,
    plan: {
      source: "compiler-timer-shim",
      ownerUnitId,
      ownerName,
      target: irImportFuncRef("env", "__timer_set_timeout"),
      params: [{ kind: "callable", signature: { params: [], returnType: null } }, irDynamic()],
      returnType: irDynamic(),
      optionalParams: new Map(),
      needsArgc: false,
    },
  };
}

function hasPreparedCompilerTimerShimImport(ctx: CodegenContext, plan: IrImportedCallLoweringPlan): boolean {
  if (plan.source !== "compiler-timer-shim") return false;
  requireValidImportedCallTarget(plan);
  if (ctx.fast || plan.target.binding.kind !== "import") return false;
  const funcIdx = ctx.funcMap.get(plan.target.binding.field);
  if (funcIdx === undefined || funcIdx < 0 || funcIdx >= ctx.numImportFuncs) return false;
  let importFuncIdx = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (importFuncIdx++ !== funcIdx) continue;
    if (imported.module !== plan.target.binding.module || imported.name !== plan.target.binding.field) return false;
    const type = ctx.mod.types[imported.desc.typeIdx];
    return (
      type?.kind === "func" &&
      type.params.length === 2 &&
      type.params.every((param) => param.kind === "externref") &&
      type.results.length === 1 &&
      type.results[0]?.kind === "externref"
    );
  }
  return false;
}

/** Fail closed unless the exact compiler timer capability is in the final import manifest. */
export function prepareIrCompilerTimerShimCallLowering(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrTimerShimPlanningState,
  selection: IrSelection,
): IrSelection {
  const blocked = new Set<IrUnitId>();
  for (const callPlan of plan.importedCalls.values()) {
    if (callPlan.source !== "compiler-timer-shim" || !plan.identityPlan.safeFunctionUnitIds.has(callPlan.ownerUnitId)) {
      continue;
    }
    if (!exactSelfOwnedTimerTerminal(plan.identityPlan, callPlan.ownerUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `compiler timer shim ${callPlan.ownerUnitId} lost its exact terminal identity`,
      );
    }
    if (hasPreparedCompilerTimerShimImport(ctx, callPlan)) continue;
    blocked.add(callPlan.ownerUnitId);
    const failure: IrPreparationFailure = {
      kind: "unsupported",
      code: "late-preparation-unsupported",
      stage: "resolve",
      detail: "the exact compiler timer capability is absent from the final env import manifest",
    };
    if (plan.preparationFailuresByUnitId.has(callPlan.ownerUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `compiler timer shim ${callPlan.ownerUnitId} received more than one preparation result`,
      );
    }
    plan.preparationFailuresByUnitId.set(callPlan.ownerUnitId, failure);
  }
  if (blocked.size === 0) return selection;
  const before = plan.identityPlan.safeFunctionUnitIds.size;
  const retained = closeIrBlockedComponentByIdentity(
    sourceFile,
    plan.identityPlan.identityContext,
    plan.identityPlan.safeFunctionUnitIds,
    blocked,
  );
  const retainedNames = irOverlayIdentity.retainIrSafeFunctionUnitIds(plan.identityPlan, retained);
  return applyIrFinalContextFunctionRetention(selection, retainedNames, retained.size < before);
}

export function inspectIrCompilerTimerShimRouting(plan: IrTimerShimRoutingPlan): IrTimerShimRoutingSummary {
  const ownerUnitIds = new Set(
    [...plan.importedCalls.values()]
      .filter(({ source }) => source === "compiler-timer-shim")
      .map(({ ownerUnitId }) => ownerUnitId),
  );
  const eligibleLegacyNames = new Set<string>();
  for (const unitId of ownerUnitIds) {
    if (!plan.identityPlan.safeFunctionUnitIds.has(unitId)) continue;
    const claim = plan.functionClaimsByUnitId.get(unitId);
    if (!claim) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `compiler timer shim ${unitId} has no exact function claim`,
      );
    }
    eligibleLegacyNames.add(claim.legacyName);
  }
  const hasOtherLateFeaturePreparation =
    [...plan.importedCalls.values()].some(({ source }) => source !== "compiler-timer-shim") ||
    plan.hostVoidCallbacks.size > 0 ||
    plan.hostDateImportsByOwnerUnitId.size > 0 ||
    plan.promiseDelays.constructions.size > 0;
  return {
    ownerUnitIds,
    hasOtherLateFeaturePreparation,
    owners: (moduleInit, defaultNames, _classMemberUnitIds) => {
      if (!hasOtherLateFeaturePreparation || moduleInit) return defaultNames;
      return eligibleLegacyNames.size > 0 ? eligibleLegacyNames : undefined;
    },
    withdrewNonTimerOwner: (preliminaryNames, finalizedNames) =>
      [...preliminaryNames].some((legacyName) => {
        if (finalizedNames.has(legacyName)) return false;
        const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName);
        return !ownerUnitIds.has(unitId);
      }),
  };
}

function isPreparedCompilerTimerShimOutsideCallerCertified(
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  allocatedSlotMatches: boolean,
): boolean {
  return (
    exactSelfOwnedTimerTerminal(identityPlan, unitId) &&
    override.params.length === 2 &&
    override.params[0]?.kind === "callable" &&
    override.params[0].signature.params.length === 0 &&
    override.params[0].signature.returnType === null &&
    asVal(override.params[1]!)?.kind === "f64" &&
    override.returnType !== null &&
    asVal(override.returnType)?.kind === "f64" &&
    allocatedSlotMatches
  );
}

export function timerShimOutsideCaller<TContext>(
  input: {
    readonly ctx: TContext;
    readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
    readonly timerShimUnitIds?: ReadonlySet<IrUnitId>;
  },
  unitId: IrUnitId,
  override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  allocatedSlotMatches: (
    ctx: TContext,
    unitId: IrUnitId,
    override: { readonly params: readonly IrType[]; readonly returnType: IrType | null },
  ) => boolean,
): boolean {
  return (
    input.timerShimUnitIds?.has(unitId) === true &&
    isPreparedCompilerTimerShimOutsideCallerCertified(
      input.identityPlan,
      unitId,
      override,
      allocatedSlotMatches(input.ctx, unitId, override),
    )
  );
}
