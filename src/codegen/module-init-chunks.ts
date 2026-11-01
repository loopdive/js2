// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Codegen side of module-initializer chunking.  The planner itself (which
 * complete source entries share one helper, and the dispatch-tree shape) is
 * `src/shared/module-init-chunk-plan.ts`, shared with the IR lowering.  The
 * declaration emitter gives every planned group a fresh `FunctionContext`,
 * retaining `__module_init` as the compile-time context name while
 * materializing the group as an unexported `[] -> []` helper.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** Reserve a WAT-visible private helper name without claiming user spellings. */
export function reserveModuleInitChunkHelperName(ctx: CodegenContext, preferred: string): string {
  let name = preferred;
  let duplicate = 0;
  while (
    ctx.moduleInitChunkHelperNames.has(name) ||
    ctx.funcMap.has(name) ||
    ctx.mod.functions.some((func) => func.name === name) ||
    ctx.mod.imports.some((entry) => entry.desc.kind === "func" && entry.name === name)
  ) {
    name = `${preferred}_${++duplicate}`;
  }
  ctx.moduleInitChunkHelperNames.add(name);
  return name;
}

export function isModuleInitChunkFunctionContext(fctx: FunctionContext): boolean {
  return fctx.moduleInitChunk === true;
}

/**
 * (#6877) Is a declaration compiled in a chunk nested inside a FUNCTION (an IIFE
 * the chunk inlines, react.development.js's whole body)? Such a binding is the
 * function's hoisted local, never a module global — the bare-name
 * `moduleGlobals` entry may be another module's top-level `var`
 * (react.production.js's `assign`), or this module's own outer `var`.
 */
export function chunkDeclarationIsFunctionLocal(stmt: ts.Node): boolean {
  for (let node = stmt.parent; node !== undefined && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return true;
  }
  return false;
}
