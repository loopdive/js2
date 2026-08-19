// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { LinearOptions } from "../codegen-linear/index.js";
import type { CompileOptions } from "../index.js";
import type { IrInventoryOptions } from "./ir-outcome-inventory.js";

export function buildLinearOptions(
  options: CompileOptions,
  irInventoryOptions: IrInventoryOptions | undefined,
): LinearOptions {
  return {
    exposeArenaReset: options.allocator === "arena-reset",
    allocationPolicy: options.allocator === "analysis-stack" ? "analysis-stack-arena-v1" : "arena-v1",
    irInventoryOptions,
    // #4539 — link topology. Both are undefined for every existing caller, so
    // the emitted binary is unchanged unless a link is explicitly requested.
    externImports: options.linearExternImports,
    importMemory: options.linearImportMemory,
    // #4540 — heap ownership in linked mode. Undefined unless a link is
    // requested, so standalone emission is untouched.
    linkedHeap: options.linearLinkedHeap,
    // #4557 — own allocator. Undefined for every existing caller, so the bump
    // arena and its emitted bytes are untouched unless it is asked for.
    heapAllocator: options.linearHeapAllocator,
  };
}
