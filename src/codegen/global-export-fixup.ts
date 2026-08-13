// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";

/** Keep exported global descriptors aligned when late imports shift defined globals. */
export function shiftModuleGlobalExportIndices(ctx: CodegenContext, threshold: number, delta: number): void {
  const shifted = new WeakSet<object>();
  for (const entry of ctx.mod.exports) {
    if (entry.desc.kind !== "global" || shifted.has(entry.desc) || entry.desc.index < threshold) continue;
    shifted.add(entry.desc);
    entry.desc.index += delta;
  }
}
