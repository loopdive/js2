// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import type { IrFunction } from "./core/nodes.js";
import { assertFinalAllocProvenance as assertVerifiedAllocProvenance } from "./analysis/alloc-verification.js";

export { verifyAllocProvenance, assertFinalAllocProvenance } from "./analysis/alloc-verification.js";
export type { AllocVerifyError } from "./analysis/alloc-verification.js";

/** True iff the env/debug flag enables the alloc-provenance walk. */
export function allocVerifyEnabled(): boolean {
  return process.env.IR_VERIFY_ALLOC === "1" || process.env.IR_VERIFY_ALLOC === "true";
}

/**
 * Throwing wrapper for intermediate integration verify boundaries. No-op
 * unless the debug flag is on, so production does not repeat the walk after
 * every pass.
 */
export function assertAllocProvenance(func: IrFunction, registry: AllocSiteRegistry): void {
  if (!allocVerifyEnabled()) return;
  assertVerifiedAllocProvenance(func, registry);
}
