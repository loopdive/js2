// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteRegistry } from "./alloc-registry.js";
import type { IrFunction } from "./nodes.js";
import { constantFold } from "./passes/constant-fold.js";
import { gvnFromEnv, recordLegacyGvnCountersOnce } from "./passes/gvn.js";
import { createGvnCounters } from "./passes/gvn-core.js";
import { deadCode } from "./passes/dead-code.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import type { PreparedIrProgramProducerInput } from "./program.js";
import {
  optimizePreparedIrProgramIr,
  type IrPreparationControls,
  type IrProgramOptimizationResult,
} from "./program-middleend-ir.js";

/** The existing hygiene round, shared by historical and whole-program integration. */
export function runHygienePasses(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  let current = fn;
  for (let iteration = 0; iteration < 10; iteration++) {
    const next = simplifyCFG(deadCode(gvnFromEnv(constantFold(current, registry)), registry));
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Resolve legacy environment switches once, before entering typed preparation. */
export function resolveIrPreparationControlsFromEnv(): IrPreparationControls {
  const mode = process.env.JS2WASM_IR_GVN;
  return Object.freeze({
    gvnMode: mode === "poison" ? "poison" : mode === "1" || mode === "true" ? "on" : "off",
    ownership: process.env.JS2WASM_IR_OWNERSHIP === "1" || process.env.JS2WASM_IR_OWNERSHIP === "true",
    escape: process.env.JS2WASM_IR_ESCAPE === "1" || process.env.JS2WASM_IR_ESCAPE === "true",
    verifyIntermediateAllocations: process.env.IR_VERIFY_ALLOC === "1" || process.env.IR_VERIFY_ALLOC === "true",
    verifyDominanceNaive: process.env.JS2WASM_IR_VERIFY_DOMINANCE_NAIVE === "1",
  });
}

export function optimizePreparedIrProgram(
  input: PreparedIrProgramProducerInput,
  allocations: AllocSiteRegistry,
): IrProgramOptimizationResult {
  const controls = resolveIrPreparationControlsFromEnv();
  const counters = createGvnCounters();
  try {
    return optimizePreparedIrProgramIr(input, allocations, controls, counters);
  } finally {
    recordLegacyGvnCountersOnce(counters);
  }
}
