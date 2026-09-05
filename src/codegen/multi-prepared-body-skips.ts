// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";
import { compileDeclarations } from "./audited-declarations.js";
import type { ModuleInitBodyCompileRouting, ModuleInitMode } from "./declarations.js";
import type { IrUnitId } from "../ir/identity.js";
import type { EarlyMultiPreparedScalarLeafState, MultiPreparedScalarLeafPlan } from "./multi-prepared-scalar-leaf.js";

/** Exact body skips contributed by a whole-program prepared component. */
export interface MultiPreparedAdditionalBodySkips {
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
  readonly skipBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly preserveBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly onSkippedNames?: (names: readonly string[]) => void;
  readonly onSkippedUnitIds?: (unitIds: readonly IrUnitId[]) => void;
  readonly moduleInitBodyRouting?: ModuleInitBodyCompileRouting;
}

function projectedUnitIds(
  state: EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan> | undefined,
  names: ReadonlySet<string> | undefined,
): ReadonlySet<IrUnitId> {
  if (!state?.route || !names) return new Set();
  return new Set(
    state.route.preparedFreeFunctions.requestedSkipProjection.entries
      .filter(({ legacyName }) => names.has(legacyName))
      .map(({ unitId }) => unitId),
  );
}

export function mergeMultiPreparedBodySkips(
  routeSkipBodies: ReadonlySet<string> | undefined,
  routePreserveBodies: ReadonlySet<string> | undefined,
  additional: MultiPreparedAdditionalBodySkips | undefined,
): { skipBodies: Set<string>; preserveBodies: Set<string> } {
  return {
    skipBodies: new Set([...(routeSkipBodies ?? []), ...(additional?.skipBodies ?? [])]),
    preserveBodies: new Set([...(routePreserveBodies ?? []), ...(additional?.preserveBodies ?? [])]),
  };
}

export function compileMultiPreparedScalarLeafDeclarations<Plan extends MultiPreparedScalarLeafPlan>(
  ctx: CodegenContext,
  sourceFile: import("typescript").SourceFile,
  state: EarlyMultiPreparedScalarLeafState<Plan> | undefined,
  moduleInitMode: ModuleInitMode,
  additional?: MultiPreparedAdditionalBodySkips,
): void {
  const { skipBodies, preserveBodies } = mergeMultiPreparedBodySkips(
    state?.route?.preparedFreeFunctions.skipBodies,
    state?.route?.preparedFreeFunctions.preserveBodies,
    additional,
  );
  const routeSkipBodyUnitIds = projectedUnitIds(state, state?.route?.preparedFreeFunctions.skipBodies);
  const routePreserveBodyUnitIds = projectedUnitIds(state, state?.route?.preparedFreeFunctions.preserveBodies);
  const skipBodyUnitIds = new Set([...routeSkipBodyUnitIds, ...(additional?.skipBodyUnitIds ?? [])]);
  const preserveSkippedBodyUnitIds = new Set([...routePreserveBodyUnitIds, ...(additional?.preserveBodyUnitIds ?? [])]);
  const skippedUnitIds: IrUnitId[] = [];
  const skippedNames = compileDeclarations(
    ctx,
    sourceFile,
    skipBodies.size > 0 ? skipBodies : undefined,
    preserveBodies.size > 0 ? preserveBodies : undefined,
    undefined,
    moduleInitMode,
    additional?.moduleInitBodyRouting,
    skipBodyUnitIds.size > 0
      ? {
          skipBodyUnitIds,
          preserveSkippedBodyUnitIds,
          skippedUnitIds,
        }
      : undefined,
  );
  additional?.onSkippedNames?.(skippedNames ?? []);
  additional?.onSkippedUnitIds?.(skippedUnitIds.filter((unitId) => additional.skipBodyUnitIds.has(unitId)));
  if (state?.route) {
    state.skippedFunctionUnitIds = new Set(skippedUnitIds.filter((unitId) => routeSkipBodyUnitIds.has(unitId)));
  }
}
