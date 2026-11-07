// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irBackendCapabilityQuery } from "../ir/backend/legality.js";
import type { IrHostVoidCallbackLoweringPlan, IrImportedCallLoweringPlan } from "../ir/ast-lowering-plans.js";
import type { IrUnitId } from "../ir/identity.js";
import { IrInvariantError, type IrPreparationFailure } from "../ir/outcomes.js";
import type { IrPromiseDelayLoweringPlans } from "../ir/promise-delay-lowering.js";
import type { IrRuntimeEvalSite } from "../ir/runtime-eval-boundary-plan.js";
import type { IrSelection } from "../ir/select.js";
import { forEachChild, ts } from "../ts-api.js";
import { isBindingReferencePosition } from "../checker/binder.js";
import type { CodegenContext } from "./context/types.js";
import { prepareIrAmbientClassCallLowering, recordIrOverlayPreparationFailure } from "./ir-imported-call-planning.js";
import { prepareIrCompilerTimerShimCallLowering } from "./ir-timer-shim-planning.js";
import * as irOverlayIdentity from "./ir-overlay-identity.js";
import { runtimeEvalPushPublishesCachedFunctionValues } from "./expressions/runtime-eval-provider.js";
import {
  applyIrFinalContextFunctionRetention,
  closeIrBlockedComponentByIdentity,
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

/**
 * (#7106 A1) Withdraw each safe function that crosses a runtime-eval boundary;
 * the rest stay prepared. Each withdrawal records its reason:
 *
 *  - `eval-site`: the declaration contains an inventoried site. A direct eval
 *    reads and writes its caller's activation, which only the direct frontend
 *    models.
 *  - `eval-visible-binding`: the body references a script binding evaluated
 *    code may replace: a live function (`ctx.liveFuncBindingGlobals`), or a
 *    global `var`/lexical binding, whose storage `registerReassignedFunctionGlobals`
 *    widened to externref. IR binds functions statically and types variables
 *    itself, so it would miss the rebind or disagree with the slot.
 *  - `uncached-push`: the push publishes a per-site closure that cannot be
 *    planned before the component seals, so every function stays direct.
 *
 * Site spans ignore `sourceId`, so that test over-approximates; it can only
 * keep a function direct, never admit one. Selection's call-graph closure has
 * already run, so the withdrawn functions re-close it here (`boundary-closure`):
 * a claimed caller or callee of a direct function would otherwise reach build
 * with no exact call-site plan.
 */
export function withdrawEvalBoundaryFunctions(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  identityPlan: irOverlayIdentity.IrOverlayIdentityPlan,
  funcs: Set<string>,
  record: (legacyName: string, failure: IrPreparationFailure) => void,
): void {
  const sites = ctx.runtimeEvalBoundaryPlan?.sites ?? [];
  const evalVisible = new Set([
    ...(ctx.liveFuncBindingGlobals ?? []),
    ...(ctx.globalObjectVarBindings ?? []),
    ...(ctx.globalLexicalBindings ?? []),
  ]);
  const wholeProgram = !runtimeEvalPushPublishesCachedFunctionValues(ctx);
  const reasons = new Map<IrUnitId, string>();
  for (const name of funcs) {
    const why = wholeProgram
      ? "uncached-push"
      : runtimeEvalBoundaryCrossing(ctx, sites, identityPlan.declarationByLegacyName.get(name)!, evalVisible);
    if (why !== undefined) reasons.set(irOverlayIdentity.requireIrOverlayFunctionUnitId(identityPlan, name), why);
  }
  if (reasons.size === 0) return;
  const blocked = new Set(reasons.keys());
  const retained = closeIrBlockedComponentByIdentity(
    sourceFile,
    identityPlan.identityContext,
    identityPlan.safeFunctionUnitIds,
    blocked,
  );
  for (const name of [...funcs]) {
    const unitId = irOverlayIdentity.requireIrOverlayFunctionUnitId(identityPlan, name);
    if (retained.has(unitId)) continue;
    record(name, runtimeEvalBoundaryFailure(reasons.get(unitId) ?? "boundary-closure"));
    funcs.delete(name);
    irOverlayIdentity.dropIrSafeFunctionByLegacyName(identityPlan, name);
  }
}

/** (#2928) Why an owner of a runtime-eval program stays direct; `why` is the per-function reason. */
/**
 * (#7106 A2b) Module init owns every top-level statement except function
 * declarations (their own units), so it holds an eval site when one lies in
 * such a statement — including a nested function expression there. A module
 * init without one only reads the slots the pull rewrites.
 */
export function moduleInitHoldsEvalSite(sourceFile: ts.SourceFile, sites: readonly IrRuntimeEvalSite[]): boolean {
  return sourceFile.statements.some(
    (statement) =>
      !ts.isFunctionDeclaration(statement) &&
      sites.some((site) => site.start >= statement.getStart() && site.end <= statement.end),
  );
}

export function runtimeEvalBoundaryFailure(why?: string): IrPreparationFailure {
  const detail = "the linked runtime-eval callable carrier is still owned by the direct frontend";
  return {
    kind: "unsupported",
    code: "late-preparation-unsupported",
    stage: "resolve",
    detail: why === undefined ? detail : `${detail} (${why})`,
  };
}

function runtimeEvalBoundaryCrossing(
  ctx: CodegenContext,
  sites: readonly IrRuntimeEvalSite[],
  declaration: ts.FunctionDeclaration,
  evalVisible: ReadonlySet<string>,
): "eval-site" | "eval-visible-binding" | undefined {
  const start = declaration.getStart();
  if (sites.some((site) => site.start >= start && site.end <= declaration.end)) return "eval-site";
  // A reference resolving outside this declaration (or nowhere) reaches the
  // script binding. So does one resolving to the declaration itself: its name
  // is bound in the script scope, so a recursive call reads the binding eval
  // may replace.
  const reachesScriptBinding = (id: ts.Identifier): boolean => {
    const target = ctx.oracle.valueDeclarationOf(id);
    if (target === undefined || target === declaration) return true;
    if (target.getSourceFile() !== declaration.getSourceFile()) return true;
    return target.pos < declaration.pos || target.end > declaration.end;
  };
  let crosses = false;
  const visit = (node: ts.Node): void => {
    if (crosses) return;
    if (ts.isIdentifier(node) && evalVisible.has(node.text) && isBindingReferencePosition(node)) {
      crosses = reachesScriptBinding(node);
    } else forEachChild(node, visit);
  };
  if (evalVisible.size !== 0) forEachChild(declaration, visit);
  return crosses ? "eval-visible-binding" : undefined;
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
    irBackendCapabilityQuery(ctx)("host-date-snapshot") || ctx.requiresStandaloneClockCapability === true;
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
