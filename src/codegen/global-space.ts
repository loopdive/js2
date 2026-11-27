// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The defined-global twin of `func-space.ts`: a late import global shifts every defined global, so code
 * that must outlive such a shift holds the allocator-owned `GlobalDef` and asks for its index when it emits. A leaf,
 * so modules kept outside the import SCC can use it.
 */
import type { GlobalDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** The current absolute index of `global`, or `undefined` when it is no longer in the module. */
export function absoluteGlobalIdx(ctx: CodegenContext, global: GlobalDef): number | undefined {
  const local = ctx.mod.globals.indexOf(global);
  return local < 0 ? undefined : ctx.numImportGlobals + local;
}

/** The defined global at absolute index `absIdx`, or `undefined` for an import or an index past the module. */
export function definedGlobalAt(ctx: CodegenContext, absIdx: number): GlobalDef | undefined {
  return ctx.mod.globals[absIdx - ctx.numImportGlobals];
}
