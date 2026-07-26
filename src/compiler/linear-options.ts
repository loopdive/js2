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
  };
}
