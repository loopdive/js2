// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2137 — query IR-path fallbacks through the structured `irPostClaimErrors`
 * channel on `CompileResult`, instead of string-matching the diagnostics array
 * for `e.message.startsWith("IR path failed")` / `"IR path: could not resolve"`.
 *
 * `irPostClaimErrors` carries every function the IR selector CLAIMED that then
 * fell back to legacy — both pre-claim type-resolution failures (kind
 * `"resolve"`) and post-claim build/verify/lower/backend-legality failures
 * (kind `"build" | "verify" | "lower"`). An empty array means the IR path
 * fully handled every claimed function — the invariant the #1169* bridge
 * tests assert.
 */
import type { CompileResult } from "../../src/index.js";

/** The IR-path fallbacks recorded for a compile, or `[]` when there were none. */
export function irFallbacks(r: CompileResult): NonNullable<CompileResult["irPostClaimErrors"]> {
  return r.irPostClaimErrors ?? [];
}
