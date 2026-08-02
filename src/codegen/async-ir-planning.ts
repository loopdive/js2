// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isSingleAwaitReturnAsyncCandidate } from "../ir/async-prepare.js";
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
