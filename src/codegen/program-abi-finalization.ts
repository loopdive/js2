// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";
import { eliminateDeadImports } from "./dead-elimination.js";
import { planProgramAbiCallableImports } from "./program-abi-import-planning.js";

/**
 * Settle allocator layout, then publish every retained Program ABI population.
 *
 * Ordering is intentional: DCE establishes final function/type layouts;
 * imported callables and semantic providers claim their exact objects first;
 * retained class bodies/helpers recover their exact source/class owners before
 * generic callable population; total callable/global owners then exist before
 * exports alias them; type cells publish last from the same compacted layout.
 */
export function eliminateDeadLayoutAndPlanProgramAbi(ctx: CodegenContext): void {
  eliminateDeadImports(ctx.mod, ctx);
  planProgramAbiCallableImports(ctx);
  ctx.programAbiCallableProviders?.planRetained();
  ctx.programAbiClassCallables?.planRetained();
  ctx.programAbiModuleInitCallables?.planRetained();
  ctx.programAbiSourceCallables?.planRetained();
  ctx.programAbiCallables?.planRetained();
  ctx.programAbiGlobals?.planRetained();
  ctx.programAbiExports?.planRetained();
  ctx.programAbiTypes?.planRetained();
}
