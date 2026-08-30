// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { planCompilerSupportCallableAbi } from "./compiler-support-abi.js";
import type { CodegenContext } from "./context/types.js";
import { eliminateDeadImports } from "./dead-elimination.js";
import { planProgramAbiCallableImports } from "./program-abi-import-planning.js";
import { observeStructFieldAccessorAbi } from "./struct-field-accessor-abi.js";

/**
 * Settle allocator layout, then publish every retained Program ABI population.
 *
 * Ordering is intentional: DCE establishes final function/type layouts;
 * imported callables and semantic providers claim their exact objects first;
 * retained class bodies/helpers recover their exact source/class owners before
 * generic callable population; total callable/global owners then exist before
 * exports alias them; type cells publish last from the same compacted layout.
 *
 * (#3520 C34) The per-field host accessor family is observed here, after DCE
 * has settled the layout and before the generic `retained-module-function`
 * fallback runs — so an accessor the module no longer contains is simply absent
 * rather than claiming a slot that is gone.
 *
 * (#3520 C35) The remaining compiler-support families (closure argc wrappers,
 * async frame machinery, vec-from-extern materializers, self-hosted Math
 * helpers) plan at the same seam but LAST, after every semantic registry has
 * claimed what it owns — so "already owned" is exactly decided and a helper an
 * intrinsic provider owns is never re-claimed.
 */
export function eliminateDeadLayoutAndPlanProgramAbi(ctx: CodegenContext): void {
  eliminateDeadImports(ctx.mod, ctx);
  planProgramAbiCallableImports(ctx);
  observeStructFieldAccessorAbi(ctx);
  ctx.programAbiCallableProviders?.planRetained();
  ctx.programAbiClassCallables?.planRetained();
  ctx.programAbiModuleInitCallables?.planRetained();
  ctx.programAbiSourceCallables?.planRetained();
  planCompilerSupportCallableAbi(ctx);
  ctx.programAbiCallables?.planRetained();
  ctx.programAbiGlobals?.planRetained();
  ctx.programAbiExports?.planRetained();
  // Export/start/_start adapters exist only now, so the graph-global module-init
  // pass reconciles its selected invocation policy here rather than inside its
  // own planRetained.
  ctx.programAbiModuleInitCallables?.assertGraphGlobalInvocationPolicy();
  ctx.programAbiTypes?.planRetained();
}
