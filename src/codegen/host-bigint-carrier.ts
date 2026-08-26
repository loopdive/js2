// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Select the arbitrary-width JS BigInt carrier only for host-assisted semantics. */
import type { CodegenContext } from "./context/types.js";

export function usesHostBigIntCarrier(ctx: Pick<CodegenContext, "targetProfile">): boolean {
  return ctx.targetProfile.environment === "javascript" && ctx.targetProfile.semanticProviders === "host-assisted";
}
