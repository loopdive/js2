// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt } from "../codegen/func-space.js";
import { emitInlineMathFunctions } from "../codegen/math-helpers.js";
import type { PreparedIrRuntimeManifest } from "./intrinsic-support.js";
import { IrInvariantError } from "./outcomes.js";

/** Resolve an exact already-materialized self-host Math provider definition. */
export function preparedMathProviderIndex(ctx: CodegenContext, symbol: string): number | undefined {
  const index = ctx.funcMap.get(symbol);
  if (index === undefined || index < ctx.numImportFuncs) return undefined;
  return definedFuncAt(ctx, index)?.name === symbol ? index : undefined;
}

/** Materialize only the self-host Math providers selected by a frozen manifest. */
export function materializePreparedMathProviders(ctx: CodegenContext, prepared: PreparedIrRuntimeManifest): void {
  const selfHosted = prepared.manifest.providers.flatMap((provider) =>
    provider.implementation.kind === "self-hosted" ? [{ id: provider.id, symbol: provider.implementation.symbol }] : [],
  );
  if (selfHosted.some((provider) => preparedMathProviderIndex(ctx, provider.symbol) === undefined)) {
    const methods = new Set(prepared.manifest.intrinsicUses.map((use) => use.id.slice("math.".length)));
    emitInlineMathFunctions(ctx, methods);
  }
  for (const provider of selfHosted) {
    if (preparedMathProviderIndex(ctx, provider.symbol) === undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `runtime manifest provider ${provider.id} did not materialize ${provider.symbol}`,
      );
    }
  }
}
