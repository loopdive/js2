// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import { reportErrorNoNode } from "./context/errors.js";
import type { CodegenContext } from "./context/types.js";
import { absoluteGlobalIdx } from "./global-space.js";
import { sourceModuleBindings } from "./module-binding-table.js";

/** Keep exported global descriptors aligned when late imports shift defined globals. */
export function shiftModuleGlobalExportIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  const shifted = new WeakSet<object>();
  for (const entry of ctx.mod.exports) {
    if (entry.desc.kind !== "global" || shifted.has(entry.desc) || entry.desc.index < threshold) continue;
    shifted.add(entry.desc);
    entry.desc.index += delta;
  }
}

/**
 * Export `entryFile`'s deferred `export default <variable>` (#1108) and default-expression snapshots. Runs after
 * every body compiled: a string-constant import added there shifts every defined-global index.
 */
export function exportDeferredDefaultGlobals(ctx: CodegenContext, entryFile: ts.SourceFile): void {
  const varName = ctx.deferredDefaultGlobalExport;
  if (varName) {
    // (#7470) The entry's own binding, which another module's same-named `__mod_` may precede. A name the entry
    // does not declare (`import { g } from "./dep"; export default g`) has no binding here, and keeps the first
    // `__mod_<name>`, as it always did.
    const global =
      sourceModuleBindings(ctx, entryFile).get(varName)?.value ??
      ctx.mod.globals.find((g) => g.name === `__mod_${varName}`);
    const index = global && absoluteGlobalIdx(ctx, global);
    const alreadyExported = ctx.mod.exports.some(
      (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
    );
    if (index !== undefined && !alreadyExported) {
      ctx.mod.exports.push({ name: "default", desc: { kind: "global", index } });
      ctx.mod.exports.push({ name: varName, desc: { kind: "global", index } });
    }
    ctx.deferredDefaultGlobalExport = undefined;
  }
  for (const value of ctx.deferredDefaultExpressionExports ?? []) {
    const index = absoluteGlobalIdx(ctx, value);
    if (index === undefined) {
      reportErrorNoNode(ctx, "Default-export snapshot lost its allocator identity");
      continue;
    }
    if (ctx.mod.exports.some((e) => e.name === "default")) {
      reportErrorNoNode(ctx, "Default-export snapshot conflicts with an existing default export");
      continue;
    }
    ctx.mod.exports.push({ name: "default", desc: { kind: "global", index } });
  }
  ctx.deferredDefaultExpressionExports?.clear();
}
