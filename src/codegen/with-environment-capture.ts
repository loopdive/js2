// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Codegen adapter for the backend-neutral `with` environment capture plan. */
import { planWithEnvironmentCaptures } from "../ir/with-environment.js";
import type { FunctionContext } from "./context/types.js";

/** Merge hidden environment receivers with any direct-eval-forced captures. */
export function planAdditionalWithEnvironmentCaptureNames(
  fctx: FunctionContext,
  includeBoxedCaptures: boolean,
): ReadonlySet<string> | undefined {
  const names = new Set<string>();
  if (includeBoxedCaptures) {
    for (const name of fctx.boxedCaptures?.keys() ?? []) names.add(name);
  }
  const plan = planWithEnvironmentCaptures(fctx.withScopes?.map((scope) => scope.captureName) ?? []);
  for (const capture of plan) names.add(capture.bindingName);
  return names.size > 0 ? names : undefined;
}

/** Add hidden environment receivers, then snapshot the callback worklist. */
export function addWithEnvironmentCaptureNames(names: Set<string>, fctx: FunctionContext): Set<string> {
  const plan = planWithEnvironmentCaptures(fctx.withScopes?.map((scope) => scope.captureName) ?? []);
  for (const capture of plan) names.add(capture.bindingName);
  return new Set(names);
}

/**
 * Recreate the ordered Object Environment Record chain in a lifted body.
 * Function-local bindings are added to each blocked set because the new
 * declarative environment precedes the captured outer object environments.
 */
export function rehydrateWithEnvironmentScopes(
  outerFctx: FunctionContext,
  liftedFctx: FunctionContext,
  ownerName: string,
  ownBindings: ReadonlySet<string>,
): void {
  if (!outerFctx.withScopes?.length) return;
  liftedFctx.withScopes = outerFctx.withScopes.map((scope) => {
    const localIdx = liftedFctx.localMap.get(scope.captureName);
    if (localIdx === undefined) {
      throw new Error(`with-environment capture ${scope.captureName} was not materialized in ${ownerName}`);
    }
    return { ...scope, localIdx, blockedNames: new Set([...scope.blockedNames, ...ownBindings]) };
  });
}
