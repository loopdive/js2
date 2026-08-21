// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { projectIrBackendTargetProfile, supportsIrBackendTargetCapability } from "../ir/backend/legality.js";
import type { IrHostVoidCallbackLoweringPlan, IrImportedCallLoweringPlan } from "../ir/ast-lowering-plans.js";
import type { IrUnitId } from "../ir/identity.js";
import { IrInvariantError, type IrPreparationFailure } from "../ir/outcomes.js";
import type { IrPromiseDelayLoweringPlans } from "../ir/promise-delay-lowering.js";
import type { IrSelection } from "../ir/select.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { prepareIrAmbientClassCallLowering, recordIrOverlayPreparationFailure } from "./ir-imported-call-planning.js";
import { prepareIrCompilerTimerShimCallLowering } from "./ir-timer-shim-planning.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import {
  applyIrFinalContextFunctionRetention,
  prepareHostDateSnapshotLoweringByIdentity,
  prepareHostVoidCallbackLoweringByIdentity,
  preparePromiseDelayLoweringByIdentity,
  type IrHostDateSnapshotImportPlan,
} from "./ir-overlay-finalize.js";

export interface IrOverlayPreparationPlan {
  readonly identityPlan: irOverlayIdentity.IrOverlayIdentityPlan;
  readonly safeSelection: IrSelection;
  readonly preparationFailuresByUnitId: Map<IrUnitId, IrPreparationFailure>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateImportsByOwnerUnitId: ReadonlyMap<IrUnitId, IrHostDateSnapshotImportPlan>;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
}

export function synchronizeIrSafeFunctionSelection(
  plan: IrOverlayPreparationPlan,
  selection: IrSelection,
): IrSelection {
  const retainedUnitIds = new Set<IrUnitId>();
  for (const legacyName of selection.funcs) {
    retainedUnitIds.add(irOverlayIdentity.requireIrOverlayFunctionUnitId(plan.identityPlan, legacyName));
  }
  return {
    ...selection,
    funcs: irOverlayIdentity.retainIrSafeFunctionUnitIds(plan.identityPlan, retainedUnitIds),
  };
}

export function applyIrFinalContextFunctionUnitIds(
  plan: IrOverlayPreparationPlan,
  selection: IrSelection,
  retainedUnitIds: ReadonlySet<IrUnitId>,
): IrSelection {
  const blockedAnyFunction = retainedUnitIds.size < plan.identityPlan.safeFunctionUnitIds.size;
  const retainedNames = irOverlayIdentity.retainIrSafeFunctionUnitIds(plan.identityPlan, retainedUnitIds);
  return applyIrFinalContextFunctionRetention(selection, retainedNames, blockedAnyFunction);
}

function selectedHostDateModuleInitUnitId(
  plan: IrOverlayPreparationPlan,
  selection: IrSelection,
): IrUnitId | undefined {
  if (selection.moduleInit?.reason !== null || selection.moduleInit.stmtCount === 0) return undefined;
  const moduleInit = plan.identityPlan.identitySelection.moduleInit;
  if (!moduleInit || moduleInit.reason !== null || moduleInit.stmtCount === 0) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "selected host-Date module init has no exact structural identity",
    );
  }
  return moduleInit.unitId;
}

/** Resolve host-Date target/provider gaps before integration emits an owner. */
export function prepareHostDateSnapshotPreflight(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPreparationPlan,
  selection: IrSelection,
): IrSelection {
  if (plan.hostDateImportsByOwnerUnitId.size === 0) return selection;
  const retainedModuleInitUnitId = selectedHostDateModuleInitUnitId(plan, selection);
  const activePlans = [...plan.hostDateImportsByOwnerUnitId.values()].filter(
    ({ ownerUnitId }) =>
      plan.identityPlan.safeFunctionUnitIds.has(ownerUnitId) || ownerUnitId === retainedModuleInitUnitId,
  );
  const supported =
    supportsIrBackendTargetCapability(
      projectIrBackendTargetProfile(ctx.targetProfile, { fast: ctx.fast }),
      "host-date-snapshot",
    ) || ctx.requiresStandaloneClockCapability === true;
  const retention = prepareHostDateSnapshotLoweringByIdentity(
    ctx,
    sourceFile,
    plan.hostDateImportsByOwnerUnitId,
    plan.identityPlan.safeFunctionUnitIds,
    retainedModuleInitUnitId,
    plan.identityPlan.identityContext,
    { supportsHostDateSnapshots: supported },
  );
  let retainedSelection = applyIrFinalContextFunctionUnitIds(plan, selection, retention.retainedFunctionUnitIds);
  if (retainedModuleInitUnitId !== undefined && retention.retainedModuleInitUnitId === undefined) {
    retainedSelection = { ...retainedSelection, moduleInit: undefined };
  }

  const finalModuleInitUnitId =
    retainedSelection.moduleInit?.reason === null && retainedSelection.moduleInit.stmtCount > 0
      ? retainedModuleInitUnitId
      : undefined;
  for (const { ownerUnitId, ownerName } of activePlans) {
    if (plan.identityPlan.safeFunctionUnitIds.has(ownerUnitId) || ownerUnitId === finalModuleInitUnitId) continue;
    recordIrOverlayPreparationFailure(plan, ownerName, {
      kind: "unsupported",
      code: "late-preparation-unsupported",
      stage: "resolve",
      detail: supported
        ? "the exact host Date provider ABI is unavailable in the final module context"
        : "host Date snapshots are unavailable for the selected backend target/provider",
    });
  }
  return retainedSelection;
}

/** Finish context-dependent preflight once declaration slots and Program ABI exist. */
export function finalizePreparedIrSelection(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  plan: IrOverlayPreparationPlan,
): Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit"> {
  let finalized = prepareIrCompilerTimerShimCallLowering(ctx, sourceFile, plan, plan.safeSelection);
  finalized = applyIrFinalContextFunctionUnitIds(
    plan,
    prepareIrAmbientClassCallLowering(ctx, plan, finalized),
    prepareHostVoidCallbackLoweringByIdentity(
      ctx,
      sourceFile,
      plan.hostVoidCallbacks,
      plan.identityPlan.safeFunctionUnitIds,
      plan.identityPlan.identityContext,
    ),
  );
  finalized = prepareHostDateSnapshotPreflight(ctx, sourceFile, plan, finalized);
  finalized = synchronizeIrSafeFunctionSelection(plan, finalized);
  return applyIrFinalContextFunctionUnitIds(
    plan,
    finalized,
    preparePromiseDelayLoweringByIdentity(
      ctx,
      sourceFile,
      plan.promiseDelays,
      plan.identityPlan.safeFunctionUnitIds,
      plan.identityPlan.identityContext,
      plan.preparationFailuresByUnitId,
    ),
  );
}
