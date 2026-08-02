// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isSingleAwaitReturnAsyncCandidate } from "../ir/async-prepare.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrSelectionOptions } from "../ir/select.js";
import { asyncEngineWouldActivate } from "./async-activation.js";
import { analyzeAsyncBody } from "./async-cps.js";
import type { CodegenContext } from "./context/types.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";

type AsyncSelectionOptions = Pick<
  IrSelectionOptions,
  "supportsAsyncIr" | "asyncEngineClaims" | "asyncHasRealSuspension" | "canPrepareSuspendingAsync"
>;

/**
 * Freeze the canonical Promise-returning callable ABI before program-ABI
 * publication for the first top-level real-suspension owner. The direct async
 * engine already rewrites this exact population to `externref` while compiling
 * the body; doing it at declaration time lets sealed IR preparation own the
 * same source slot without changing nested or sync-pass-through declarations.
 */
export function prepareAsyncCallableAbi(
  ctx: CodegenContext,
  fn: ts.FunctionDeclaration,
  params: ValType[],
  fulfillmentResults: ValType[],
): [ValType[], ValType[]] {
  const usesPromiseAbi =
    ctx.programAbiSession !== undefined &&
    !ctx.wasi &&
    !ctx.standalone &&
    !fn.typeParameters?.length &&
    ts.isSourceFile(fn.parent) &&
    isSingleAwaitReturnAsyncCandidate(fn) &&
    asyncEngineWouldActivate(ctx, fn) &&
    params.every((param) => param.kind === "f64") &&
    fulfillmentResults.length === 1 &&
    fulfillmentResults[0]?.kind === "f64";
  return [params, usesPromiseAbi ? [{ kind: "externref" }] : fulfillmentResults];
}

/** Keep selector admission and the production async engine on one proof. */
export function prepareIrAsyncSelectionOptions(ctx: CodegenContext): AsyncSelectionOptions {
  return {
    supportsAsyncIr: ctx.supportsAsyncIr,
    asyncEngineClaims: (fn) => asyncEngineWouldActivate(ctx, fn),
    asyncHasRealSuspension: (fn) => {
      const plan = analyzeAsyncBody(ctx, fn);
      return plan.awaitPoints.some((awaited) => plan.awaitedStaticallyResolved.get(awaited) !== true);
    },
    // #4106: first genuinely-suspending IR producer. Host/WasmGC only — the
    // prepared runtime-provider catalogue has no standalone/WASI projection.
    canPrepareSuspendingAsync: (fn) => !ctx.wasi && !ctx.standalone && isSingleAwaitReturnAsyncCandidate(fn),
  };
}

/** Reconcile selector claims to the exact owners the post-build producer must split. */
export function collectPreparedIrAsyncOwners(
  ctx: CodegenContext,
  identityPlan: IrOverlayIdentityPlan,
  selectedFunctions: ReadonlySet<string>,
): ReadonlySet<IrUnitId> {
  const owners = new Set<IrUnitId>();
  if (ctx.wasi || ctx.standalone) return owners;
  for (const claim of identityPlan.functionClaims) {
    if (
      selectedFunctions.has(claim.legacyName) &&
      isSingleAwaitReturnAsyncCandidate(claim.declaration) &&
      asyncEngineWouldActivate(ctx, claim.declaration)
    ) {
      owners.add(claim.unitId);
    }
  }
  return owners;
}
