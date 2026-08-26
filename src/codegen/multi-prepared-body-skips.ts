// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";
import { compileDeclarations } from "./audited-declarations.js";
import type { ModuleInitMode } from "./declarations.js";
import { correlateIrSkippedFunctionNames } from "./ir-overlay-safety.js";
import type { EarlyMultiPreparedScalarLeafState, MultiPreparedScalarLeafPlan } from "./multi-prepared-scalar-leaf.js";

/** Name-keyed body skips contributed by a whole-program prepared component. */
export interface MultiPreparedAdditionalBodySkips {
  readonly skipBodies: ReadonlySet<string>;
  readonly preserveBodies: ReadonlySet<string>;
  readonly onSkippedNames?: (names: readonly string[]) => void;
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
  const skippedNames = compileDeclarations(
    ctx,
    sourceFile,
    skipBodies.size > 0 ? skipBodies : undefined,
    preserveBodies.size > 0 ? preserveBodies : undefined,
    undefined,
    moduleInitMode,
  );
  additional?.onSkippedNames?.(skippedNames ?? []);
  if (state?.route) {
    state.skippedFunctionUnitIds = correlateIrSkippedFunctionNames(
      state.route.preparedFreeFunctions.requestedSkipProjection,
      skippedNames ?? [],
    ).unitIds;
  }
}
